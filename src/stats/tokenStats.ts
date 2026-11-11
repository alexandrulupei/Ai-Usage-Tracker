import {
  ParsedSession,
  SessionStats,
} from '../core/types';
import { COST_FORMULA_VERSION, PRICING_TABLE_VERSION, computeCostBreakdown, hasMeasuredCost } from './billingCalculator';
import { estimateSessionCaching } from './cacheEstimator';
import { CHAT_HISTORY_LOWER_BOUND_FLAG } from '../core/chatHistory';

/**
 * Compute session-level statistics from a parsed session.
 */
export function computeSessionStats(parsed: ParsedSession): SessionStats {
  const { session, llmRequests, userMessages, toolCalls, turnCount, subagentNames } = parsed;

  const isOtel = parsed.session.dataSource === 'otel';

  const totalInputTokens = llmRequests.reduce((sum, r) => sum + r.inputTokens, 0);
  const totalOutputTokens = llmRequests.reduce((sum, r) => sum + r.outputTokens, 0);
  const totalTokens = totalInputTokens + totalOutputTokens;
  const totalReasoningTokens = llmRequests.reduce((sum, r) => sum + (r.reasoningTokens || 0), 0);
  const totalCacheWriteTokens = llmRequests.reduce((sum, r) => sum + (r.cacheWriteTokens || 0), 0);

  // OTel sessions have real cached tokens — skip estimation.
  // JSONL sessions use the heuristic estimator.
  let costRequests: typeof llmRequests;
  let totalCachedTokens: number;
  let anyEstimated = false;
  let anyMeasured = false;
  if (isOtel) {
    costRequests = llmRequests;
    totalCachedTokens = llmRequests.reduce((sum, r) => sum + (r.cachedInputTokens || 0), 0);
    anyMeasured = true;
  } else {
    const { requests: estimatedRequests, anyEstimated: est, anyMeasured: measured } = estimateSessionCaching(llmRequests);
    costRequests = estimatedRequests;
    totalCachedTokens = estimatedRequests.reduce((sum, r) => sum + (r.cachedInputTokens || 0), 0);
    anyEstimated = est;
    anyMeasured = measured;
  }

  // USD cost under usage-based billing (Jun 1, 2026+). A request whose log reports
  // the billed amount (directCredits) uses it as-is — exact, and immune to the
  // token-detail gaps below. Other requests are priced at list rates, and only
  // THEIR token gaps can make the session's cost estimated/incomplete.
  const costAuditFlags = new Set<string>();
  let costUSD = 0;
  let effectiveCacheWriteTokens = 0;
  let billedCount = 0;
  let listPricedCount = 0;
  for (const r of costRequests) {
    effectiveCacheWriteTokens += r.cacheWriteTokens || 0;
    for (const flag of r.tokenAuditFlags ?? []) { costAuditFlags.add(flag); }
    if (hasMeasuredCost(r)) {
      costUSD += r.directCredits! / 100;
      billedCount++;
      continue;
    }
    listPricedCount++;
    const breakdown = computeCostBreakdown(r.model, {
      inputTokens: r.inputTokens,
      outputTokens: r.outputTokens,
      cachedInputTokens: r.cachedInputTokens,
      cacheWriteTokens: r.cacheWriteTokens,
      cacheWrite1hTokens: r.cacheWrite1hTokens,
      reasoningTokens: r.reasoningTokens,
      cacheWriteTokensSource: r.cacheWriteTokensSource,
    });
    costUSD += breakdown.costs.totalUSD;
    for (const flag of breakdown.auditFlags) { costAuditFlags.add(flag); }
  }
  if (billedCount > 0) { costAuditFlags.add('cost_from_billed_amount'); }

  // Cache-token measurement only matters for list-priced requests.
  const listEstimated = listPricedCount > 0 && anyEstimated;
  const listMeasured = listPricedCount > 0 && (anyMeasured || isOtel);
  const anyCostMeasured = billedCount > 0 || listMeasured;
  let costAuditState: SessionStats['costAuditState'] = listEstimated && anyCostMeasured ? 'mixed'
    : listEstimated ? 'estimated'
      : anyCostMeasured ? 'measured'
        : 'incomplete';
  if (costAuditFlags.has('cache_write_tokens_missing') || costAuditFlags.has('token_buckets_exceed_input')
    // Chat-history recovery only knows the final tool-call round's prompt, so the
    // session's input tokens (and token-formula USD) are a lower bound.
    || costAuditFlags.has(CHAT_HISTORY_LOWER_BOUND_FLAG)) {
    costAuditState = 'incomplete';
  }
  if (costAuditState !== 'measured') { costAuditFlags.add(`cost_${costAuditState}`); }

  const errorCount = llmRequests.filter(r => r.status === 'error').length
    + toolCalls.filter(t => t.status === 'error').length;

  // avg tokens per (successful) request: numerator and denominator must agree.
  const successfulRequests = llmRequests.filter(r => r.status === 'ok');
  const successfulTokens = successfulRequests.reduce((s, r) => s + r.inputTokens + r.outputTokens, 0);
  const avgTokensPerRequest = successfulRequests.length > 0
    ? Math.round(successfulTokens / successfulRequests.length)
    : 0;

  const ttftValues = successfulRequests.map(r => r.ttft).filter(t => t > 0);
  const avgTtft = ttftValues.length > 0
    ? Math.round(ttftValues.reduce((a, b) => a + b, 0) / ttftValues.length)
    : 0;

  const durationMs = session.endTime - session.startTime;

  // Model distribution
  const modelCounts = new Map<string, number>();
  for (const r of llmRequests) {
    modelCounts.set(r.model, (modelCounts.get(r.model) || 0) + 1);
  }
  const modelsUsed = Array.from(modelCounts.keys());
  const dominantModel = modelsUsed.length > 0
    ? modelsUsed.reduce((a, b) => (modelCounts.get(a)! >= modelCounts.get(b)! ? a : b))
    : '';

  // Efficiency score: lower is better.
  // Normalized tokens per turn (compared to an expected baseline of ~5000 tokens/turn).
  const expectedTokensPerTurn = 5000;
  const turnsUsed = Math.max(turnCount, 1);
  const efficiencyScore = totalTokens > 0
    ? Math.round((totalTokens / turnsUsed / expectedTokensPerTurn) * 100) / 100
    : 0;

  // Rework score: detect consecutive user messages with similar content
  const reworkScore = computeReworkScore(parsed);

  return {
    sessionId: session.id,
    provider: session.provider,
    totalInputTokens,
    totalOutputTokens,
    totalTokens,
    costUSD,
    llmRequestCount: llmRequests.length,
    userMessageCount: userMessages.length,
    toolCallCount: toolCalls.length,
    errorCount,
    turnCount,
    subagentCount: subagentNames.length,
    avgTokensPerRequest,
    avgTtft,
    durationMs,
    modelsUsed,
    dominantModel,
    efficiencyScore,
    reworkScore,
    totalReasoningTokens,
    totalCachedTokens,
    totalCacheWriteTokens: Math.max(totalCacheWriteTokens, effectiveCacheWriteTokens),
    dataSource: parsed.session.dataSource || 'jsonl',
    costAuditState,
    costAuditFlags: Array.from(costAuditFlags).sort(),
    pricingTableVersion: PRICING_TABLE_VERSION,
    costFormulaVersion: COST_FORMULA_VERSION,
  };
}

/**
 * Detect rework patterns: consecutive user messages with similar words.
 * Returns a score from 0 (no rework) to 1 (all messages are similar).
 */
function computeReworkScore(parsed: ParsedSession): number {
  const messages = parsed.userMessages;
  if (messages.length < 2) { return 0; }

  let similarPairs = 0;
  for (let i = 1; i < messages.length; i++) {
    const sim = jaccardSimilarity(
      tokenize(messages[i - 1].contentPreview),
      tokenize(messages[i].contentPreview)
    );
    if (sim > 0.4) { similarPairs++; }
  }

  return Math.round((similarPairs / (messages.length - 1)) * 100) / 100;
}

function tokenize(text: string): Set<string> {
  return new Set(
    text.toLowerCase().replace(/[^a-z0-9\s]/g, '').split(/\s+/).filter(w => w.length > 2)
  );
}

function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) { return 0; }
  let intersection = 0;
  for (const word of a) {
    if (b.has(word)) { intersection++; }
  }
  const union = a.size + b.size - intersection;
  return union > 0 ? intersection / union : 0;
}
