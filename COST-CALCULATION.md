# How Costs Are Calculated

This document explains exactly how the Copilot Usage Tracker computes costs for every LLM request, converts them to AI credits, and aggregates them into billing-period totals.

---

## Table of Contents

- [Overview](#overview)
- [Token Buckets](#token-buckets)
- [Billed Amount First](#billed-amount-first)
- [The Cost Formula](#the-cost-formula)
- [Per-Model Pricing Table](#per-model-pricing-table)
- [Model Resolution](#model-resolution)
- [Cache Token Sources](#cache-token-sources)
  - [Source A: Estimation (cacheEstimator)](#source-a-estimation-cacheestimator)
  - [Source B: Real Data (promptExportReader)](#source-b-real-data-promptexportreader)
  - [How the Two Sources Merge](#how-the-two-sources-merge)
- [Anthropic Cache-Write Surcharge](#anthropic-cache-write-surcharge)
- [Non-Anthropic Providers](#non-anthropic-providers)
- [AI Credits Conversion](#ai-credits-conversion)
- [Billing Period Aggregation](#billing-period-aggregation)
- [Activity: Sessions and Chat Requests](#activity-sessions-and-chat-requests)
- [Worked Examples](#worked-examples)
- [Edge Cases and Limitations](#edge-cases-and-limitations)

---

## Overview

GitHub Copilot's usage-based billing (effective June 1, 2026) charges per token. Every LLM request has:

- **Input tokens** — what gets sent to the model (conversation history, system prompt, tool results, etc.)
- **Output tokens** — what the model generates back
- **Cached input tokens** — a subset of input tokens that were served from the provider's cache (cheaper)
- **Cache-write tokens** — a subset of input tokens that were written into the cache for the first time (Anthropic charges a surcharge for this)

The extension computes a USD cost for each request, then converts to **AI credits** (1 credit = $0.01 USD).

The implementation now tracks whether each cost is **measured**, **estimated**, **mixed**, or **incomplete**. Measured token buckets come from OTel or prompt-export usage metadata. Heuristic cache values are still useful for projections, but they are flagged and should not be treated as an audit-final bill.

---

## Token Buckets

Every LLM request's input tokens are decomposed into **three mutually exclusive buckets**:

```
inputTokens = uncachedInput + cachedInput + cacheWriteTokens
```

| Bucket | What it means | Rate applied |
|--------|---------------|--------------|
| **Uncached input** | Tokens that were neither cached nor written to cache | Base input rate |
| **Cached input** | Tokens served from a previous cache entry (cache hit) | Discounted cached rate |
| **Cache-write** | Tokens written to cache for the first time | Surcharge rate (Anthropic) or base rate (others) |

The uncached bucket is computed as:

```
uncachedInput = max(0, inputTokens ? cachedInputTokens ? cacheWriteTokens)
```

The `max(0, ...)` clamp prevents negative values if the data is inconsistent.

---

## Billed Amount First

Every Copilot request in current logs records what GitHub actually billed: `copilotUsageNanoAiu` in debug logs, `copilotUsage.totalNanoAiu` in Copilot CLI sessions, and `copilotCredits` in recovered chat history (1,000,000,000 nanoAIU = 1 credit = $0.01). **When that amount is present, it is the request's cost**, and the token formula below is not used.

List prices can't reproduce real bills exactly. Checked against real calls, the bill also depends on:
- the **Auto** discount (10%, `auto_discount` in the model list);
- the long-context tier;
- time-limited promotions (an unannounced 0.7× rate seen from about 2026-11-02);
- prices changing over time (`gpt-5.6-sol` changed three times between August and September 2026).

On real data, the old list-price estimate showed Copilot at **1.99×** what was billed; the corrected table gives 0.93×, and using the billed amount is exact.

The token formula is used for requests without a billed amount. That means Claude Code (whose transcripts record no billed amount) and the occasional Copilot request without one. A session's audit state is `measured` when its cost comes from billed amounts or from fully measured tokens.

---

## The Cost Formula

For a single request:

```
costUSD =
    (uncachedInput / 1,000,000) × inputRate
  + (cachedInput   / 1,000,000) × cachedInputRate
  + (cacheWrite    / 1,000,000) × cacheWriteRate
  + (outputTokens  / 1,000,000) × outputRate
```

Where:
- All rates are **per 1 million tokens** and come from the pricing table
- `cacheWriteRate` = the model's `cacheWrite` field if defined (Anthropic), otherwise falls back to the base `inputRate`
- Output tokens are always charged at the output rate regardless of caching

---

## Per-Model Pricing Table

All prices are USD per 1 million tokens, as of 2026-11-11. These tables are generated from `MODEL_TABLE` in `src/stats/billingCalculator.ts`, which is the single source of truth (the dashboard has no price table of its own).

**Sources.** GitHub Copilot's own model list (the `billing.token_prices` in the `models.json` that Copilot writes next to every debug log; credits per 1M tokens ÷ 100 = USD), cross-checked against [GitHub Docs — Models and pricing](https://docs.github.com/en/copilot/reference/copilot-billing/models-and-pricing). The two agree for every model they both list. Claude Code uses the same table: Anthropic's first-party API prices are identical. Anthropic cache writes cost 1.25× input (5-minute TTL) or 2× (1-hour TTL); cache reads cost 0.1× input, but 0.05× on Opus 5.5 / Sonnet 5.5 and 0.025× on Fable 5.1 / 5.2.

**Long context.** When a request's prompt is larger than the threshold, the **whole request** is billed at the long-context rates. This was verified against billed Copilot calls: billed/list was 1.94 at default rates and 0.99 at long-context rates.

**Included models.** GPT-4.1, GPT-4o and GPT-4o mini cost 0 in Copilot. Copilot's model list prices them at 0, and real logs bill them at 0.

A cache-write price of "—" means the model has no separate cache-write price; written tokens are billed at the input rate.

### Anthropic

| Model | Input | Cached input | Cache write (5m) | Cache write (1h) | Output | Long context: prompt > N tokens (input / cached / output) |
|---|---:|---:|---:|---:|---:|---|
| `claude-haiku-4.5` | $1.00 | $0.10 | $1.25 | $2.00 | $5.00 | — |
| `claude-haiku-5.5` | $0.10 | $0.01 | $0.125 | $0.20 | $0.50 | > 100K: $0.50 / $0.05 / $2.50 |
| `claude-sonnet-4` | $3.00 | $0.30 | $3.75 | $6.00 | $15.00 | — |
| `claude-sonnet-4.5` | $3.00 | $0.30 | $3.75 | $6.00 | $15.00 | — |
| `claude-sonnet-4.6` | $3.00 | $0.30 | $3.75 | $6.00 | $15.00 | — |
| `claude-sonnet-5` | $2.00 | $0.20 | $2.50 | $4.00 | $10.00 | — |
| `claude-sonnet-5.5` | $2.00 | $0.10 | $2.50 | $4.00 | $10.00 | — |
| `claude-opus-4.5` | $5.00 | $0.50 | $6.25 | $10.00 | $25.00 | — |
| `claude-opus-4.6` | $5.00 | $0.50 | $6.25 | $10.00 | $25.00 | — |
| `claude-opus-4.6-fast` | $30.00 | $3.00 | $37.50 | $60.00 | $150.00 | — |
| `claude-opus-4.7` | $5.00 | $0.50 | $6.25 | $10.00 | $25.00 | — |
| `claude-opus-4.8` | $5.00 | $0.50 | $6.25 | $10.00 | $25.00 | — |
| `claude-opus-4.8-fast` | $10.00 | $1.00 | $12.50 | $20.00 | $50.00 | — |
| `claude-opus-5` | $5.00 | $0.50 | $6.25 | $10.00 | $25.00 | — |
| `claude-opus-5.5` | $4.00 | $0.20 | $5.00 | $8.00 | $20.00 | — |
| `claude-fable-5` | $10.00 | $1.00 | $12.50 | $20.00 | $50.00 | — |
| `claude-fable-5.1` | $10.00 | $0.25 | $12.50 | $20.00 | $50.00 | — |
| `claude-fable-5.2` | $8.00 | $0.20 | $10.00 | $16.00 | $40.00 | — |

### OpenAI

| Model | Input | Cached input | Cache write (5m) | Cache write (1h) | Output | Long context: prompt > N tokens (input / cached / output) |
|---|---:|---:|---:|---:|---:|---|
| `gpt-4.1` | $0.00 | $0.00 | — | — | $0.00 | — |
| `gpt-4o` | $0.00 | $0.00 | — | — | $0.00 | — |
| `gpt-4o-mini` | $0.00 | $0.00 | — | — | $0.00 | — |
| `gpt-5-mini` | $0.25 | $0.025 | — | — | $2.00 | — |
| `gpt-5.2` | $1.75 | $0.175 | — | — | $14.00 | — |
| `gpt-5.2-codex` | $1.75 | $0.175 | — | — | $14.00 | — |
| `gpt-5.3-codex` | $1.75 | $0.175 | — | — | $14.00 | — |
| `gpt-5.4` | $2.50 | $0.25 | — | — | $15.00 | > 272K: $5.00 / $0.50 / $22.50 |
| `gpt-5.4-mini` | $0.75 | $0.075 | — | — | $4.50 | — |
| `gpt-5.4-nano` | $0.20 | $0.02 | — | — | $1.25 | — |
| `gpt-5.5` | $5.00 | $0.50 | — | — | $30.00 | > 272K: $10.00 / $1.00 / $45.00 |
| `gpt-5.6-luna` | $0.20 | $0.02 | $0.25 | — | $1.20 | > 200K: $0.40 / $0.04 / $1.80 |
| `gpt-5.6-terra` | $2.00 | $0.20 | $2.50 | — | $12.00 | > 272K: $4.00 / $0.40 / $18.00 |
| `gpt-5.6-sol` | $4.00 | $0.40 | $5.00 | — | $20.00 | > 272K: $8.00 / $0.80 / $30.00 |
| `gpt-6-luna` | $0.10 | $0.01 | $0.125 | — | $0.50 | > 272K: $0.20 / $0.02 / $0.75 |
| `gpt-6-sol` | $2.00 | $0.20 | $2.50 | — | $10.00 | > 272K: $4.00 / $0.40 / $15.00 |
| `gpt-6-astra` | $10.00 | $1.00 | $12.50 | — | $50.00 | > 272K: $20.00 / $2.00 / $75.00 |
| `gpt-6.1-sol` | $2.00 | $0.10 | $2.50 | — | $10.00 | > 272K: $4.00 / $0.20 / $15.00 |
| `gpt-6.1-terra` | $1.00 | $0.05 | $1.25 | — | $5.00 | > 272K: $2.00 / $0.10 / $7.50 |

### Google

| Model | Input | Cached input | Cache write (5m) | Cache write (1h) | Output | Long context: prompt > N tokens (input / cached / output) |
|---|---:|---:|---:|---:|---:|---|
| `gemini-2.5-pro` | $1.25 | $0.125 | — | — | $10.00 | — |
| `gemini-3-flash` | $0.50 | $0.05 | — | — | $3.00 | — |
| `gemini-3.1-pro` | $2.00 | $0.20 | — | — | $12.00 | > 200K: $4.00 / $0.40 / $18.00 |
| `gemini-3.5-flash` | $1.50 | $0.15 | — | — | $9.00 | — |
| `gemini-3.6-flash` | $0.75 | $0.075 | — | — | $3.75 | — |
| `gemini-3.7-flash` | $0.75 | $0.075 | — | — | $3.75 | — |
| `gemini-3.8-flash` | $0.75 | $0.075 | — | — | $3.75 | — |
| `gemini-4-argon` | $2.00 | $0.10 | — | — | $10.00 | — |
| `gemini-4-carbon` | $2.00 | $0.10 | — | — | $10.00 | — |

### xAI

| Model | Input | Cached input | Cache write (5m) | Cache write (1h) | Output | Long context: prompt > N tokens (input / cached / output) |
|---|---:|---:|---:|---:|---:|---|
| `grok-code-fast-1` | $0.20 | $0.02 | — | — | $1.50 | — |
| `grok-4.5` | $2.00 | $0.50 | — | — | $6.00 | > 200K: $4.00 / $1.00 / $12.00 |
| `grok-4.6` | $2.00 | $0.50 | — | — | $6.00 | > 200K: $4.00 / $1.00 / $12.00 |
| `grok-4.7` | $2.00 | $0.50 | — | — | $6.00 | > 200K: $4.00 / $1.00 / $12.00 |

### Moonshot AI

| Model | Input | Cached input | Cache write (5m) | Cache write (1h) | Output | Long context: prompt > N tokens (input / cached / output) |
|---|---:|---:|---:|---:|---:|---|
| `kimi-k3` | $3.00 | $0.30 | — | — | $15.00 | — |
| `kimi-k2.7-code` | $0.95 | $0.19 | — | — | $4.00 | — |

### Microsoft

| Model | Input | Cached input | Cache write (5m) | Cache write (1h) | Output | Long context: prompt > N tokens (input / cached / output) |
|---|---:|---:|---:|---:|---:|---|
| `mai-code-1-flash` | $0.75 | $0.075 | — | — | $4.50 | — |
| `mai-code-1.1-flash` | $0.20 | $0.02 | $0.25 | — | $1.20 | — |

### Fine-tuned

| Model | Input | Cached input | Cache write (5m) | Cache write (1h) | Output | Long context: prompt > N tokens (input / cached / output) |
|---|---:|---:|---:|---:|---:|---|
| `raptor-mini` | $0.25 | $0.025 | — | — | $2.00 | — |
| `goldeneye` | $1.25 | $0.125 | — | — | $10.00 | — |
| `oswe-vscode-prime` | $0.25 | $0.025 | — | — | $2.00 | — |

### Unknown models

A model that matches no entry is priced at a default of $3.00 / $0.30 / $3.75 / $15.00 and flagged `model_unresolved_pricing_fallback`. For Copilot this rarely matters, because the billed amount is used whenever the log reports it (see [Billed Amount First](#billed-amount-first)).

---

## Model Resolution

Model names from the debug logs can come in many forms. The resolver normalizes and matches them:

1. **Vendor prefix stripping** — prefixes like `openai/`, `anthropic/`, `google/`, `xai/`, `github/` are removed  
2. **Underscore normalization** — underscores become hyphens  
3. **Case insensitive** — all matching is lowercase  
4. **Longest-match-first** — aliases are sorted by descending length before matching, so `gpt-5.4-mini` always matches before `gpt-5.4`, and `claude-sonnet-4.5` before `claude-sonnet-4`
5. **Date-suffix handling** — trailing snapshots (`-20250514`, `-2024-07-18`) are stripped, so `gpt-4o-mini-2024-07-18` resolves to `gpt-4o-mini`
6. **Dash versions** — `claude-opus-5-5` (Claude Code / API form) is read as `claude-opus-5.5`; region and vendor prefixes (`us.anthropic.`, `copilot/`) and the `[1m]` marker are dropped
7. **Version boundary** — an alias that ends in a version number only matches where the version ends. So `claude-opus-5` never claims `claude-opus-5.5` or a future `claude-opus-5.6`, and `gpt-4` never claims `gpt-4o`. A newer, unlisted version shows as **unknown** (flagged) rather than being silently priced as an older model. Suffixes after a dash still match (`gpt-5.6-luna-free-auto` → `gpt-5.6-luna`).

Examples:

| Log value | Resolves to |
|-----------|-------------|
| `claude-opus-4.6` | claude-opus-4.6 |
| `openai/gpt-5.4` | gpt-5.4 |
| `gpt-4o-mini-2024-07-18` | gpt-4o-mini (explicit alias) |
| `CLAUDE-SONNET-4` | claude-sonnet-4 |
| `some_unknown_model` | unknown (default pricing) |

---

## Cache Token Sources

Current Copilot Chat debug logs (Copilot Chat 0.60 and later) record `cachedTokens` on every LLM call, but **not cache-write tokens**. Copilot CLI sessions and Claude Code transcripts record both. Cache data only affects cost for requests without a billed amount (see [Billed Amount First](#billed-amount-first)). Where cache data is missing, the extension falls back on two sources, in order of preference:

### Source A: Estimation (cacheEstimator)

When no real data is available, the extension estimates cached tokens using the same rules the LLM providers use for automatic prefix caching.

#### How estimation works

Requests within a session are grouped by `(model, subagent scope)` and processed chronologically. For each request in a group:

**Step 1 — Is this the first request in its scope?**
- Yes ? **Cache miss.** The entire input is being seen for the first time.
  - Anthropic: all input tokens are `cacheWriteTokens` (billed at 1.25× base)
  - Others: all input tokens are regular uncached input (no surcharge)

**Step 2 — Is the input below the minimum cacheable threshold?**
- Yes ? No caching applies. All tokens are uncached input.

Minimum thresholds per model:

| Model | Min tokens |
|-------|-----------|
| Claude Opus 4.5–4.7, Haiku 4.5 | 4,096 |
| Claude Sonnet 4.6, Haiku 3.5 | 2,048 |
| Claude Sonnet 4/4.5, Opus 4/4.1 | 1,024 |
| All OpenAI models | 1,024 |
| Gemini Pro models | 4,096 |
| Gemini Flash | 1,024 |
| Others | 1,024 |

**Step 3 — Has the cache TTL expired?**
- Yes (gap since previous request exceeds TTL) ? Cache miss (same as Step 1).

TTLs used:

| Provider | TTL |
|----------|-----|
| Anthropic | 5 minutes |
| OpenAI | 10 minutes |
| Google | 5 minutes |
| xAI | 5 minutes |

**Step 4 — Was the context compacted?**
- If `inputTokens < previousInputTokens × 0.7` (a 30%+ drop), the conversation was summarized/compacted ? the prefix hash changed entirely ? cache miss.

**Step 5 — Estimate the cache hit**
- In multi-turn conversations, each request re-sends the full prior context plus new content. The cached portion is approximated as:
  ```
  cachedTokens = min(previousRequestInputTokens, currentRequestInputTokens)
  newDelta     = max(0, currentInputTokens ? cachedTokens)
  ```
- For Anthropic: `cacheWriteTokens = newDelta` (the new content, billed at 1.25× base)
- For others: `cacheWriteTokens = 0` (no surcharge; new content billed at base rate)

#### Subagent scoping

Subagent requests (e.g., Explore agent invocations) get their **own cache scope**. A subagent's context does not overlap with the parent conversation, so cache state never bleeds between them.

### Source B: Real Data (promptExportReader)

The Copilot extension exposes a hidden command (`github.copilot.chat.debug.exportAllPromptLogsAsJson`) that exports prompt logs with full `usage.prompt_tokens_details.cached_tokens` data.

The extension:
1. Calls this command during sync to get fresh data
2. Persists the entries in an internal `prompt_export_cache` database table (survives VS Code restarts)
3. Builds a match index from all stored entries (fresh + historical)
4. Matches entries to database records by `(resolvedModel, inputTokens, outputTokens)` plus timestamp proximity
5. Updates the database record's `cached_input_tokens` with the real value and records match provenance/confidence

When real cached-token data is available, measured zeroes are preserved as measured zeroes. The estimator does not reinterpret them as missing values.

### How the Two Sources Merge

During billing aggregation (`computeBillingStatus`):

1. All LLM requests for the billing period are fetched from the database
2. `estimateSessionCaching()` is called on the full set
3. For each request:
   - If it already has real cached data (`cachedInputTokens > 0` or `cacheWriteTokens > 0`): use the real values, flag as **measured**
   - Otherwise: apply the estimation algorithm, flag as **estimated**
4. The billing status reports whether values are measured, estimated, or a mix

The UI shows notes like:
- _"Cached token values are estimated based on provider caching rules"_ — all estimated
- _"Some cached token values are measured from logs; others are estimated"_ — mixed

---

## Anthropic Cache-Write Surcharge

This is the most nuanced part of the cost model. Anthropic charges **1.25× the base input rate** when tokens are written to cache for the first time. Other providers have no such surcharge.

### When cache-write tokens are generated

There are three paths:

#### Path 1: Estimation — cache miss (first request or TTL expired)

```
Anthropic:     cacheWriteTokens = inputTokens     (all input is cache-write)
Non-Anthropic: cacheWriteTokens = 0                (no surcharge concept)
```

#### Path 2: Estimation — cache hit (subsequent request within TTL)

```
Anthropic:     cacheWriteTokens = inputTokens ? cachedTokens   (only the new delta)
Non-Anthropic: cacheWriteTokens = 0
```

#### Path 3: Enrichment - real data from prompt export

The prompt export provides `cached_tokens`. If it does not also expose an authoritative cache-write bucket, the extension records cached input as measured and marks Anthropic cache-write as missing/incomplete rather than silently inferring a billable value.

Projected views may still estimate cache-write tokens, but audited totals must be traceable to measured fields or clearly flagged as incomplete.

### Cost impact

For a 100K-token Anthropic request where 80K tokens are cached:

| Without surcharge | With surcharge (actual) |
|-------------------|------------------------|
| 100K × base rate | 80K × cached rate + 20K × 1.25× base rate |
| Higher overall | Lower overall (cache savings outweigh surcharge) |

The surcharge only matters because it makes the **first request in a session** more expensive than base rate, since every input token is a cache-write.

---

## Non-Anthropic Providers

For OpenAI, Google, xAI, and GitHub fine-tuned models:

- There is **no cache-write surcharge** — tokens written to cache cost the same as regular uncached input
- `cacheWriteTokens` is always 0 in both estimation and enrichment
- The cost formula's fallback `cacheWrite ?? input` ensures these tokens (if somehow present) would be charged at the base input rate
- The only discount comes from **cached input tokens**, which are billed at the model's `cachedInput` rate (typically 10-50% of base)

---

## AI Credits Conversion

```
credits = costUSD × 100
```

Since 1 AI credit = $0.01 USD, a request costing $0.2325 = 23.25 credits.

For display purposes, credits are rounded to 1 decimal place. When converting back to USD for the billing summary, credits are rounded to the nearest integer first:

```
displayUSD = Math.round(totalCredits) / 100
```

---

## Billing Period Aggregation

The billing period runs from the **1st of each month (00:00 UTC)** to the **1st of the next month (00:00 UTC)**.

### What gets counted

- **AI credits (new)**: ALL LLM requests in the period, including tool-use loops and subagent calls. Token-level cost is computed for each request individually, then summed.

### Quota

| Plan | AI Credits/month | Notes |
|------|----------------:|-------|
| Free | Not published | Omitted from display |
| Pro | 1,500 | 1,000 base + 500 flex |
| Pro+ | 7,000 | 3,900 base + 3,100 flex |
| Business | 1,900 (3,000 promo) | Pooled across org; promo Jun 1–Sep 1, 2026 |
| Enterprise | 3,900 (7,000 promo) | Pooled across org; promo Jun 1–Sep 1, 2026 |

### Aggregation flow

```
1. Fetch all LLM requests in [periodStart, periodEnd)
2. Run estimateSessionCaching() ? annotate with cached/cache-write tokens
3. For each request: credits = billed credits if the log reports them,
   else computeCostUSD(model, usage) × 100 (list price, long-context tier aware)
4. Sum all credits ? aiCreditsUsed
5. Compare against quota ? percentUsed
```

---

## Activity: Sessions and Chat Requests

The request-based (premium request) billing view was removed. Since June 1, 2026 Copilot bills by usage (AI credits), and request multipliers no longer determine cost. Instead, each period shows **activity** for information:

- **Chat requests:** prompts you sent in the period, including failed ones (e.g. "Language model unavailable"). Prompts the agent hands to a subagent (`runSubagent-*.jsonl`) are not counted, because you didn't type them. Copilot CLI prompts are counted, and so are prompts recovered from VS Code chat history for chats the debug log never captured.
- **Sessions:** distinct Copilot sessions with at least one chat request or model call in the period. A session that spans two months counts in both.

On real data this matches VS Code's own chat history exactly in total (274 of 274 panel prompts; 71 of 71 Copilot CLI prompts). Per session there are two known differences: a request with empty prompt text (e.g. a continue click), which Copilot doesn't log as a prompt; and an edited-and-resent prompt, which VS Code's history keeps only once.

---

## Worked Examples

### Example 1: Claude Opus 4.6 with heavy caching

**Scenario**: 100,000 input tokens (90,000 cached, 10,000 cache-write) + 5,000 output tokens.

| Bucket | Tokens | Rate (per 1M) | Cost |
|--------|-------:|:-------------:|-----:|
| Uncached input | max(0, 100K?90K?10K) = **0** | $5.00 | **$0.0000** |
| Cached input | **90,000** | $0.50 | **$0.0450** |
| Cache write | **10,000** | $6.25 | **$0.0625** |
| Output | **5,000** | $25.00 | **$0.1250** |
| **Total** | | | **$0.2325** |

AI credits = 0.2325 × 100 = **23.25 credits** (displayed as 23.3)

### Example 2: GPT-5.4 with partial caching

**Scenario**: 50,000 input tokens (30,000 cached, 0 cache-write) + 10,000 output tokens.

| Bucket | Tokens | Rate (per 1M) | Cost |
|--------|-------:|:-------------:|-----:|
| Uncached input | 50K?30K?0 = **20,000** | $2.50 | **$0.0500** |
| Cached input | **30,000** | $0.25 | **$0.0075** |
| Cache write | **0** | $2.50 (fallback) | **$0.0000** |
| Output | **10,000** | $15.00 | **$0.1500** |
| **Total** | | | **$0.2075** |

AI credits = **20.75 credits** (displayed as 20.8)

### Example 3: Claude Sonnet 4 — first request (cache miss)

**Scenario**: 80,000 input tokens + 3,000 output tokens. First request in session ? estimator assigns all input as cache-write.

| Bucket | Tokens | Rate (per 1M) | Cost |
|--------|-------:|:-------------:|-----:|
| Uncached input | 80K?0?80K = **0** | $3.00 | **$0.0000** |
| Cached input | **0** | $0.30 | **$0.0000** |
| Cache write | **80,000** | $3.75 | **$0.3000** |
| Output | **3,000** | $15.00 | **$0.0450** |
| **Total** | | | **$0.3450** |

Compared to if there were no caching at all (all at base rate): 80K×$3.00/1M + 3K×$15.00/1M = $0.285. The cache-write surcharge adds $0.06 (25% of the input cost) to the first request.

### Example 4: Claude Sonnet 4 — second request (cache hit, same session)

**Scenario**: Follow-up request with 95,000 input tokens + 2,000 output. Previous request had 80,000 input.

Estimator computes:
- `cachedTokens = min(80K, 95K) = 80,000`
- `cacheWriteTokens = 95K ? 80K = 15,000` (the new delta)

| Bucket | Tokens | Rate (per 1M) | Cost |
|--------|-------:|:-------------:|-----:|
| Uncached input | 95K?80K?15K = **0** | $3.00 | **$0.0000** |
| Cached input | **80,000** | $0.30 | **$0.0240** |
| Cache write | **15,000** | $3.75 | **$0.0563** |
| Output | **2,000** | $15.00 | **$0.0300** |
| **Total** | | | **$0.1103** |

Savings vs. no caching: 95K×$3.00/1M = $0.285 input alone ? actual input cost is $0.0803 ? **72% savings on input** thanks to the 80K cached portion.

### Example 5: GPT-5 mini — no caching (below threshold)

**Scenario**: 500 input tokens + 200 output tokens. Below the 1,024 minimum cacheable threshold.

| Bucket | Tokens | Rate (per 1M) | Cost |
|--------|-------:|:-------------:|-----:|
| Uncached input | **500** | $0.25 | **$0.000125** |
| Output | **200** | $2.00 | **$0.000400** |
| **Total** | | | **$0.000525** |

AI credits = **0.0525 credits**

---

## Edge Cases and Limitations

### No cached data available

When neither real data nor estimation is possible (e.g., isolated requests with no session context), the cost shown is an **upper bound** — all input tokens are charged at the full base rate with no cache discount. The UI shows: _"Cached/cache-write token counts are not present in the logs; cost shown is an upper bound."_

### Long-context pricing

Models with a long-context tier (see the pricing table) are priced at the long-context rates for the whole request when its prompt exceeds the threshold. Such requests carry the audit flag `long_context_pricing`.

### What list prices don't model

The Auto discount, time-limited promotions and historical price changes aren't modeled; list prices use the current rates. For Copilot this only affects requests without a billed amount (rare in current logs), and for those the list price is usually a slight overestimate. Promotions with a published end date are noted in the table: Gemini 4 Argon / Carbon until 2026-12-01, Gemini 3.8 Flash until 2026-12-31.

### Repricing stored sessions

Session costs are stored. Each one records the `pricing_table_version` and `cost_formula_version` it was computed with, and the next sync recomputes every session stored under an older version from the rows already in the database. That includes Claude sessions whose transcripts have since been deleted.

### Context compaction

When Copilot compacts a conversation (summarizing history to fit in the context window), input tokens can drop significantly. The estimator detects a 30%+ drop from the previous request and treats it as a cache miss, since the compacted summary is entirely new content that won't match any cached prefix.

### Subagent isolation

Each subagent invocation (e.g., the Explore agent) starts a fresh cache scope. The subagent's requests don't benefit from cached content in the parent conversation, and vice versa. Different subagents within the same session also have separate scopes.

### Unknown models

Any model not in the pricing table is charged at default rates ($3.00/$0.30/$3.75/$15.00 per 1M tokens) and flagged `model_unresolved_pricing_fallback`. The default is not reliably conservative: in the old table, Claude Opus 5 was under-reported by 40% and GPT-6 Luna over-reported 23×. When a new model shows up as unresolved, add it to `MODEL_TABLE` using the prices in Copilot's `models.json`.

### Rounding

- Individual request costs are computed at full floating-point precision
- AI credits are rounded to 1 decimal place for display
- USD totals are rounded to the nearest cent: `Math.round(totalCredits) / 100`
- This means the sum of individually displayed credits may differ slightly from the displayed total (due to rounding at different levels)

### Prompt export data coverage

The real cached token data from the prompt export command only covers prompts from the current or recent VS Code sessions. Historical sessions where the export was never run will rely entirely on estimated values. Once exported, the data is persisted in the database and survives VS Code restarts.
