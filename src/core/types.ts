// ---------------------------------------------------------------------------
// Core types for Copilot Usage Tracker
// ---------------------------------------------------------------------------

/** Raw JSONL event — every line in main.jsonl has at least these fields */
export interface RawLogEvent {
  v?: number;
  ts: number;
  dur: number;
  sid: string;
  type: string;
  name: string;
  spanId: string;
  parentSpanId?: string;
  status: 'ok' | 'error';
  attrs: Record<string, unknown>;
}

// ---- Typed event variants -------------------------------------------------

export interface SessionStartEvent extends RawLogEvent {
  type: 'session_start';
  attrs: {
    copilotVersion: string;
    vscodeVersion: string;
  };
}

export interface LLMRequestEvent extends RawLogEvent {
  type: 'llm_request';
  attrs: {
    model: string;
    inputTokens: number;
    outputTokens: number;
    /** Cached prompt tokens. Copilot Chat emits this as `cachedTokens`; the OTel
     *  path / older builds use `cachedInputTokens`. The parser accepts either. */
    cachedInputTokens?: number;
    cachedTokens?: number;
    cacheWriteTokens?: number;
    ttft?: number;
    maxTokens?: number;
    temperature?: number;
    topP?: number;
    systemPromptFile?: string;
    toolsFile?: string;
    userRequest?: string;
    inputMessages?: string;
    error?: string;
    // Direct credit cost fields (added by Copilot API after June 2026 billing change).
    // copilotUsageNanoAiu: cost in nano-AI-Units (1,000,000,000 nanoAIU = 1 credit = $0.01 USD).
    copilotUsageNanoAiu?: number;
    // Fallback keys for future API versions.
    credits?: number;
    aiCredits?: number;
    requestCredits?: number;
  };
}

export interface UserMessageEvent extends RawLogEvent {
  type: 'user_message';
  attrs: {
    content: string;
  };
}

export interface ToolCallEvent extends RawLogEvent {
  type: 'tool_call';
  attrs: {
    args?: string;
    result?: string;
    error?: string;
  };
}

export interface AgentResponseEvent extends RawLogEvent {
  type: 'agent_response';
  attrs: {
    response?: string;
    reasoning?: string;
  };
}

export interface SubagentEvent extends RawLogEvent {
  type: 'subagent';
  attrs: {
    agentName: string;
    description?: string;
    error?: string;
  };
}

export interface TurnEvent extends RawLogEvent {
  type: 'turn_start' | 'turn_end';
  attrs: {
    turnId: string;
  };
}

export interface DiscoveryEvent extends RawLogEvent {
  type: 'discovery';
  attrs: {
    details: string;
    category: string;
    source: string;
  };
}

export interface ChildSessionRefEvent extends RawLogEvent {
  type: 'generic';
  name: 'child_session_ref';
  attrs: {
    file: string;
    [key: string]: unknown;
  };
}

export type TypedLogEvent =
  | SessionStartEvent
  | LLMRequestEvent
  | UserMessageEvent
  | ToolCallEvent
  | AgentResponseEvent
  | SubagentEvent
  | TurnEvent
  | DiscoveryEvent
  | ChildSessionRefEvent
  | RawLogEvent;

// ---- Domain models --------------------------------------------------------

export interface ModelInfo {
  id: string;
  name: string;
  vendor: string;
  billingMultiplier: number;
  isPremium: boolean;
  maxContextTokens: number;
  maxOutputTokens: number;
}

/**
 * 'chat_history' = recovered from VS Code chat history (chatSessions) for requests
 * with no debug-log coverage. Credits and output totals are per-request, but
 * input tokens are only the FINAL tool-call round (a lower bound) and there is no
 * cache breakdown. Treated as unmeasured for cache purposes.
 */
export type TokenDataSource = 'otel' | 'jsonl' | 'prompt_export' | 'estimated' | 'missing' | 'unknown' | 'chat_history';
export type CostAuditState = 'measured' | 'estimated' | 'mixed' | 'incomplete';

/**
 * Telemetry provider a session/record originated from. Orthogonal to
 * `dataSource` (which is ingest fidelity: otel|jsonl|hybrid). Writers default
 * a missing value to 'copilot' so existing rows and Copilot code paths are
 * unaffected. NOTE: model id is NOT a reliable provider discriminator —
 * Copilot Chat can itself run Claude models — so all provider-sensitive
 * logic (pricing table, billing, queries) must key off this field, never
 * off the model string. See CLAUDE-PROVIDER-PLAN.md §15.
 */
export type ProviderId = 'copilot' | 'claude';

export interface SessionInfo {
  id: string;
  workspaceId: string;
  dirPath: string;
  startTime: number;
  endTime: number;
  copilotVersion: string;
  vscodeVersion: string;
  // Telemetry provider (defaults to 'copilot' when absent).
  provider?: ProviderId;
  // OTel-sourced fields
  repository?: string;
  branch?: string;
  cwd?: string;
  agentName?: string;
  agentDescription?: string;
  dataSource?: 'otel' | 'jsonl' | 'hybrid';
}

export interface LLMRequestRecord {
  sessionId: string;
  // Denormalized provider tag (defaults to 'copilot') so the hot timestamp-scan
  // aggregates can filter on lr.provider without a sessions JOIN.
  provider?: ProviderId;
  spanId: string;
  parentSpanId?: string;
  timestamp: number;
  duration: number;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  cacheWriteTokens: number;
  /** Subset of cacheWriteTokens written with a 1-hour TTL (Anthropic), billed at
   *  2x base input vs the 5-minute rate (1.25x). 0/undefined for providers/models
   *  that don't report the ephemeral_1h breakdown (e.g. all Copilot rows). */
  cacheWrite1hTokens?: number;
  totalTokens: number;
  ttft: number;
  maxTokens: number;
  status: 'ok' | 'error';
  error?: string;
  isSubagent: boolean;
  subagentName?: string;
  userRequestPreview?: string;
  // OTel-sourced fields
  reasoningTokens?: number;
  responseModel?: string;
  traceId?: string;
  conversationId?: string;
  inputTokensSource?: TokenDataSource;
  outputTokensSource?: TokenDataSource;
  cachedInputTokensSource?: TokenDataSource;
  cacheWriteTokensSource?: TokenDataSource;
  reasoningTokensSource?: TokenDataSource;
  promptExportKey?: string;
  cacheMatchConfidence?: number;
  tokenAuditFlags?: string[];
  // Direct credits reported by the API (1 credit = $0.01 USD).
  // When present, this supersedes the token-based cost formula for this request.
  directCredits?: number;
  directCreditsSource?: TokenDataSource;
  // Rich-detail capture (capped): the assistant's generated output text and its
  // thinking/reasoning text for this request/turn.
  outputText?: string;
  reasoningText?: string;
}

export interface UserMessageRecord {
  sessionId: string;
  spanId: string;
  timestamp: number;
  contentLength: number;
  contentPreview: string;
  /** Full message text (capped). Captured when rich-detail capture is on. */
  contentFull?: string;
}

export interface ToolCallRecord {
  sessionId: string;
  spanId: string;
  parentSpanId?: string;
  timestamp: number;
  duration: number;
  toolName: string;
  status: 'ok' | 'error';
  isSubagent: boolean;
  // OTel-sourced fields
  toolType?: string;
  toolCallId?: string;
  // Rich-detail capture (capped): the tool input (command/script/file edit),
  // its output/result, and any error text.
  args?: string;
  result?: string;
  errorText?: string;
}

export interface SessionStats {
  sessionId: string;
  provider?: ProviderId;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalTokens: number;
  /** Estimated USD cost under the new (Jun 1, 2026+) per-token billing. */
  costUSD: number;
  llmRequestCount: number;
  userMessageCount: number;
  toolCallCount: number;
  errorCount: number;
  turnCount: number;
  subagentCount: number;
  avgTokensPerRequest: number;
  avgTtft: number;
  durationMs: number;
  modelsUsed: string[];
  dominantModel: string;
  efficiencyScore: number;
  reworkScore: number;
  // OTel-sourced aggregates
  totalReasoningTokens?: number;
  totalCachedTokens?: number;
  totalCacheWriteTokens?: number;
  dataSource?: 'otel' | 'jsonl' | 'hybrid';
  costAuditState?: CostAuditState;
  costAuditFlags?: string[];
  pricingTableVersion?: number;
  costFormulaVersion?: number;
}

// ---- Parsed session bundle ------------------------------------------------

export interface ParsedSession {
  session: SessionInfo;
  llmRequests: LLMRequestRecord[];
  userMessages: UserMessageRecord[];
  toolCalls: ToolCallRecord[];
  turnCount: number;
  subagentNames: string[];
  childSessionFiles: string[];
  models: Map<string, ModelInfo>;
}

// ---- Discovery types ------------------------------------------------------

/**
 * Which on-disk artifact a discovered session comes from. Absent = the provider's
 * primary format (Copilot debug-log main.jsonl, Claude transcript).
 *  - 'copilot-cli'  : ~/.copilot/session-state/<id>/events.jsonl
 *  - 'chat-history' : VS Code chatSessions/<id>.jsonl (fallback when no debug-log
 *                     usage exists; token counts are a lower bound)
 */
export type SessionSourceKind = 'debug-log' | 'copilot-cli' | 'chat-history';

export interface DiscoveredSession {
  sessionId: string;
  provider?: ProviderId;
  sourceKind?: SessionSourceKind;
  /** VS Code chat-history file for the same session id, when one exists. */
  chatHistoryPath?: string;
  dirPath: string;
  workspaceId: string;
  mainJsonlPath: string;
  modelsJsonPath?: string;
  childJsonlPaths: string[];
  mtimeMs: number;
}

// ---- Stats aggregates for UI ----------------------------------------------

export interface AggregateStats {
  totalSessions: number;
  totalTokens: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  /** Sum of estimated USD cost under the new per-token billing. */
  totalCostUSD: number;
  totalRequests: number;
  totalMessages: number;
  totalToolCalls: number;
  totalErrors: number;
  avgTokensPerSession: number;
  avgTokensPerRequest: number;
  avgRequestsPerSession: number;
}

export interface DailyStats {
  date: string; // YYYY-MM-DD (UTC)
  sessions: number;
  totalTokens: number;
  costUSD: number;
  requests: number;
}

export interface ModelStats {
  model: string;
  totalTokens: number;
  costUSD: number;
  requestCount: number;
}

// ---- Webview message protocol ---------------------------------------------

export type WebviewMessage =
  | { type: 'requestOverview' }
  | { type: 'requestSessions'; groupBy: string; dateFrom?: string; dateTo?: string }
  | { type: 'requestSessionDetail'; sessionId: string }
  | { type: 'requestBilling'; periodStart: number; periodEnd: number; periodLabel: string }
  | { type: 'requestTrends'; period: 'daily' | 'weekly' | 'monthly' }
  | { type: 'setProvider'; provider: ProviderId }
  | { type: 'refresh' };

export type ExtensionMessage =
  | { type: 'overview'; data: OverviewData }
  | { type: 'sessions'; data: SessionListData }
  | { type: 'sessionDetail'; data: SessionDetailData }
  | { type: 'billingStatus'; data: NonNullable<OverviewData['billing']> & { modelStats?: ModelStats[]; workflow?: OverviewData['workflow'] } }
  | { type: 'claudeBilling'; data: ClaudeBillingData & { modelStats?: ModelStats[]; workflow?: OverviewData['workflow'] } }
  | { type: 'trends'; data: TrendData }
  | { type: 'error'; message: string };

/** Provider-specific billing view for Claude — USD + token totals, no credits/premium-requests. */
export interface ClaudeBillingData {
  provider: 'claude';
  periodLabel: string;
  isHistoricalPeriod: boolean;
  costBasis: 'api' | 'subscription';
  costUSD: number;
  tokenTotals: { input: number; output: number; cachedInput: number; cacheWrite: number };
  perModel: { model: string; inputTokens: number; outputTokens: number; costUSD: number }[];
  notes: string[];
}

export interface OverviewData {
  provider: ProviderId;
  aggregate: AggregateStats;
  dailyStats: DailyStats[];
  modelStats: ModelStats[];
  topSessions: (SessionStats & { startTime: number })[];
  availableMonths: { year: number; month: number; label: string; start: number; end: number }[];
  /** Claude-provider billing view (present only when provider==='claude'). */
  claudeBilling?: ClaudeBillingData;
  billing?: {
    periodLabel: string;
    isHistoricalPeriod: boolean;
    plan: string;
    daysRemaining: number;
    notes: string[];
    /** Activity in the period (informational, not billing). */
    activity: { sessions: number; chatRequests: number };
    new: {
      used: number;
      quota: number | null;
      quotaIsPromotional: boolean;
      pct: number | null;
      costUSD: number;
      cachedTokensCaptured: boolean;
      cachedTokensEstimated: boolean;
      breakdown: { model: string; inputTokens: number; outputTokens: number; credits: number }[];
    };
  };
  workflow?: { toolCalls: number; subagents: number; turns: number; errors: number; turnsPerMsg: number; toolsPerTurn: number };
}

export interface SessionListData {
  sessions: (SessionInfo & SessionStats)[];
  groupBy: string;
}

export interface SessionDetailData {
  session: SessionInfo;
  stats: SessionStats;
  requests: LLMRequestRecord[];
  messages: UserMessageRecord[];
  toolCalls?: ToolCallRecord[];
  analytics?: SessionAnalytics;
}

export interface SessionAnalytics {
  // Token efficiency
  inputOutputRatio: number;       // input / output — high = context heavy
  tokensPerMessage: number;       // total tokens / user messages
  wastedTokens: number;           // tokens burned on failed requests
  wastedPct: number;              // % of total tokens wasted

  // Performance
  avgTtft: number;                // avg ms to first token
  p90Ttft: number;                // 90th percentile TTFT
  avgRequestDuration: number;     // avg ms per LLM request

  // Workflow
  turnsPerMessage: number;        // turns / user messages
  toolsPerTurn: number;           // tool calls / turns
  errorRate: number;              // % failed (tools + requests)
  uniqueTools: number;            // distinct tools invoked
  topTools: { name: string; count: number; avgMs: number; errors: number }[];

  // Cost decomposition
  directTokens: number;           // tokens from direct (non-subagent) requests
  subagentTokens: number;         // tokens from subagent requests
  subagentPct: number;            // % tokens consumed by subagents
  estimatedCredits: number;       // AI credits for this session (new billing)

  // Model breakdown
  modelBreakdown: { model: string; requests: number; tokens: number; pct: number; reasoningTokens: number; cachedTokens: number }[];

  // Timeline
  activeMinutes: number;          // first to last event span
  tokensPerMinute: number;        // throughput
  avgThinkTime: number;           // avg gap between user messages (seconds)

  // Optimization signals
  signals: string[];              // actionable suggestions

  // Deep workflow insights
  insights?: WorkflowInsights;

  // Reasoning analysis (OTel-sourced)
  totalReasoningTokens: number;   // total reasoning/thinking tokens across all requests
  reasoningPct: number;           // reasoning / output tokens * 100 — how much was "thinking"
  reasoningCostUSD: number;       // portion of output cost attributable to reasoning

  // Cache analysis
  totalCachedTokens: number;      // total cached input tokens (real from OTel, estimated from JSONL)
  cacheHitRate: number;           // cached / total input * 100
  cacheSavingsUSD: number;        // money saved by cache hits vs full input price
  dataConfidence: 'measured' | 'estimated' | 'mixed'; // OTel = measured, JSONL = estimated

  // Model routing
  modelMismatches: number;        // requests where response model != request model
}

export interface WorkflowInsights {
  // Tool taxonomy
  explorationCalls: number;        // read/search tool calls
  productionCalls: number;         // edit/create/run tool calls
  metaCalls: number;               // todo, memory, subagent, askQuestions
  explorationPct: number;          // exploration / (exploration + production + meta)
  explorationTokens: number;       // tokens consumed in non-productive turns
  productionTokens: number;        // tokens consumed in productive turns

  // Context dynamics
  avgContextGrowthPerTurn: number; // avg input token increase per turn
  maxContextReached: number;       // peak input tokens
  contextUtilizationPct: number;   // peak / model max %
  contextSaturationTurn: number;   // turn where context > 80% capacity (0 = never)

  // Stall detection (3+ consecutive non-productive turns)
  stallSequences: number;
  longestStall: number;
  stallTokens: number;

  // Cost shape
  bloatRatio: number;              // 2nd half cost / 1st half cost (1.0 = balanced, >3 = bloated)
  marginalEfficiencyPct: number;   // cost of NEW tokens / total cost (high = mostly new work, low = re-billed context)
  totalMarginalCost: number;       // USD spent on new tokens only (excludes re-billed context)
  expensiveTurnCost: number;
  medianTurnCost: number;

  // Per-message attribution (REAL, timestamp-based)
  promptEfficiency: {
    msgLength: number;
    turnsAfter: number;
    tokensAfter: number;
    costAfter: number;            // USD
    productiveTurns: number;
  }[];
}

export interface TrendData {
  period: string;
  data: DailyStats[];
}
