import {
  TypedLogEvent,
  SessionStartEvent,
  LLMRequestEvent,
  UserMessageEvent,
  ToolCallEvent,
  AgentResponseEvent,
  SubagentEvent,
  TurnEvent,
  ParsedSession,
  SessionInfo,
  LLMRequestRecord,
  UserMessageRecord,
  ToolCallRecord,
  ModelInfo,
  DiscoveredSession,
} from './types';
import { parseJsonlFile, parseJsonlFileSync } from './logParser';
import { parseModelsJson, getBillingMultiplier } from './modelResolver';

const PREVIEW_LENGTH = 200;
const MAX_DETAIL = 16000; // per-field cap so the DB stays bounded

function cap(s: string): string {
  return s.length > MAX_DETAIL ? s.slice(0, MAX_DETAIL) + `\n…[truncated ${s.length - MAX_DETAIL} chars]` : s;
}

/**
 * Build a fully parsed session from a discovered session on disk.
 */
export async function buildSession(
  discovered: DiscoveredSession,
  parseSubagents: boolean
): Promise<ParsedSession | null> {
  const mainResult = await parseJsonlFile(discovered.mainJsonlPath);
  if (mainResult.events.length === 0) { return null; }

  // Parse models.json if available
  const models: Map<string, ModelInfo> = discovered.modelsJsonPath
    ? parseModelsJson(discovered.modelsJsonPath)
    : new Map();

  // Collect events from main file. The main file's first process epoch keeps raw
  // span ids (namespace ''), so single-epoch sessions are stored exactly as before.
  const collected = collectEvents(
    mainResult.events,
    discovered.sessionId,
    discovered.workspaceId,
    discovered.dirPath,
    models,
    false,
    undefined,
    ''
  );

  // Parse subagent child files if enabled
  if (parseSubagents) {
    for (const childPath of discovered.childJsonlPaths) {
      const subagentName = extractSubagentName(childPath);
      // Skip title/categorization/summarize files (low value)
      if (isHousekeepingFile(childPath)) { continue; }

      try {
        const childResult = parseJsonlFileSync(childPath);
        // Each child file is its own span-counter namespace (it has its own
        // session_start and restarts the counter), so prefix its ids with the
        // file stem to keep them distinct from main-file spans.
        const childCollected = collectEvents(
          childResult.events,
          discovered.sessionId,
          discovered.workspaceId,
          discovered.dirPath,
          models,
          true,
          subagentName,
          childNamespace(childPath)
        );
        collected.llmRequests.push(...childCollected.llmRequests);
        // A child file's user_message is the prompt the agent handed to the
        // subagent, not something the user typed — counting it inflated chat
        // requests (verified: main.jsonl alone matches VS Code's chat history).
        collected.toolCalls.push(...childCollected.toolCalls);
        collected.turnCount += childCollected.turnCount;
        if (subagentName) {
          collected.subagentNames.add(subagentName);
        }
      } catch {
        // Skip unreadable child files
      }
    }
  }

  if (!collected.session) { return null; }

  // Last line of defence for the (session_id, span_id) unique index: namespacing
  // makes ids unique on all observed data, but if a future log format ever repeats
  // an id we disambiguate rather than let INSERT OR REPLACE silently drop a call.
  ensureUniqueSpanIds(collected.llmRequests, discovered.sessionId);

  return {
    session: collected.session,
    llmRequests: collected.llmRequests,
    userMessages: collected.userMessages,
    toolCalls: collected.toolCalls,
    turnCount: collected.turnCount,
    subagentNames: Array.from(collected.subagentNames),
    childSessionFiles: discovered.childJsonlPaths,
    models,
  };
}

interface CollectedData {
  session: SessionInfo | null;
  llmRequests: LLMRequestRecord[];
  userMessages: UserMessageRecord[];
  toolCalls: ToolCallRecord[];
  turnCount: number;
  subagentNames: Set<string>;
}

function collectEvents(
  events: TypedLogEvent[],
  sessionId: string,
  workspaceId: string,
  dirPath: string,
  models: Map<string, ModelInfo>,
  isSubagent: boolean,
  subagentName: string | undefined,
  fileNamespace: string
): CollectedData {
  let session: SessionInfo | null = null;
  const llmRequests: LLMRequestRecord[] = [];
  const userMessages: UserMessageRecord[] = [];
  const toolCalls: ToolCallRecord[] = [];
  let turnCount = 0;
  const subagentNames = new Set<string>();
  let lastTs = 0;
  let lastLlm: LLMRequestRecord | undefined;   // for attaching agent_response output

  // Copilot Chat span ids are per-process counters ("0000000000000010"). When a
  // chat is resumed after a VS Code reload, the extension appends a new
  // session_start and the counter restarts, so distinct calls reuse the same id.
  // Every session_start after the first opens a new "epoch"; ids are namespaced
  // per epoch (and per file), applied identically to spanId AND parentSpanId so
  // tool-call → LLM and message → LLM links stay correct. Verified on real logs:
  // zero duplicate llm_request span ids within an epoch.
  let sessionStarts = 0;
  let epochPrefix = fileNamespace;
  const ns = (id: string | undefined): string | undefined => (id ? epochPrefix + id : id);

  for (const event of events) {
    if (event.ts > lastTs) { lastTs = event.ts; }

    switch (event.type) {
      case 'session_start': {
        const e = event as SessionStartEvent;
        sessionStarts++;
        if (sessionStarts > 1) { epochPrefix = `${fileNamespace}e${sessionStarts - 1}:`; }
        if (!session) {
          session = {
            id: sessionId,
            workspaceId,
            dirPath,
            startTime: e.ts,
            endTime: e.ts,
            copilotVersion: e.attrs.copilotVersion || '',
            vscodeVersion: e.attrs.vscodeVersion || '',
          };
        }
        break;
      }

      case 'llm_request': {
        const e = event as LLMRequestEvent;
        const attrs = e.attrs as Record<string, unknown>;
        const inputTokens = e.attrs.inputTokens ?? 0;
        const outputTokens = e.attrs.outputTokens ?? 0;
        // Copilot Chat writes cached prompt tokens as `cachedTokens`; the OTel
        // path and older builds use `cachedInputTokens`. Accept either.
        const cachedInputTokens = (attrs.cachedInputTokens as number | undefined)
          ?? (attrs.cachedTokens as number | undefined) ?? 0;
        const cacheWriteTokens = e.attrs.cacheWriteTokens ?? 0;
        const hasCachedInputTokens = Object.prototype.hasOwnProperty.call(attrs, 'cachedInputTokens')
          || Object.prototype.hasOwnProperty.call(attrs, 'cachedTokens');
        const hasCacheWriteTokens = Object.prototype.hasOwnProperty.call(attrs, 'cacheWriteTokens');

        // Check for direct credit cost reported by the API (post-June 2026 billing).
        // copilotUsageNanoAiu is the authoritative field: 1,000,000,000 nanoAIU = 1 credit = $0.01.
        let directCredits: number | undefined;
        if (typeof e.attrs.copilotUsageNanoAiu === 'number' && e.attrs.copilotUsageNanoAiu >= 0) {
          directCredits = e.attrs.copilotUsageNanoAiu / 1_000_000_000;
        } else {
          // Fallback to generic credit keys (future-proofing for API changes).
          const raw = e.attrs.credits ?? e.attrs.aiCredits ?? e.attrs.requestCredits
            ?? (attrs['gen_ai.usage.credits'] as number | undefined)
            ?? (attrs['billing.credits'] as number | undefined);
          directCredits = typeof raw === 'number' && raw >= 0 ? raw : undefined;
        }

        llmRequests.push({
          sessionId,
          spanId: ns(e.spanId) as string,
          parentSpanId: ns(e.parentSpanId),
          timestamp: e.ts,
          duration: e.dur,
          model: e.attrs.model || 'unknown',
          inputTokens,
          outputTokens,
          cachedInputTokens,
          cacheWriteTokens,
          totalTokens: inputTokens + outputTokens,
          ttft: e.attrs.ttft ?? 0,
          maxTokens: e.attrs.maxTokens ?? 0,
          status: e.status,
          error: e.attrs.error,
          isSubagent,
          subagentName,
          userRequestPreview: e.attrs.userRequest
            ? e.attrs.userRequest.substring(0, PREVIEW_LENGTH)
            : undefined,
          inputTokensSource: 'jsonl',
          outputTokensSource: 'jsonl',
          cachedInputTokensSource: hasCachedInputTokens ? 'jsonl' : 'missing',
          cacheWriteTokensSource: hasCacheWriteTokens ? 'jsonl' : 'missing',
          reasoningTokensSource: 'missing',
          tokenAuditFlags: hasCachedInputTokens ? [] : ['cached_tokens_missing_jsonl'],
          directCredits,
          directCreditsSource: directCredits !== undefined ? 'jsonl' : undefined,
        });
        lastLlm = llmRequests[llmRequests.length - 1];
        break;
      }

      case 'user_message': {
        const e = event as UserMessageEvent;
        const content = e.attrs.content || '';
        userMessages.push({
          sessionId,
          spanId: ns(e.spanId) as string,
          timestamp: e.ts,
          contentLength: content.length,
          contentPreview: content.substring(0, PREVIEW_LENGTH),
          contentFull: content ? cap(content) : undefined,
        });
        break;
      }

      case 'tool_call': {
        const e = event as ToolCallEvent;
        toolCalls.push({
          sessionId,
          spanId: ns(e.spanId) as string,
          parentSpanId: ns(e.parentSpanId),
          timestamp: e.ts,
          duration: e.dur,
          toolName: e.name,
          status: e.status,
          isSubagent,
          args: e.attrs.args ? cap(String(e.attrs.args)) : undefined,
          result: e.attrs.result ? cap(String(e.attrs.result)) : undefined,
          errorText: e.attrs.error ? cap(String(e.attrs.error)) : undefined,
        });
        break;
      }

      case 'agent_response': {
        // Attach the assistant's generated text/reasoning to the most recent LLM request.
        const e = event as AgentResponseEvent;
        if (lastLlm) {
          if (e.attrs.response) { lastLlm.outputText = cap(String(e.attrs.response)); }
          if (e.attrs.reasoning) { lastLlm.reasoningText = cap(String(e.attrs.reasoning)); }
        }
        break;
      }

      case 'subagent': {
        const e = event as SubagentEvent;
        if (e.attrs.agentName) {
          subagentNames.add(e.attrs.agentName);
        }
        break;
      }

      case 'turn_start':
        turnCount++;
        break;
    }
  }

  // Update session endTime
  if (session && lastTs > session.endTime) {
    session.endTime = lastTs;
  }

  return { session, llmRequests, userMessages, toolCalls, turnCount, subagentNames };
}

/** Span-id namespace for a child (subagent) file: its file stem plus ':'. */
function childNamespace(filePath: string): string {
  const filename = filePath.split(/[\\/]/).pop() || '';
  return filename.replace(/\.jsonl$/i, '') + ':';
}

/**
 * Guarantee span ids are unique within a session so the DB's
 * (session_id, span_id) unique index can never drop a distinct call. Collisions
 * are suffixed with the call timestamp (and an ordinal if that still collides).
 * Returns the number of ids that had to be rewritten (0 on all observed data).
 */
export function ensureUniqueSpanIds(requests: LLMRequestRecord[], sessionId: string): number {
  const seen = new Set<string>();
  let rewritten = 0;
  for (const r of requests) {
    if (!r.spanId) { continue; }
    if (!seen.has(r.spanId)) { seen.add(r.spanId); continue; }
    let candidate = `${r.spanId}#${r.timestamp}`;
    for (let n = 2; seen.has(candidate); n++) { candidate = `${r.spanId}#${r.timestamp}#${n}`; }
    r.spanId = candidate;
    seen.add(candidate);
    rewritten++;
  }
  if (rewritten > 0) {
    console.warn(`[AIUsageTracker] ${sessionId}: disambiguated ${rewritten} colliding LLM span id(s)`);
  }
  return rewritten;
}

function extractSubagentName(filePath: string): string | undefined {
  const filename = filePath.split(/[\\/]/).pop() || '';
  // runSubagent-<agentName>-<uuid>.jsonl
  const match = filename.match(/^runSubagent-(.+?)-[0-9a-f-]+\.jsonl$/i);
  return match ? match[1] : undefined;
}

function isHousekeepingFile(filePath: string): boolean {
  const filename = filePath.split(/[\\/]/).pop() || '';
  return (
    filename.startsWith('title-') ||
    filename.startsWith('categorization-') ||
    filename.startsWith('summarize-')
  );
}
