import * as fs from 'fs';
import { LLMRequestRecord, UserMessageRecord } from './types';

// =============================================================================
// VS Code chat history (workspaceStorage/<ws>/chatSessions/<sessionId>.jsonl)
//
// Used ONLY to recover requests the Copilot debug log does not cover: chats from
// before "github.copilot.chat.agentDebugLog.fileLogging.enabled" was turned on,
// or the opening requests of a chat that predates enabling it.
//
// Format facts (verified against real files, chat session format version 3):
//  - The .jsonl file is a mutation log: {kind:0,v} = initial state,
//    {kind:1,k:path,v} = set, {kind:2,k:path,v:items,i?} = splice/append,
//    {kind:3,k:path} = delete. Older builds wrote a single .json state object.
//  - Per request: `copilotCredits` equals the sum of the debug log's
//    copilotUsageNanoAiu for that request's main-agent calls (exact in sessions
//    without subagents); `completionTokens` is the per-request output total; but
//    `promptTokens` is ONLY the final tool-call round's prompt (it matched the last
//    debug-log call exactly), so input tokens recovered here are a LOWER BOUND.
//  - Failed requests carry result.errorDetails and no usage.
// =============================================================================

const PREVIEW_LENGTH = 200;
const MAX_DETAIL = 16000;
/** Audit flag on every recovered record; forces the session's cost state to 'incomplete'. */
export const CHAT_HISTORY_LOWER_BOUND_FLAG = 'chat_history_input_lower_bound';

function cap(s: string): string {
  return s.length > MAX_DETAIL ? s.slice(0, MAX_DETAIL) + `\n…[truncated ${s.length - MAX_DETAIL} chars]` : s;
}

type Json = Record<string, unknown>;

function asObj(v: unknown): Json | undefined {
  return v && typeof v === 'object' && !Array.isArray(v) ? v as Json : undefined;
}
function asNum(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}
function asStr(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

function setAt(root: Json, keys: (string | number)[], value: unknown): void {
  let o: Record<string | number, unknown> = root;
  for (let i = 0; i < keys.length - 1; i++) {
    const k = keys[i];
    if (o[k] === null || typeof o[k] !== 'object') { o[k] = typeof keys[i + 1] === 'number' ? [] : {}; }
    o = o[k] as Record<string | number, unknown>;
  }
  o[keys[keys.length - 1]] = value;
}

function getAt(root: unknown, keys: (string | number)[]): unknown {
  let o: unknown = root;
  for (const k of keys) {
    if (o === null || typeof o !== 'object') { return undefined; }
    o = (o as Record<string | number, unknown>)[k];
  }
  return o;
}

/** Reconstruct the final chat-session state from a chatSessions file, or null. */
export function readChatSessionState(filePath: string): Json | null {
  let raw: string;
  try { raw = fs.readFileSync(filePath, 'utf-8'); } catch { return null; }
  if (filePath.toLowerCase().endsWith('.json')) {
    try { return asObj(JSON.parse(raw)) ?? null; } catch { return null; }
  }
  let state: Json | null = null;
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (!t) { continue; }
    let m: Json;
    try { m = JSON.parse(t) as Json; } catch { continue; }
    const kind = m.kind;
    const keys = Array.isArray(m.k) ? m.k as (string | number)[] : [];
    if (kind === 0) {
      state = asObj(m.v) ?? null;
    } else if (!state || keys.length === 0) {
      continue;
    } else if (kind === 1) {
      setAt(state, keys, m.v);
    } else if (kind === 2) {
      let arr = getAt(state, keys);
      if (!Array.isArray(arr)) { arr = []; setAt(state, keys, arr); }
      const items = Array.isArray(m.v) ? m.v : [];
      const a = arr as unknown[];
      if (typeof m.i === 'number') { a.splice(m.i, a.length - m.i, ...items); } else { a.push(...items); }
    } else if (kind === 3) {
      const parent = getAt(state, keys.slice(0, -1));
      if (parent && typeof parent === 'object') { delete (parent as Record<string | number, unknown>)[keys[keys.length - 1]]; }
    }
  }
  return state;
}

/**
 * The concrete model that served a chat request. `modelId` is the picker
 * selection (often 'copilot/auto'), so prefer what was actually resolved:
 * result.metadata.resolvedModel → last toolCallRounds[].modelId →
 * response[].resolvedModel → modelId without the 'copilot/' vendor prefix.
 */
function resolveChatModel(r: Json, metadata: Json): string {
  const direct = asStr(metadata.resolvedModel);
  if (direct) { return direct; }
  const rounds = Array.isArray(metadata.toolCallRounds) ? metadata.toolCallRounds as unknown[] : [];
  for (let i = rounds.length - 1; i >= 0; i--) {
    const m = asStr(asObj(rounds[i])?.modelId);
    if (m) { return m; }
  }
  const parts = Array.isArray(r.response) ? r.response as unknown[] : [];
  for (const p of parts) {
    const m = asStr(asObj(p)?.resolvedModel);
    if (m) { return m; }
  }
  return (asStr(r.modelId) || '').replace(/^copilot\//, '') || 'unknown';
}

export interface ChatHistoryRecovery {
  llmRequests: LLMRequestRecord[];
  userMessages: UserMessageRecord[];
  /** Earliest / latest request time seen (for session bounds). */
  startTime: number;
  endTime: number;
  /** Number of requests in the chat (all, including failed ones). */
  requestCount: number;
}

/**
 * Turn chat-history requests into records, skipping any request already covered
 * by debug-log calls. A request is covered when at least one debug-log LLM call
 * falls inside its own [timestamp, timestamp + elapsed] span (±1s). On real data
 * this marks exactly the requests made before debug file logging was enabled.
 */
export function recoverFromChatHistory(
  state: Json,
  sessionId: string,
  coveredCallTimestamps: number[],
  coveredMessageTimestamps: number[] = [],
): ChatHistoryRecovery {
  const requests = Array.isArray(state.requests) ? state.requests as unknown[] : [];
  const anyBetween = (sorted: number[]) => (lo: number, hi: number): boolean => {
    // binary search for first timestamp >= lo
    let l = 0, h = sorted.length;
    while (l < h) { const mid = (l + h) >> 1; if (sorted[mid] < lo) { l = mid + 1; } else { h = mid; } }
    return l < sorted.length && sorted[l] <= hi;
  };
  const anyCallBetween = anyBetween([...coveredCallTimestamps].sort((a, b) => a - b));
  const anyMessageBetween = anyBetween([...coveredMessageTimestamps].sort((a, b) => a - b));

  const out: ChatHistoryRecovery = {
    llmRequests: [], userMessages: [], startTime: 0, endTime: 0, requestCount: requests.length,
  };
  const creation = asNum(state.creationDate) ?? 0;
  let minTs = Number.POSITIVE_INFINITY;
  let maxTs = 0;

  requests.forEach((value, index) => {
    const r = asObj(value);
    if (!r) { return; }
    const ts = asNum(r.timestamp) ?? 0;
    const result = asObj(r.result) ?? {};
    const timings = asObj(result.timings) ?? {};
    const metadata = asObj(result.metadata) ?? {};
    let elapsed = asNum(r.elapsedMs) ?? asNum(timings.totalElapsed) ?? 0;
    if (elapsed <= 0) {
      // No duration recorded: extend the coverage window to the next request.
      const next = asObj(requests[index + 1]);
      const nextTs = next ? asNum(next.timestamp) : undefined;
      elapsed = nextTs !== undefined && nextTs > ts ? nextTs - ts : 0;
    }
    if (ts > 0) { minTs = Math.min(minTs, ts); maxTs = Math.max(maxTs, ts + elapsed); }

    const credits = asNum(r.copilotCredits);
    const promptTokens = asNum(r.promptTokens) ?? asNum(metadata.promptTokens) ?? 0;
    const completionTokens = asNum(r.completionTokens) ?? asNum(metadata.outputTokens) ?? 0;
    const hasUsage = (credits ?? 0) > 0 || promptTokens > 0 || completionTokens > 0;
    const requestId = asStr(r.requestId) || `${index}`;
    const message = asObj(r.message);
    const text = asStr(message?.text) ?? '';
    const userSpan = `chat:${requestId}:user`;

    if (!hasUsage) {
      // Failed / cancelled request: no usage to bill, but it is still a chat request
      // the user sent. Keep the prompt unless the debug log already recorded it.
      if (ts > 0 && !anyMessageBetween(ts - 1000, ts + elapsed + 1000)) {
        out.userMessages.push({
          sessionId, spanId: userSpan, timestamp: ts, contentLength: text.length,
          contentPreview: text.substring(0, PREVIEW_LENGTH), contentFull: text ? cap(text) : undefined,
        });
      }
      return;
    }
    if (ts > 0 && anyCallBetween(ts - 1000, ts + elapsed + 1000)) { return; } // debug log has it
    const model = resolveChatModel(r, metadata);
    const err = asObj(result.errorDetails);

    out.userMessages.push({
      sessionId,
      spanId: userSpan,
      timestamp: ts,
      contentLength: text.length,
      contentPreview: text.substring(0, PREVIEW_LENGTH),
      contentFull: text ? cap(text) : undefined,
    });
    out.llmRequests.push({
      sessionId,
      provider: 'copilot',
      spanId: `chat:${requestId}`,
      parentSpanId: userSpan,       // links the call to the prompt that triggered it
      timestamp: ts,
      duration: elapsed,
      model,
      inputTokens: promptTokens,
      outputTokens: completionTokens,
      cachedInputTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: promptTokens + completionTokens,
      ttft: Math.round(asNum(timings.firstProgress) ?? 0),
      maxTokens: 0,
      status: err ? 'error' : 'ok',
      error: err ? asStr(err.message) : undefined,
      isSubagent: false,
      userRequestPreview: text ? text.substring(0, PREVIEW_LENGTH) : undefined,
      inputTokensSource: 'chat_history',
      outputTokensSource: 'chat_history',
      cachedInputTokensSource: 'chat_history',
      cacheWriteTokensSource: 'chat_history',
      reasoningTokensSource: 'missing',
      tokenAuditFlags: [CHAT_HISTORY_LOWER_BOUND_FLAG],
      directCredits: credits !== undefined && credits >= 0 ? credits : undefined,
      directCreditsSource: credits !== undefined && credits >= 0 ? 'chat_history' : undefined,
    });
  });

  out.startTime = Number.isFinite(minTs) ? minTs : creation;
  out.endTime = Math.max(maxTs, out.startTime);
  return out;
}
