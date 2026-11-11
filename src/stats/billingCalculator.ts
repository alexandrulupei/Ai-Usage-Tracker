import { CopilotPlan, ClaudeCostBasis } from '../config';
import { TrackerDatabase } from '../db/database';
import { estimateSessionCaching } from './cacheEstimator';

// =============================================================================
// SOURCES (verified May 2026)
//   Per-token pricing (effective June 1, 2026):
//     https://docs.github.com/en/copilot/reference/copilot-billing/models-and-pricing
//   AI credit allowances (individuals):
//     https://docs.github.com/en/copilot/concepts/billing/usage-based-billing-for-individuals
//   AI credit allowances + promotional period (org/enterprise):
//     https://docs.github.com/en/copilot/concepts/billing/usage-based-billing-for-organizations-and-enterprises
//
// Billing change date: June 1, 2026 (request-based -> usage-based / AI Credits).
// The extension reports usage-based billing only; the old premium-request view was
// removed. Chat requests and sessions are shown as activity, not billing.
// Promotional period for Business / Enterprise: Jun 1 - Sep 1, 2026
// =============================================================================

const BILLING_CHANGE_MS = Date.UTC(2026, 5, 1);     // 2026-06-01 00:00 UTC
const PROMO_END_MS      = Date.UTC(2026, 8, 1);     // 2026-09-01 00:00 UTC

// Bump either version to make the next sync recompute every stored session's cost.
export const PRICING_TABLE_VERSION = 20261111;
// v3: billed amount (directCredits) preferred over list prices; long-context tiers.
export const COST_FORMULA_VERSION = 3;

// ---- AI-credit allowances (per-license; pooled at billing entity for B/E) -
const PLAN_AI_CREDITS_STANDARD: Record<CopilotPlan, number | null> = {
  free: null,        // not officially published; surface as "estimate"
  pro: 1500,
  'pro+': 7000,
  business: 1900,
  enterprise: 3900,
};

const PLAN_AI_CREDITS_PROMO: Partial<Record<CopilotPlan, number>> = {
  business: 3000,
  enterprise: 7000,
};

// =============================================================================
// MODEL TABLE
// One canonical entry per model. `aliases` are matched case-insensitively against
// the normalized model id from the log; longest alias wins, and a match must end
// on a version boundary (see resolveModel) so an unknown newer version is never
// silently priced as an older one.
//
// SOURCES (verified 2026-11-11):
//  - Per-token prices: GitHub Copilot's own model list (`billing.token_prices` in
//    the models.json snapshot Copilot writes next to every debug log, latest
//    2026-11-09; units = AI credits per 1M tokens, /100 = USD), cross-checked
//    against https://docs.github.com/en/copilot/reference/copilot-billing/models-and-pricing
//    (identical for every model both list). Rows marked [docs] appear only on
//    the docs page; rows marked [models.json] only in the model list.
//  - Anthropic first-party API prices (used for Claude Code sessions) are the same
//    numbers: platform.claude.com pricing — cache write 1.25x (5m) / 2x (1h) input;
//    cache read 0.1x input, 0.05x on Opus 5.5 / Sonnet 5.5, 0.025x on Fable 5.1 / 5.2.
//
// IMPORTANT: these are LIST prices. Real Copilot bills also depend on the Auto
// model discount (10%), the long-context tier, time-limited promotions and price
// changes over time. Every Copilot call in current logs carries the exact billed
// amount (copilotUsageNanoAiu), which computeCostUSD prefers; this table is the
// fallback and the source for Claude Code (which logs no billed amount).
// =============================================================================

/** Rates (USD per 1M tokens) for one pricing tier. */
interface PriceTier {
  input: number;                 // uncached input
  cachedInput: number;           // cache read
  cacheWrite?: number;           // cache write, 5-min TTL (omitted = billed at input rate)
  cacheWrite1h?: number;         // cache write, 1-hour TTL (Anthropic = 2x input)
  output: number;
}

interface ModelEntry extends PriceTier {
  id: string;                    // canonical id
  /** Prompts with MORE than `above` input tokens are billed entirely at these rates. */
  longContext?: PriceTier & { above: number };
  aliases: string[];
}

const MODEL_TABLE: ModelEntry[] = [
  // ---- Anthropic ----
  { id: 'claude-haiku-4.5', input: 1.00, cachedInput: 0.10, cacheWrite: 1.25, cacheWrite1h: 2.00, output: 5.00, aliases: ['claude-haiku-4.5', 'haiku-4.5'] },
  { id: 'claude-haiku-5.5', input: 0.10, cachedInput: 0.01, cacheWrite: 0.125, cacheWrite1h: 0.20, output: 0.50,
    longContext: { above: 100_000, input: 0.50, cachedInput: 0.05, cacheWrite: 0.625, cacheWrite1h: 1.00, output: 2.50 }, aliases: ['claude-haiku-5.5', 'haiku-5.5'] },
  { id: 'claude-sonnet-4', input: 3.00, cachedInput: 0.30, cacheWrite: 3.75, cacheWrite1h: 6.00, output: 15.00, aliases: ['claude-sonnet-4', 'sonnet-4'] },
  { id: 'claude-sonnet-4.5', input: 3.00, cachedInput: 0.30, cacheWrite: 3.75, cacheWrite1h: 6.00, output: 15.00, aliases: ['claude-sonnet-4.5', 'sonnet-4.5'] },
  { id: 'claude-sonnet-4.6', input: 3.00, cachedInput: 0.30, cacheWrite: 3.75, cacheWrite1h: 6.00, output: 15.00, aliases: ['claude-sonnet-4.6', 'sonnet-4.6'] },
  { id: 'claude-sonnet-5', input: 2.00, cachedInput: 0.20, cacheWrite: 2.50, cacheWrite1h: 4.00, output: 10.00, aliases: ['claude-sonnet-5', 'sonnet-5'] },
  { id: 'claude-sonnet-5.5', input: 2.00, cachedInput: 0.10, cacheWrite: 2.50, cacheWrite1h: 4.00, output: 10.00, aliases: ['claude-sonnet-5.5', 'sonnet-5.5'] },
  { id: 'claude-opus-4.5', input: 5.00, cachedInput: 0.50, cacheWrite: 6.25, cacheWrite1h: 10.00, output: 25.00, aliases: ['claude-opus-4.5', 'opus-4.5'] },
  { id: 'claude-opus-4.6', input: 5.00, cachedInput: 0.50, cacheWrite: 6.25, cacheWrite1h: 10.00, output: 25.00, aliases: ['claude-opus-4.6', 'opus-4.6'] },
  // Retired fast-mode preview (no longer listed); kept at its last published price for history.
  { id: 'claude-opus-4.6-fast', input: 30.00, cachedInput: 3.00, cacheWrite: 37.50, cacheWrite1h: 60.00, output: 150.00, aliases: ['claude-opus-4.6-fast', 'opus-4.6-fast'] },
  { id: 'claude-opus-4.7', input: 5.00, cachedInput: 0.50, cacheWrite: 6.25, cacheWrite1h: 10.00, output: 25.00, aliases: ['claude-opus-4.7', 'opus-4.7'] },
  { id: 'claude-opus-4.8', input: 5.00, cachedInput: 0.50, cacheWrite: 6.25, cacheWrite1h: 10.00, output: 25.00, aliases: ['claude-opus-4.8', 'opus-4.8'] },
  { id: 'claude-opus-4.8-fast', input: 10.00, cachedInput: 1.00, cacheWrite: 12.50, cacheWrite1h: 20.00, output: 50.00, aliases: ['claude-opus-4.8-fast', 'opus-4.8-fast'] },
  { id: 'claude-opus-5', input: 5.00, cachedInput: 0.50, cacheWrite: 6.25, cacheWrite1h: 10.00, output: 25.00, aliases: ['claude-opus-5', 'opus-5'] },
  { id: 'claude-opus-5.5', input: 4.00, cachedInput: 0.20, cacheWrite: 5.00, cacheWrite1h: 8.00, output: 20.00, aliases: ['claude-opus-5.5', 'opus-5.5'] },
  { id: 'claude-fable-5', input: 10.00, cachedInput: 1.00, cacheWrite: 12.50, cacheWrite1h: 20.00, output: 50.00, aliases: ['claude-fable-5', 'fable-5', 'claude-mythos-5'] },
  { id: 'claude-fable-5.1', input: 10.00, cachedInput: 0.25, cacheWrite: 12.50, cacheWrite1h: 20.00, output: 50.00, aliases: ['claude-fable-5.1', 'fable-5.1', 'claude-mythos-5.1'] },
  // [docs] 1h write = 2x input per Anthropic's published cache pricing.
  { id: 'claude-fable-5.2', input: 8.00, cachedInput: 0.20, cacheWrite: 10.00, cacheWrite1h: 16.00, output: 40.00, aliases: ['claude-fable-5.2', 'fable-5.2', 'claude-mythos-5.2'] },

  // ---- OpenAI ----
  // GPT-4.1 / GPT-4o / GPT-4o mini are included models: priced 0 in Copilot's model
  // list and billed 0 in real logs.
  { id: 'gpt-4.1', input: 0, cachedInput: 0, output: 0, aliases: ['gpt-4.1'] },
  { id: 'gpt-4o', input: 0, cachedInput: 0, output: 0, aliases: ['gpt-4o'] },
  { id: 'gpt-4o-mini', input: 0, cachedInput: 0, output: 0, aliases: ['gpt-4o-mini'] },
  { id: 'gpt-5-mini', input: 0.25, cachedInput: 0.025, output: 2.00, aliases: ['gpt-5-mini'] },
  { id: 'gpt-5.2', input: 1.75, cachedInput: 0.175, output: 14.00, aliases: ['gpt-5.2'] },
  { id: 'gpt-5.2-codex', input: 1.75, cachedInput: 0.175, output: 14.00, aliases: ['gpt-5.2-codex'] },
  { id: 'gpt-5.3-codex', input: 1.75, cachedInput: 0.175, output: 14.00, aliases: ['gpt-5.3-codex'] },
  { id: 'gpt-5.4', input: 2.50, cachedInput: 0.25, output: 15.00,
    longContext: { above: 272_000, input: 5.00, cachedInput: 0.50, output: 22.50 }, aliases: ['gpt-5.4'] },
  { id: 'gpt-5.4-mini', input: 0.75, cachedInput: 0.075, output: 4.50, aliases: ['gpt-5.4-mini'] },
  // Docs price; Copilot's internal (title/aux) gpt-5.4-nano calls are billed 0 — the
  // measured amount covers those.
  { id: 'gpt-5.4-nano', input: 0.20, cachedInput: 0.02, output: 1.25, aliases: ['gpt-5.4-nano'] },
  { id: 'gpt-5.5', input: 5.00, cachedInput: 0.50, output: 30.00,
    longContext: { above: 272_000, input: 10.00, cachedInput: 1.00, output: 45.00 }, aliases: ['gpt-5.5'] },
  { id: 'gpt-5.6-luna', input: 0.20, cachedInput: 0.02, cacheWrite: 0.25, output: 1.20,
    longContext: { above: 200_000, input: 0.40, cachedInput: 0.04, cacheWrite: 0.50, output: 1.80 }, aliases: ['gpt-5.6-luna'] },
  { id: 'gpt-5.6-terra', input: 2.00, cachedInput: 0.20, cacheWrite: 2.50, output: 12.00,
    longContext: { above: 272_000, input: 4.00, cachedInput: 0.40, cacheWrite: 5.00, output: 18.00 }, aliases: ['gpt-5.6-terra'] },
  { id: 'gpt-5.6-sol', input: 4.00, cachedInput: 0.40, cacheWrite: 5.00, output: 20.00,
    longContext: { above: 272_000, input: 8.00, cachedInput: 0.80, cacheWrite: 10.00, output: 30.00 }, aliases: ['gpt-5.6-sol'] },
  { id: 'gpt-6-luna', input: 0.10, cachedInput: 0.01, cacheWrite: 0.125, output: 0.50,
    longContext: { above: 272_000, input: 0.20, cachedInput: 0.02, cacheWrite: 0.25, output: 0.75 }, aliases: ['gpt-6-luna'] },
  // [docs]
  { id: 'gpt-6-sol', input: 2.00, cachedInput: 0.20, cacheWrite: 2.50, output: 10.00,
    longContext: { above: 272_000, input: 4.00, cachedInput: 0.40, cacheWrite: 5.00, output: 15.00 }, aliases: ['gpt-6-sol'] },
  { id: 'gpt-6-astra', input: 10.00, cachedInput: 1.00, cacheWrite: 12.50, output: 50.00,
    longContext: { above: 272_000, input: 20.00, cachedInput: 2.00, cacheWrite: 25.00, output: 75.00 }, aliases: ['gpt-6-astra'] },
  { id: 'gpt-6.1-sol', input: 2.00, cachedInput: 0.10, cacheWrite: 2.50, output: 10.00,
    longContext: { above: 272_000, input: 4.00, cachedInput: 0.20, cacheWrite: 5.00, output: 15.00 }, aliases: ['gpt-6.1-sol'] },
  // [docs]
  { id: 'gpt-6.1-terra', input: 1.00, cachedInput: 0.05, cacheWrite: 1.25, output: 5.00,
    longContext: { above: 272_000, input: 2.00, cachedInput: 0.10, cacheWrite: 2.50, output: 7.50 }, aliases: ['gpt-6.1-terra'] },

  // ---- Google (no cache-write price; no long-context tier unless listed) ----
  { id: 'gemini-2.5-pro', input: 1.25, cachedInput: 0.125, output: 10.00, aliases: ['gemini-2.5-pro'] },
  { id: 'gemini-3-flash', input: 0.50, cachedInput: 0.05, output: 3.00, aliases: ['gemini-3-flash'] },
  { id: 'gemini-3.1-pro', input: 2.00, cachedInput: 0.20, output: 12.00,
    longContext: { above: 200_000, input: 4.00, cachedInput: 0.40, output: 18.00 }, aliases: ['gemini-3.1-pro'] },
  // [models.json]
  { id: 'gemini-3.5-flash', input: 1.50, cachedInput: 0.15, output: 9.00, aliases: ['gemini-3.5-flash'] },
  // [models.json] Priced 1.50/7.50 until 2026-08-26, then halved; current price shown.
  { id: 'gemini-3.6-flash', input: 0.75, cachedInput: 0.075, output: 3.75, aliases: ['gemini-3.6-flash'] },
  { id: 'gemini-3.7-flash', input: 0.75, cachedInput: 0.075, output: 3.75, aliases: ['gemini-3.7-flash'] },
  // Promotional price through 2026-12-31 (docs).
  { id: 'gemini-3.8-flash', input: 0.75, cachedInput: 0.075, output: 3.75, aliases: ['gemini-3.8-flash'] },
  // Promotional price until 2026-12-01 (docs).
  { id: 'gemini-4-argon', input: 2.00, cachedInput: 0.10, output: 10.00, aliases: ['gemini-4-argon'] },
  // [docs] Promotional price until 2026-12-01; afterwards 4.00 / 0.20 / 20.00.
  { id: 'gemini-4-carbon', input: 2.00, cachedInput: 0.10, output: 10.00, aliases: ['gemini-4-carbon'] },

  // ---- xAI ----
  { id: 'grok-code-fast-1', input: 0.20, cachedInput: 0.02, output: 1.50, aliases: ['grok-code-fast-1', 'grok-code-fast'] },
  { id: 'grok-4.5', input: 2.00, cachedInput: 0.50, output: 6.00,
    longContext: { above: 200_000, input: 4.00, cachedInput: 1.00, output: 12.00 }, aliases: ['grok-4.5'] },
  { id: 'grok-4.6', input: 2.00, cachedInput: 0.50, output: 6.00,
    longContext: { above: 200_000, input: 4.00, cachedInput: 1.00, output: 12.00 }, aliases: ['grok-4.6'] },
  // [docs]
  { id: 'grok-4.7', input: 2.00, cachedInput: 0.50, output: 6.00,
    longContext: { above: 200_000, input: 4.00, cachedInput: 1.00, output: 12.00 }, aliases: ['grok-4.7'] },

  // ---- Moonshot AI ----
  { id: 'kimi-k3', input: 3.00, cachedInput: 0.30, output: 15.00, aliases: ['kimi-k3'] },
  // [models.json]
  { id: 'kimi-k2.7-code', input: 0.95, cachedInput: 0.19, output: 4.00, aliases: ['kimi-k2.7-code'] },

  // ---- Microsoft ----
  // [models.json]
  { id: 'mai-code-1-flash', input: 0.75, cachedInput: 0.075, output: 4.50, aliases: ['mai-code-1-flash'] },
  { id: 'mai-code-1.1-flash', input: 0.20, cachedInput: 0.02, cacheWrite: 0.25, output: 1.20, aliases: ['mai-code-1.1-flash'] },

  // ---- Fine-tuned (GitHub) ----
  { id: 'raptor-mini', input: 0.25, cachedInput: 0.025, output: 2.00, aliases: ['raptor-mini'] },
  // Goldeneye: pricing per docs uses GPT-5.1-Codex, which mirrors GPT-5.x-Codex.
  { id: 'goldeneye', input: 1.25, cachedInput: 0.125, output: 10.00, aliases: ['goldeneye'] },
  // [models.json] Copilot's built-in "oswe-vscode" model (used by Auto in mid-2026).
  { id: 'oswe-vscode-prime', input: 0.25, cachedInput: 0.025, output: 2.00, aliases: ['oswe-vscode-prime'] },
];

// Pre-build alias index sorted longest-first to avoid prefix collisions
// (e.g. "gpt-5.4-mini" must match before "gpt-5.4").
const ALIAS_INDEX: { alias: string; entry: ModelEntry }[] = MODEL_TABLE
  .flatMap(e => e.aliases.map(a => ({ alias: a.toLowerCase(), entry: e })))
  .sort((a, b) => b.alias.length - a.alias.length);

const DEFAULT_ENTRY: ModelEntry = {
  id: 'unknown',
  input: 3.00, cachedInput: 0.30, cacheWrite: 3.75, cacheWrite1h: 6.00, output: 15.00,
  aliases: [],
};

function normalizeModelName(model: string): string {
  let m = model.toLowerCase().trim();
  // Strip Bedrock/Vertex region + vendor prefixes (e.g. us.anthropic.claude-opus-4-8).
  m = m.replace(/^(us|eu|apac)\./, '');
  m = m.replace(/^(anthropic\/|openai\/|google\/|xai\/|github\/|copilot\/|anthropic\.|google\.)/, '');
  // Strip the long-context marker (claude-opus-4-8[1m], ...:1m).
  m = m.replace(/\[1m\]$/, '').replace(/:1m$/, '');
  // Strip a trailing dated snapshot (claude-opus-4-8-20260115 or -2026-01-15).
  m = m.replace(/-20\d{6}$/, '').replace(/-20\d{2}-\d{2}-\d{2}$/, '');
  m = m.replace(/_/g, '-');
  // Canonicalize the version separator so dash-form ids (claude-opus-4-8) match
  // the dot-form table aliases (claude-opus-4.8). Only digit-dash-digit folds,
  // so model-name dashes (claude-opus, grok-code-fast-1) are untouched.
  m = m.replace(/(\d)-(\d)/g, '$1.$2');
  return m.trim();
}

/**
 * An alias ending in a version digit only matches when the version ends there:
 * "claude-opus-5" must not claim "claude-opus-5.5" (or a future "claude-opus-5.6"),
 * and "gpt-4" must not claim "gpt-4o". Suffixes after a dash ("-fast", "-preview",
 * "-free-auto") still match.
 */
function matchesAt(norm: string, alias: string): boolean {
  let from = 0;
  for (;;) {
    const i = norm.indexOf(alias, from);
    if (i < 0) { return false; }
    const next = norm.charAt(i + alias.length);
    const endsWithDigit = /\d$/.test(alias);
    if (!endsWithDigit || next === '' || !/[0-9a-z.]/.test(next)) { return true; }
    from = i + 1;
  }
}

export function resolveModel(model: string | undefined | null): { entry: ModelEntry; resolved: boolean } {
  if (!model) { return { entry: DEFAULT_ENTRY, resolved: false }; }
  const norm = normalizeModelName(model);
  // ALIAS_INDEX is sorted longest-alias-first, so the first hit is the most
  // specific match — a base alias can never shadow a variant.
  for (const { alias, entry } of ALIAS_INDEX) {
    if (matchesAt(norm, alias)) { return { entry, resolved: true }; }
  }
  return { entry: DEFAULT_ENTRY, resolved: false };
}

export interface ModelPricing {
  input: number;
  cachedInput: number;
  cacheWrite: number;      // 5-minute-TTL cache-write rate
  cacheWrite1h: number;    // 1-hour-TTL cache-write rate (Anthropic = 2x input)
  output: number;
  modelId: string;
  modelResolved: boolean;
  /** True when the long-context tier applied (prompt above the model's threshold). */
  longContext: boolean;
  pricingTableVersion: number;
}

/**
 * Rates for `model`. Pass the request's total input tokens to select the
 * long-context tier: a prompt above the threshold is billed entirely at the
 * long-context rates (verified against billed Copilot calls).
 */
export function getPricing(model: string, inputTokens?: number): ModelPricing {
  const { entry, resolved } = resolveModel(model);
  const lc = entry.longContext;
  const useLc = lc !== undefined && inputTokens !== undefined && inputTokens > lc.above;
  const tier: PriceTier = useLc ? lc! : entry;
  const cacheWrite = tier.cacheWrite ?? tier.input;
  return {
    input: tier.input,
    cachedInput: tier.cachedInput,
    cacheWrite,
    // Fall back to the 5m rate (no extra 1h surcharge) when a model has no explicit
    // 1h rate. This only matters when cacheWrite1hTokens > 0, which today is Claude-only.
    cacheWrite1h: tier.cacheWrite1h ?? cacheWrite,
    output: tier.output,
    modelId: entry.id,
    modelResolved: resolved,
    longContext: useLc,
    pricingTableVersion: PRICING_TABLE_VERSION,
  };
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens?: number;   // tokens served from cache (cheaper rate)
  cacheWriteTokens?: number;    // tokens written to cache (Anthropic; usually surcharged)
  cacheWrite1hTokens?: number;  // subset of cacheWriteTokens written with 1-hour TTL (priced at 2x input)
  reasoningTokens?: number;     // reasoning/thinking tokens (billed at output rate)
  cacheWriteTokensSource?: string;
  /** Credits actually billed for this request (1 credit = $0.01), when the log reports it. */
  directCredits?: number;
}

export interface RequestCostBreakdown {
  requestedModel: string;
  resolvedModel: string;
  modelResolved: boolean;
  pricingTableVersion: number;
  costFormulaVersion: number;
  inputTokens: number;
  cachedInputTokens: number;
  cacheWriteTokens: number;
  uncachedInputTokens: number;
  outputTokens: number;
  rates: {
    input: number;
    cachedInput: number;
    cacheWrite: number;
    cacheWrite1h: number;
    output: number;
  };
  costs: {
    inputUSD: number;
    cachedInputUSD: number;
    cacheWriteUSD: number;
    outputUSD: number;
    totalUSD: number;
  };
  auditFlags: string[];
}

/**
 * Compute the AI-credit cost (in credits; 1 credit = $0.01) for a single request.
 * Uses the billed amount when the log reports it, else the list-price formula.
 */
export function computeCreditsForRequest(model: string, usage: TokenUsage): number {
  return computeCostUSD(model, usage) * 100;
}

/** True when `usage` carries the amount actually billed for the request. */
export function hasMeasuredCost(usage: TokenUsage): boolean {
  return typeof usage.directCredits === 'number' && Number.isFinite(usage.directCredits) && usage.directCredits >= 0;
}

/**
 * USD cost of one request. Prefers the billed amount (`directCredits`, reported by
 * Copilot on every call) because list prices can't reproduce real bills exactly
 * (Auto discount, promotions, time-varying prices). Falls back to list prices.
 */
export function computeCostUSD(model: string, usage: TokenUsage): number {
  if (hasMeasuredCost(usage)) { return usage.directCredits! / 100; }
  return computeListCostUSD(model, usage);
}

/** USD cost of one request at list prices, ignoring any billed amount. */
export function computeListCostUSD(model: string, usage: TokenUsage): number {
  return computeCostBreakdown(model, usage).costs.totalUSD;
}

/** List-price breakdown of one request (always token-based; ignores directCredits). */
export function computeCostBreakdown(model: string, usage: TokenUsage): RequestCostBreakdown {
  const p = getPricing(model, usage.inputTokens);
  const auditFlags: string[] = [];
  if (usage.inputTokens < 0) { auditFlags.push('input_tokens_negative'); }
  if (usage.outputTokens < 0) { auditFlags.push('output_tokens_negative'); }
  if ((usage.cachedInputTokens ?? 0) < 0) { auditFlags.push('cached_input_tokens_negative'); }
  if ((usage.cacheWriteTokens ?? 0) < 0) { auditFlags.push('cache_write_tokens_negative'); }
  const cachedIn = Math.max(0, usage.cachedInputTokens ?? 0);
  const cacheWrite = Math.max(0, usage.cacheWriteTokens ?? 0);
  // Split cache-write into 1-hour and 5-minute TTL buckets. The 1h subset is priced
  // at 2x input (cacheWrite1h); the remainder at the 5m rate (cacheWrite). The full
  // cacheWrite total is still subtracted from input for uncachedIn — only the RATE
  // differs by TTL, not the bucket boundary. cacheWrite1hTokens is 0 for Copilot rows.
  const cacheWrite1h = Math.min(cacheWrite, Math.max(0, usage.cacheWrite1hTokens ?? 0));
  const cacheWrite5m = cacheWrite - cacheWrite1h;
  const uncachedIn = Math.max(0, usage.inputTokens - cachedIn - cacheWrite);
  const out = Math.max(0, usage.outputTokens);
  const inputUSD = (uncachedIn / 1_000_000) * p.input;
  const cachedInputUSD = (cachedIn / 1_000_000) * p.cachedInput;
  const cacheWriteUSD = (cacheWrite5m / 1_000_000) * p.cacheWrite + (cacheWrite1h / 1_000_000) * p.cacheWrite1h;
  const outputUSD = (out / 1_000_000) * p.output;
  if (!p.modelResolved) { auditFlags.push('model_unresolved_pricing_fallback'); }
  if (p.longContext) { auditFlags.push('long_context_pricing'); }
  if (cachedIn + cacheWrite > usage.inputTokens) { auditFlags.push('token_buckets_exceed_input'); }
  if (p.cacheWrite > p.input && (usage.cacheWriteTokens === undefined || usage.cacheWriteTokensSource === 'missing' || usage.cacheWriteTokensSource === 'unknown')) {
    auditFlags.push('cache_write_tokens_missing');
  }

  return {
    requestedModel: model || 'unknown',
    resolvedModel: p.modelId,
    modelResolved: p.modelResolved,
    pricingTableVersion: p.pricingTableVersion,
    costFormulaVersion: COST_FORMULA_VERSION,
    inputTokens: Math.max(0, usage.inputTokens),
    cachedInputTokens: cachedIn,
    cacheWriteTokens: cacheWrite,
    uncachedInputTokens: uncachedIn,
    outputTokens: out,
    rates: { input: p.input, cachedInput: p.cachedInput, cacheWrite: p.cacheWrite, cacheWrite1h: p.cacheWrite1h, output: p.output },
    costs: {
      inputUSD,
      cachedInputUSD,
      cacheWriteUSD,
      outputUSD,
      totalUSD: inputUSD + cachedInputUSD + cacheWriteUSD + outputUSD,
    },
    auditFlags,
  };
}

// =============================================================================
// Billing-status aggregation
// =============================================================================

export interface BillingStatus {
  /** Activity in the period (informational, not billing). */
  activity: {
    /** Distinct Copilot sessions with at least one chat request or LLM call. */
    sessions: number;
    /** Prompts the user sent (incl. failed ones; excludes subagent prompts). */
    chatRequests: number;
  };
  new: {
    aiCreditsUsed: number;
    aiCreditsQuota: number | null;
    /** Base (non-promo) allowance for the plan. Same as aiCreditsQuota when no promo is active. */
    baseAiCreditsQuota: number | null;
    /** Extra credits granted by the promotional period (aiCreditsQuota - baseAiCreditsQuota). */
    promoCreditsBonus: number;
    quotaIsPromotional: boolean;
    percentUsed: number | null;
    /** Credits used beyond the base quota (drawing from the promo bonus). */
    promoCreditsUsed: number;
    estimatedCostUSD: number;
    costBreakdown: { model: string; inputTokens: number; outputTokens: number; credits: number }[];
    cachedTokensCaptured: boolean;
    cachedTokensEstimated: boolean;
    /** True when at least one request in the period has API-reported direct credits. */
    directCreditsMeasured: boolean;
  };
  billingPeriodStart: number;
  billingPeriodEnd: number;
  daysRemaining: number;
  isHistoricalPeriod: boolean;
  plan: CopilotPlan;
  notes: string[];
}

// =============================================================================
// Claude billing — USD + token totals (no GitHub AI credits).
// The shared per-token engine (computeCostUSD over MODEL_TABLE, which holds Anthropic
// list prices) is reused; Claude cache tokens are measured so no estimation is needed.
// CLAUDE-PROVIDER-PLAN.md §7 / §15 #3.
// =============================================================================

export interface ClaudeBillingView {
  provider: 'claude';
  periodLabel: string;
  isHistoricalPeriod: boolean;
  costBasis: ClaudeCostBasis;
  costUSD: number;
  tokenTotals: { input: number; output: number; cachedInput: number; cacheWrite: number };
  perModel: { model: string; inputTokens: number; outputTokens: number; costUSD: number }[];
  notes: string[];
}

export function computeClaudeBilling(
  db: TrackerDatabase,
  period: { start: number; end: number },
  periodLabel: string,
  costBasis: ClaudeCostBasis,
  isHistoricalPeriod: boolean,
): ClaudeBillingView {
  const requests = db.getLLMRequestsInPeriod(period.start, period.end, 'claude');
  let costUSD = 0;
  const tokenTotals = { input: 0, output: 0, cachedInput: 0, cacheWrite: 0 };
  const perModelMap = new Map<string, { model: string; inputTokens: number; outputTokens: number; costUSD: number }>();
  for (const r of requests) {
    const c = computeCostUSD(r.model, {
      inputTokens: r.inputTokens,
      outputTokens: r.outputTokens,
      cachedInputTokens: r.cachedInputTokens,
      cacheWriteTokens: r.cacheWriteTokens,
      cacheWrite1hTokens: r.cacheWrite1hTokens,
      cacheWriteTokensSource: r.cacheWriteTokensSource,
    });
    costUSD += c;
    tokenTotals.input += r.inputTokens;
    tokenTotals.output += r.outputTokens;
    tokenTotals.cachedInput += r.cachedInputTokens || 0;
    tokenTotals.cacheWrite += r.cacheWriteTokens || 0;
    const e = perModelMap.get(r.model) || { model: r.model, inputTokens: 0, outputTokens: 0, costUSD: 0 };
    e.inputTokens += r.inputTokens;
    e.outputTokens += r.outputTokens;
    e.costUSD += c;
    perModelMap.set(r.model, e);
  }
  const notes = costBasis === 'subscription'
    ? ['USD is API-equivalent at Anthropic list prices — on a Claude Pro/Max subscription this is included in your plan, not extra spend.']
    : ['USD is computed at Anthropic API list prices (input incl. cached prefix).'];
  return {
    provider: 'claude',
    periodLabel,
    isHistoricalPeriod,
    costBasis,
    costUSD,
    tokenTotals,
    perModel: Array.from(perModelMap.values()).sort((a, b) => b.costUSD - a.costUSD),
    notes,
  };
}

export function getBillingPeriodBounds(now = Date.now()): { start: number; end: number; daysRemaining: number } {
  const d = new Date(now);
  const start = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
  const end   = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
  const daysRemaining = Math.ceil((end - now) / 86_400_000);
  return { start, end, daysRemaining };
}

function getAiCreditQuota(plan: CopilotPlan, now = Date.now()): { quota: number | null; promotional: boolean } {
  if (now >= BILLING_CHANGE_MS && now < PROMO_END_MS && PLAN_AI_CREDITS_PROMO[plan] !== undefined) {
    return { quota: PLAN_AI_CREDITS_PROMO[plan]!, promotional: true };
  }
  return { quota: PLAN_AI_CREDITS_STANDARD[plan], promotional: false };
}

export function computeBillingStatus(
  db: TrackerDatabase,
  plan: CopilotPlan,
  now = Date.now(),
  periodOverride?: { start: number; end: number }
): BillingStatus {
  let start: number, end: number, daysRemaining: number;
  if (periodOverride) {
    start = periodOverride.start;
    end = periodOverride.end;
    daysRemaining = 0;
  } else {
    const bounds = getBillingPeriodBounds(now);
    start = bounds.start;
    end = bounds.end;
    daysRemaining = bounds.daysRemaining;
  }

  // COPILOT-ONLY: passing 'copilot' is load-bearing (CLAUDE-PROVIDER-PLAN.md §15 #1) —
  // without it, Claude rows would inflate Copilot activity and AI-credit totals.
  const activity = db.getActivityCounts(start, end, 'copilot');

  // Token-based cost across ALL llm requests in period (incl. tool/subagent calls).
  // Hybrid: use measured cache values when present, estimate otherwise.
  // Prefer API-reported direct credits when available.
  const rawRequests = db.getLLMRequestsInPeriod(start, end, 'copilot');
  const { requests, anyEstimated, anyMeasured } = estimateSessionCaching(rawRequests);
  const newBreakdown = new Map<string, { inputTokens: number; outputTokens: number; credits: number }>();
  let totalAiCredits = 0;
  let directCreditsMeasured = false;
  const cachedTokensCaptured = anyMeasured;
  const cachedTokensEstimated = anyEstimated;
  for (const req of requests) {
    let credits: number;
    if (req.directCredits !== undefined) {
      // Use API-reported value directly — most accurate source.
      credits = req.directCredits;
      directCreditsMeasured = true;
    } else {
      credits = computeCreditsForRequest(req.model, req);
    }
    totalAiCredits += credits;
    const ex = newBreakdown.get(req.model) || { inputTokens: 0, outputTokens: 0, credits: 0 };
    ex.inputTokens += req.inputTokens;
    ex.outputTokens += req.outputTokens;
    ex.credits += credits;
    newBreakdown.set(req.model, ex);
  }

  // Suppress quotas for historical/all-time periods — they are per-month allowances.
  const { quota: aiQuota, promotional } = periodOverride
    ? { quota: null as null, promotional: false }
    : getAiCreditQuota(plan, now);

  // Base (non-promo) quota is always the standard allowance regardless of promo period.
  const baseAiQuota = PLAN_AI_CREDITS_STANDARD[plan];
  const promoBonus = (aiQuota !== null && baseAiQuota !== null && promotional)
    ? Math.max(0, aiQuota - baseAiQuota)
    : 0;
  // Credits drawn beyond base quota come from the promo bonus.
  const promoCreditsUsed = baseAiQuota !== null
    ? Math.max(0, totalAiCredits - baseAiQuota)
    : 0;

  const notes: string[] = [];
  if (now < BILLING_CHANGE_MS) {
    notes.push(`Token-based billing takes effect ${new Date(BILLING_CHANGE_MS).toUTCString().slice(0, 16)}; figures shown are projections.`);
  }
  if (promotional) { notes.push('Promotional credit allowance active (June 1 - September 1, 2026).'); }
  if (promotional && promoBonus > 0) {
    notes.push(`Promo bonus: ${promoBonus} extra credits/month (base ${baseAiQuota} + ${promoBonus} free promo = ${aiQuota} total).`);
  }
  if (plan === 'business' || plan === 'enterprise') {
    notes.push('Business/Enterprise AI credits are POOLED across all licensed users; the quota shown is per-license-equivalent.');
  }
  if (plan === 'free') { notes.push('Free-plan AI credit allowance is not officially published; quota shown is omitted.'); }
  if (!cachedTokensCaptured && !cachedTokensEstimated) { notes.push('Cached/cache-write token counts are not present in the logs; cost shown is an upper bound.'); }
  if (cachedTokensEstimated && !cachedTokensCaptured) { notes.push('Cached token values are estimated based on provider caching rules (prefix matching, TTL, min thresholds).'); }
  if (cachedTokensCaptured && cachedTokensEstimated) { notes.push('Some cached token values are measured from logs; others are estimated based on provider caching rules.'); }
  if (directCreditsMeasured) { notes.push('Credit costs are sourced directly from the API for some requests (most accurate).'); }
  if (rawRequests.some(r => r.inputTokensSource === 'chat_history')) {
    notes.push('Some requests were recovered from VS Code chat history (no debug log): their credits are per-request totals, but input tokens cover only the final tool-call round.');
  }

  return {
    activity,
    new: {
      aiCreditsUsed: round1(totalAiCredits),
      aiCreditsQuota: aiQuota,
      baseAiCreditsQuota: periodOverride ? null : baseAiQuota,
      promoCreditsBonus: promoBonus,
      quotaIsPromotional: promotional,
      percentUsed: aiQuota && aiQuota > 0 ? round1((totalAiCredits / aiQuota) * 100) : null,
      promoCreditsUsed: round1(promoCreditsUsed),
      estimatedCostUSD: totalAiCredits / 100,
      costBreakdown: Array.from(newBreakdown.entries())
        .map(([model, d]) => ({ model, inputTokens: d.inputTokens, outputTokens: d.outputTokens, credits: round1(d.credits) }))
        .sort((a, b) => b.credits - a.credits),
      cachedTokensCaptured,
      cachedTokensEstimated,
      directCreditsMeasured,
    },
    billingPeriodStart: start,
    billingPeriodEnd: end,
    daysRemaining,
    isHistoricalPeriod: !!periodOverride,
    plan,
    notes,
  };
}

function round1(n: number): number { return Math.round(n * 10) / 10; }
