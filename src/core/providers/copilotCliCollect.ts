import * as fs from 'fs';
import {
  ParsedSession,
  SessionInfo,
  LLMRequestRecord,
  UserMessageRecord,
  ToolCallRecord,
  ModelInfo,
} from '../types';

// =============================================================================
// Copilot CLI events.jsonl → ParsedSession
//
// Format facts this parser relies on (verified against real session-state files,
// Copilot CLI 1.0.10x, Nov 2026):
//  - Envelope: { type, data, id, timestamp (ISO), parentId }. `parentId` is the
//    previous event in the stream, NOT a semantic parent, so it is not mapped.
//  - `session.usage_record` = one billed model call. `usage.inputTokens` is
//    INCLUSIVE of cacheReadTokens + cacheWriteTokens (true for every record seen),
//    which matches the shared cost engine's convention.
//  - `usage.copilotUsage.totalNanoAiu` is PER CALL (not cumulative):
//    1e9 nanoAIU = 1 AI credit. Summing records reproduces usage_checkpoint totals.
//  - `session.compaction_complete.compactionTokensUsed` is a billed call that has
//    NO usage_record. (The CLI's own usage_checkpoint adds it twice; the event
//    itself reports requestCount 1 with self-consistent pricing, so we count once.)
//  - `model.model_call_success` = auxiliary calls (e.g. gpt-5.4-nano, 0 nanoAIU)
//    that also have no usage_record; never overlaps a usage_record.
//  - Forked / continued sessions start with a COPY of the parent's events (same
//    ids, original timestamps, all earlier than this session's startTime). Those
//    belong to the parent session and are skipped here to avoid double counting.
// =============================================================================

const PREVIEW_LENGTH = 200;
const MAX_DETAIL = 16000;
const NANO_AIU_PER_CREDIT = 1_000_000_000;

function cap(s: string): string {
  return s.length > MAX_DETAIL ? s.slice(0, MAX_DETAIL) + `\n…[truncated ${s.length - MAX_DETAIL} chars]` : s;
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

function obj(v: unknown): Record<string, unknown> | undefined {
  return v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : undefined;
}

function tsMs(iso: unknown): number {
  if (typeof iso !== 'string') { return 0; }
  const n = Date.parse(iso);
  return Number.isNaN(n) ? 0 : n;
}

function stringify(v: unknown): string {
  if (typeof v === 'string') { return v; }
  try { return JSON.stringify(v, null, 2); } catch { return String(v); }
}

function creditsFromNano(nano: number | undefined): number | undefined {
  return nano !== undefined && nano >= 0 ? nano / NANO_AIU_PER_CREDIT : undefined;
}

interface CliEvent {
  type?: string;
  id?: string;
  timestamp?: string;
  data?: Record<string, unknown>;
}

export interface CopilotCliParseStats {
  /** Events skipped because they were inherited from a parent (forked) session. */
  inheritedEvents: number;
  /** Lines that were not valid JSON. */
  parseErrors: number;
}

export function readCliEvents(filePath: string): { events: CliEvent[]; parseErrors: number } {
  let raw: string;
  try { raw = fs.readFileSync(filePath, 'utf-8'); } catch { return { events: [], parseErrors: 0 }; }
  const events: CliEvent[] = [];
  let parseErrors = 0;
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (!t) { continue; }
    try { events.push(JSON.parse(t) as CliEvent); } catch { parseErrors++; }
  }
  return { events, parseErrors };
}

function baseRecord(sessionId: string): Pick<LLMRequestRecord,
  'sessionId' | 'provider' | 'parentSpanId' | 'isSubagent' | 'status' |
  'inputTokensSource' | 'outputTokensSource' | 'cachedInputTokensSource' |
  'cacheWriteTokensSource' | 'reasoningTokensSource'> {
  return {
    sessionId,
    provider: 'copilot',
    parentSpanId: undefined,
    isSubagent: false,   // the CLI reports a single 'main' agent (agentMetrics)
    status: 'ok',
    // Every bucket is measured by the CLI — 'jsonl' marks them as measured so the
    // cache estimator leaves them alone.
    inputTokensSource: 'jsonl',
    outputTokensSource: 'jsonl',
    cachedInputTokensSource: 'jsonl',
    cacheWriteTokensSource: 'jsonl',
    reasoningTokensSource: 'jsonl',
  };
}

/**
 * Collect one Copilot CLI events.jsonl into a ParsedSession. Pure function of the
 * events (no I/O) so it can be verified independently.
 */
export function collectCopilotCliEvents(
  events: CliEvent[],
  sessionId: string,
  workspaceId: string,
  dirPath: string,
): { parsed: ParsedSession | null; stats: CopilotCliParseStats } {
  const stats: CopilotCliParseStats = { inheritedEvents: 0, parseErrors: 0 };
  const startEvent = events.find(e => e.type === 'session.start');
  const startData = obj(startEvent?.data);
  // Ownership boundary: events stamped before this session's own start were
  // copied from the parent session. Without a session.start, keep everything.
  const ownStart = tsMs(startData?.startTime) || tsMs(startEvent?.timestamp);
  const context = obj(startData?.context);

  const llmRequests: LLMRequestRecord[] = [];
  const userMessages: UserMessageRecord[] = [];
  const toolCalls: ToolCallRecord[] = [];
  const toolStarts = new Map<string, { ts: number; name: string; args?: string }>();
  const seenEventIds = new Set<string>();
  const seenSpanIds = new Set<string>();
  let turnCount = 0;
  let minTs = Number.POSITIVE_INFINITY;
  let maxTs = 0;

  const pushLlm = (r: LLMRequestRecord): void => {
    if (seenSpanIds.has(r.spanId)) { return; }  // belt-and-braces: never double count
    seenSpanIds.add(r.spanId);
    llmRequests.push(r);
  };

  for (const e of events) {
    const ts = tsMs(e.timestamp);
    if (ownStart > 0 && ts > 0 && ts < ownStart) { stats.inheritedEvents++; continue; }
    if (e.id) {
      if (seenEventIds.has(e.id)) { continue; }
      seenEventIds.add(e.id);
    }
    if (ts > 0) { if (ts < minTs) { minTs = ts; } if (ts > maxTs) { maxTs = ts; } }
    const d = obj(e.data) ?? {};

    switch (e.type) {
      case 'session.usage_record': {
        const u = obj(d.usage);
        if (!u) { break; }
        const inputTokens = num(u.inputTokens) ?? 0;
        const outputTokens = num(u.outputTokens) ?? 0;
        const copilotUsage = obj(u.copilotUsage);
        const directCredits = creditsFromNano(num(copilotUsage?.totalNanoAiu));
        const spanId = str(u.apiCallId) || str(u.serviceRequestId) || e.id || `usage@${ts}`;
        const flags: string[] = [];
        if (u.isAuto === true) { flags.push('cli_auto_model'); }
        pushLlm({
          ...baseRecord(sessionId),
          spanId,
          timestamp: ts,
          duration: num(u.duration) ?? 0,
          model: str(u.model) || 'unknown',
          inputTokens,
          outputTokens,
          cachedInputTokens: num(u.cacheReadTokens) ?? 0,
          cacheWriteTokens: num(u.cacheWriteTokens) ?? 0,
          totalTokens: inputTokens + outputTokens,
          ttft: Math.round(num(u.timeToFirstTokenMs) ?? 0),
          maxTokens: num(u.maxOutputTokens) ?? 0,
          reasoningTokens: num(u.reasoningTokens) ?? 0,
          tokenAuditFlags: flags,
          directCredits,
          directCreditsSource: directCredits !== undefined ? 'jsonl' : undefined,
        });
        break;
      }

      case 'session.compaction_complete': {
        const c = obj(d.compactionTokensUsed);
        if (!c) { break; }
        const inputTokens = num(c.inputTokens) ?? 0;
        const outputTokens = num(c.outputTokens) ?? 0;
        const directCredits = creditsFromNano(num(obj(c.copilotUsage)?.totalNanoAiu));
        pushLlm({
          ...baseRecord(sessionId),
          spanId: 'compaction:' + (str(d.compactionAttemptId) || e.id || String(ts)),
          timestamp: ts,
          duration: num(c.duration) ?? 0,
          model: str(c.model) || str(d.behaviorModelId) || 'unknown',
          inputTokens,
          outputTokens,
          cachedInputTokens: num(c.cacheReadTokens) ?? 0,
          cacheWriteTokens: num(c.cacheWriteTokens) ?? 0,
          totalTokens: inputTokens + outputTokens,
          ttft: 0,
          maxTokens: 0,
          reasoningTokens: 0,
          tokenAuditFlags: ['cli_compaction_call'],
          directCredits,
          directCreditsSource: directCredits !== undefined ? 'jsonl' : undefined,
        });
        break;
      }

      case 'model.model_call_success': {
        const ru = obj(d.responseUsage);
        if (!ru) { break; }
        // OpenAI-shaped usage: prompt_tokens already includes cached tokens.
        const inputTokens = num(ru.prompt_tokens) ?? 0;
        const outputTokens = num(ru.completion_tokens) ?? 0;
        const promptDetails = obj(ru.prompt_tokens_details);
        const directCredits = creditsFromNano(num(obj(d.copilotUsage)?.total_nano_aiu));
        pushLlm({
          ...baseRecord(sessionId),
          spanId: 'model:' + (str(d.callId) || e.id || String(ts)),
          timestamp: ts,
          duration: num(d.modelCallDurationMs) ?? 0,
          model: str(obj(d.modelCall)?.model) || 'unknown',
          inputTokens,
          outputTokens,
          cachedInputTokens: num(promptDetails?.cached_tokens) ?? 0,
          cacheWriteTokens: num(promptDetails?.cache_creation_tokens) ?? num(promptDetails?.cache_write_tokens) ?? 0,
          totalTokens: inputTokens + outputTokens,
          ttft: Math.round(num(d.ttftMs) ?? 0),
          maxTokens: num(d.maxOutputTokens) ?? 0,
          reasoningTokens: num(obj(ru.completion_tokens_details)?.reasoning_tokens) ?? 0,
          tokenAuditFlags: ['cli_auxiliary_model_call'],
          directCredits,
          directCreditsSource: directCredits !== undefined ? 'jsonl' : undefined,
        });
        break;
      }

      case 'user.message': {
        const content = str(d.content) ?? '';
        userMessages.push({
          sessionId,
          spanId: e.id || `user@${ts}`,
          timestamp: ts,
          contentLength: content.length,
          contentPreview: content.substring(0, PREVIEW_LENGTH),
          contentFull: content ? cap(content) : undefined,
        });
        break;
      }

      case 'assistant.turn_start':
        turnCount++;
        break;

      case 'tool.execution_start': {
        const id = str(d.toolCallId);
        if (!id) { break; }
        toolStarts.set(id, {
          ts,
          name: str(d.toolName) || 'unknown',
          args: d.arguments !== undefined ? cap(stringify(d.arguments)) : undefined,
        });
        break;
      }

      case 'tool.execution_complete': {
        const id = str(d.toolCallId);
        if (!id) { break; }
        const start = toolStarts.get(id);
        toolStarts.delete(id);
        const result = obj(d.result);
        const err = obj(d.error);
        const ok = d.success !== false && !err;
        toolCalls.push({
          sessionId,
          spanId: id,
          parentSpanId: undefined,
          timestamp: start?.ts ?? ts,
          duration: start ? Math.max(0, ts - start.ts) : 0,
          toolName: start?.name || 'unknown',
          status: ok ? 'ok' : 'error',
          isSubagent: false,
          toolCallId: id,
          args: start?.args,
          result: result && result.content !== undefined ? cap(stringify(result.content)) : undefined,
          errorText: err ? cap(str(err.message) || stringify(err)) : undefined,
        });
        break;
      }
    }
  }

  // Tools that started but never completed (session ended / was interrupted).
  for (const [id, s] of toolStarts) {
    toolCalls.push({
      sessionId, spanId: id, parentSpanId: undefined, timestamp: s.ts, duration: 0,
      toolName: s.name, status: 'error', isSubagent: false, toolCallId: id, args: s.args,
      errorText: 'tool did not complete',
    });
  }

  llmRequests.sort((a, b) => a.timestamp - b.timestamp);
  userMessages.sort((a, b) => a.timestamp - b.timestamp);
  toolCalls.sort((a, b) => a.timestamp - b.timestamp);

  // A session with nothing of its own (e.g. a fork that never ran a turn).
  if (!Number.isFinite(minTs) && llmRequests.length === 0) {
    return { parsed: null, stats };
  }

  const session: SessionInfo = {
    id: sessionId,
    workspaceId,
    dirPath,
    startTime: ownStart || (Number.isFinite(minTs) ? minTs : 0),
    endTime: maxTs,
    copilotVersion: str(startData?.copilotVersion) || '',
    vscodeVersion: '',
    provider: 'copilot',
    repository: str(context?.repository),
    branch: str(context?.branch),
    cwd: str(context?.cwd),
    agentName: 'Copilot CLI',
    dataSource: 'jsonl',
  };

  return {
    parsed: {
      session,
      llmRequests,
      userMessages,
      toolCalls,
      turnCount,
      subagentNames: [],
      childSessionFiles: [],
      models: new Map<string, ModelInfo>(),
    },
    stats,
  };
}
