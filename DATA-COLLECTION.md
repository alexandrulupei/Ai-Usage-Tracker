# Data Collection — How It Works

This document explains **what data** the Copilot Usage Tracker extension reads, **where it comes from**, and **how it is processed** into the statistics you see in the dashboard.

---

## The Short Version

The extension reads files that already exist on disk: GitHub Copilot Chat **debug logs**, **Copilot CLI** session event logs, VS Code **chat history** (only as a fallback for requests the debug log is missing), and Claude Code transcripts. It does **not** inject itself into Copilot, intercept network traffic, or send data anywhere. It simply finds those local files, parses them, and presents the numbers in a friendly UI.

---

## Where the Logs Come From

Every time you start a Copilot Chat conversation in VS Code, the Copilot Chat extension writes detailed debug logs to a folder inside your VS Code **workspace storage**. These logs exist regardless of whether this extension is installed — they are a standard part of how GitHub Copilot Chat operates.

### Log location on disk

The workspace storage path depends on your operating system:

| OS      | Path                                                                 |
|---------|----------------------------------------------------------------------|
| Windows | `%APPDATA%\Code\User\workspaceStorage\`                              |
| macOS   | `~/Library/Application Support/Code/User/workspaceStorage/`          |
| Linux   | `~/.config/Code/User/workspaceStorage/`                              |

Inside that folder there is one subfolder per VS Code workspace (named with a hash ID). Each workspace folder contains:

```
<workspace-hash>/
  GitHub.copilot-chat/
    debug-logs/
      <session-uuid>/          ? one folder per chat conversation
        main.jsonl             ? primary event log
        models.json            ? model metadata (optional)
        runSubagent-*.jsonl    ? subagent logs (optional)
        title-*.jsonl          ? (ignored — low value)
        categorization-*.jsonl ? (ignored — low value)
        summarize-*.jsonl      ? (ignored — low value)
```

### What triggers log creation

A new session folder is created each time you:
- Open Copilot Chat and start a new conversation
- Switch to a different workspace and continue chatting
- Start a new agent-mode task

LLM-call events are written to these files only while Copilot's agent debug file logging is on (`github.copilot.chat.agentDebugLog.fileLogging.enabled`; the older `github.copilot.chat.agentDebugLog.enabled` key no longer exists as of Copilot Chat 0.73.0). Chats from before it was enabled have no `llm_request` events; see [VS Code chat history](#6-vs-code-chat-history--fallback-for-uncovered-requests) for how those are recovered.

---

## What Files Are Read

### 1. `main.jsonl` — The Primary Event Log

This is the most important file. It contains **one JSON object per line** (JSONL format), recording every significant event that happened during a Copilot Chat conversation. Each line has this general structure:

```json
{
  "v": 1,
  "ts": 1700000003500,
  "dur": 2500,
  "sid": "session-uuid",
  "type": "llm_request",
  "name": "chat:claude-sonnet-4.6",
  "spanId": "llm-001",
  "parentSpanId": "um-001",
  "status": "ok",
  "attrs": {
    "model": "claude-sonnet-4.6",
    "inputTokens": 5200,
    "outputTokens": 1800,
    "ttft": 450,
    "maxTokens": 32000
  }
}
```

The event types the extension extracts are:

| Event Type       | What It Represents                                                  | Key Data Extracted                                |
|------------------|---------------------------------------------------------------------|---------------------------------------------------|
| `session_start`  | Conversation was initialized                                        | Copilot version, VS Code version                  |
| `llm_request`    | An LLM API call was made                                            | Model name, input/output/cached tokens, latency (TTFT), status |
| `user_message`   | You typed a message in the chat                                     | Content length, first 200 characters (preview)    |
| `tool_call`      | Copilot invoked a tool (read_file, grep_search, run_in_terminal…)   | Tool name, duration, success/failure              |
| `agent_response` | Copilot generated a reply                                           | Response metadata                                 |
| `subagent`       | A subagent was spawned (e.g., Explore agent)                        | Agent name, description                           |
| `turn_start`     | A new conversation turn began                                       | Turn ID                                           |
| `turn_end`       | A conversation turn finished                                        | Turn ID                                           |

**Privacy note:** The extension only stores a **200-character preview** of your messages. Full message content is not persisted in the extension's database.

### 2. `models.json` — Model Metadata (Optional)

When present, this file contains an array of model definitions that Copilot had available during the session. Example:

```json
[
  {
    "id": "claude-sonnet-4.6",
    "name": "Claude Sonnet 4.6",
    "vendor": "Anthropic",
    "billing": { "is_premium": true, "multiplier": 1 },
    "capabilities": {
      "family": "claude-sonnet-4.6",
      "limits": {
        "max_context_window_tokens": 200000,
        "max_output_tokens": 32000
      }
    }
  }
]
```

From this file the extension reads:
- **Billing data** — `billing.token_prices` (per-token list prices, incl. cache and long-context rates) is the source for the extension's price table; the legacy `multiplier` field is stored but no longer used, since premium-request billing was removed
- **Context window size** — maximum input tokens the model accepts (used for context-saturation analysis)
- **Max output tokens** — maximum output length

### 3. `runSubagent-*.jsonl` — Subagent Logs (Optional)

When Copilot spawns a subagent (for example, the `Explore` agent for codebase search), the subagent's events are written to a separate file like `runSubagent-Explore-abc123.jsonl`. These files have the **same JSONL format** as `main.jsonl`.

The extension parses these files and **rolls their token counts into the parent session**, so you see the true total cost of a conversation — including all subagent work.

Files like `title-*.jsonl`, `categorization-*.jsonl`, and `summarize-*.jsonl` are **skipped** because they are housekeeping operations with negligible token usage.

### 4. Copilot Prompt Export — Cached Token Data

This is a **critical additional data source**. The debug JSONL logs described above do **not** include cached token counts — they record `inputTokens` and `outputTokens` but not how many of those input tokens were served from Anthropic's/OpenAI's prompt cache. Cached tokens are billed at a significantly lower rate, so knowing the real number is essential for accurate cost calculation.

To fill this gap, the extension calls a **hidden VS Code command** exposed by the Copilot Chat extension itself:

```
github.copilot.chat.debug.exportAllPromptLogsAsJson
```

This is the same data source used by the [GitHub Copilot Token Tracker](https://marketplace.visualstudio.com/items?itemName=nicepkg.copilot-token-tracker) extension. When executed, it exports all prompt logs from the **current VS Code session** to a temporary JSON file. Each entry in that export contains full usage metadata from the API response, including:

```json
{
  "usage": {
    "prompt_tokens": 12000,
    "completion_tokens": 3500,
    "total_tokens": 15500,
    "prompt_tokens_details": {
      "cached_tokens": 8400     ? THIS is what we need
    },
    "completion_tokens_details": {
      "reasoning_tokens": 0
    }
  }
}
```

**How enrichment works:**

1. **Export** — The extension calls the hidden command, which writes a JSON file to a temp directory
2. **Parse** — It extracts every `ChatMLSuccess` entry with token usage details (model, prompt tokens, completion tokens, cached tokens, reasoning tokens)
3. **Persist** — Fresh entries are stored in the `prompt_export_cache` database table so they **survive VS Code restarts** (the export command only returns data from the current session)
4. **Match** — The extension builds a lookup index from **all** stored entries (fresh + historical) and matches them against database records that lack cached token data. Matching uses `(model, inputTokens, outputTokens)` plus timestamp proximity since the two data sources use different identifiers
5. **Update** — Matched records get their `cachedInputTokens` column updated with the real value, plus prompt-export key, match confidence, reasoning tokens when present, and audit flags
6. **Prune** — Cached entries older than 30 days are pruned to keep the table bounded

**Important details:**
- The export command is only available when the Copilot Chat extension is active — if it's not available, the extension falls back to **estimated** cached token values
- Data from past VS Code sessions is preserved in the database, so you don't lose accuracy after restarting
- Measured zero cached tokens are stored as measured values, not treated as missing values on later syncs
- The enrichment step runs automatically at the end of every sync/refresh
- The temp file is deleted immediately after parsing

**Why this matters for cost accuracy:**
For models like Claude Sonnet, cached input tokens cost ~90% less than uncached tokens. Without real cached token data, the extension would have to estimate (and likely overestimate) your costs. With the prompt export data, billing calculations use the actual numbers from the API response.

### 5. Copilot CLI sessions — `~/.copilot/session-state/<id>/events.jsonl`

Chats run with VS Code's **Copilot CLI** session type (VS Code's agent host lists them as provider `copilotcli`), as well as standalone `copilot` CLI sessions, **never write to `debug-logs/`**. Each one keeps its own event stream instead. They are reported under GitHub Copilot, with agent name `Copilot CLI`.

| Event | Becomes |
|-------|---------|
| `session.start` | Session start time, cwd, repository, branch, CLI version |
| `session.usage_record` | One LLM call: model, input / output / cache-read / cache-write / reasoning tokens, TTFT, duration, and **`copilotUsage.totalNanoAiu` → direct credits** (per call; 1e9 nanoAIU = 1 credit) |
| `session.compaction_complete` | One LLM call for the context-compaction summarizer (billed, but it has no `usage_record`) |
| `model.model_call_success` | Auxiliary calls such as title generation (these have been 0 nanoAIU so far) |
| `user.message`, `tool.execution_*`, `assistant.turn_start` | Messages, tool calls (args/result/error, duration), turn count |

`usage.inputTokens` already **includes** cache-read and cache-write tokens, the same convention the cost engine uses. Two details matter for correctness:

- **Forked / continued sessions** begin with a *copy* of their parent's events (same ids, original timestamps). Every copied event is stamped earlier than the new session's own `startTime`, so those events are skipped and the calls are counted only in the parent.
- The CLI's own cumulative `session.usage_checkpoint` counts each compaction **twice**. The compaction event itself reports `requestCount: 1` and its own per-token price breakdown adds up, so the tracker counts each compaction once. Apart from that, summed per-call credits match the CLI's checkpoint exactly.

### 6. VS Code chat history — fallback for uncovered requests

VS Code's own chat store (`chatSessions/<id>.jsonl`, a mutation log of the chat UI state) is used **only for requests the debug log did not capture**. That happens for chats from before debug file logging was enabled, and for the opening requests of a chat that was already running when logging was turned on. A request counts as covered when at least one debug-log LLM call falls inside its own `[timestamp, timestamp + elapsed]` span.

What chat history provides, checked against debug logs for the same requests:

| Field | Meaning | Accuracy |
|-------|---------|----------|
| `copilotCredits` | Credits for the request | Matches the debug-log total exactly (main agent; may miss subagent calls) |
| `completionTokens` | Output tokens | Per-request total |
| `promptTokens` | Input tokens | **Final tool-call round only**, so a lower bound (often 10–30× lower) |
| `toolCallRounds[].modelId` / `resolvedModel` | Model actually used | Exact |

Recovered records use token source `chat_history` and carry the audit flag `chat_history_input_lower_bound`, which sets the session's audit state to **incomplete**. They are excluded from prompt-export cache matching. Turn this off with `copilotUsageTracker.chatHistoryFallback: false`.

---

## How Discovery Works

When you trigger a refresh (or the extension activates), this is the discovery process:

```
1. Read the configured `logDirectories` from settings (if any)
2. If `autoScanWorkspaceStorage` is enabled (default: yes):
   ? Find the VS Code workspaceStorage folder for your OS
   ? Scan every workspace subfolder for `GitHub.copilot-chat/debug-logs/`
3. Inside each debug-logs folder, enumerate session subfolders
4. For each session, check if `main.jsonl` exists
5. Collect paths to main.jsonl, models.json, and any runSubagent-*.jsonl files
6. Record the file modification time for change detection
```

On subsequent refreshes, the extension **skips sessions whose files haven't changed** (based on modification timestamps), so only new or updated conversations are re-parsed.

Two more GitHub Copilot sources are discovered alongside the debug logs:

- **Copilot CLI**: every `<copilotCliSessionStateDirectory>/<id>/events.jsonl` (default `~/.copilot/session-state`). It appears in **Select IDE Sources** as "Copilot CLI sessions" and can be excluded like an IDE.
- **VS Code chat history** (when `chatHistoryFallback` is on): `<workspaceStorage>/<ws>/chatSessions/<id>.jsonl|.json` and `globalStorage/emptyWindowChatSessions/`. A chat file with the same id as a debug-log session is attached to that session. Chat files with no debug-log folder become their own session, but only if they contain usage; empty chats are never stored.

---

## How Parsing Works

The extension uses **streaming parsing** for `main.jsonl` files — it reads line by line without loading the entire file into memory, which keeps it fast even for very long conversations.

For each line:
1. Parse the JSON
2. Classify the event by its `type` field
3. Extract the relevant fields into a typed record

If a line fails to parse (corrupted JSON), it is counted as a parse error but does **not** break the session — the extension continues with the next line.

Subagent JSONL files are parsed synchronously (they are typically small) and their events are merged into the parent session's records, tagged with `isSubagent: true` and the agent name.

### Span ids and resumed chats

Copilot's span ids (e.g. `0000000000000010`) are per-process counters. When a chat is resumed after a VS Code reload, Copilot appends another `session_start` to `main.jsonl` and the counter starts again from the beginning, so distinct calls reuse the same id. Each subagent file is also its own counter. The parser therefore namespaces ids as `[<childFileStem>:][e<N>:]<spanId>`, where `N` is the number of `session_start` lines seen so far (minus one). The same prefix goes on `spanId` and `parentSpanId`, so links between tool calls, messages and LLM calls stay intact. The first epoch of `main.jsonl` keeps the raw id. As a last safeguard, any id that still collides is suffixed with `#<timestamp>` rather than overwritten (the database has a unique `(session_id, span_id)` index).

---

## Where Processed Data Is Stored

After parsing, all extracted data is stored in a **local SQLite database** file at:

```
<VS Code extension storage>/copilot-usage.db
```

This file lives inside your VS Code profile directory and is **never uploaded anywhere**. The database contains these tables:

| Table              | What It Stores                                                        |
|--------------------|-----------------------------------------------------------------------|
| `sessions`         | Session metadata (ID, workspace, timestamps, Copilot/VS Code version) |
| `llm_requests`     | Every LLM API call (model, tokens, latency, status, subagent flag)    |
| `user_messages`    | Your chat requests (subagent prompts excluded; failed requests kept) |
| `tool_calls`       | Tool invocations (tool name, duration, success/failure)               |
| `session_stats`    | Pre-computed aggregate statistics per session                         |
| `model_billing`    | Model metadata from `models.json` (context window, max output)        |
| `prompt_export_cache` | Cached token data from Copilot's prompt export (for accurate cost calculations) |

The database uses **upsert semantics** — re-parsing a session replaces its old data cleanly, so it is safe to refresh at any time.

---

## What the Extension Does NOT Do

- **Does NOT intercept Copilot network traffic** — it only reads files already on disk
- **Does NOT modify any Copilot files** — all log files are opened read-only
- **Does NOT send data to any server** — everything stays local
- **Does NOT store full message content** — only 200-character previews
- **Does NOT change any Copilot configuration** — it reads whatever Copilot already wrote (VS Code chat debug logs need agent debug file logging enabled)
- **Does NOT watch files continuously** — it syncs at startup, then silently every `autoRefreshIntervalMinutes` (default 15; 0 = off), and on manual refresh. Background syncs never call Copilot's prompt-export command, because that command can show a notification.

---

## Data Flow Summary

```
VS Code + Copilot Chat (writes logs automatically)
         ?
         ?
???????????????????????????????
?  workspaceStorage on disk   ?
?  main.jsonl, models.json,   ?
?  runSubagent-*.jsonl         ?
???????????????????????????????
              ?  read-only
              ?
???????????????????????????????
?  Log Discovery              ?
?  Find all session folders   ?
?  Skip unchanged files       ?
???????????????????????????????
              ?
              ?
???????????????????????????????
?  Log Parser                 ?
?  Stream JSONL ? typed events?
?  Merge subagent logs        ?
???????????????????????????????
              ?
              ?
???????????????????????????????
?  Session Builder            ?
?  Assemble records + model   ?
?  metadata into a session    ?
???????????????????????????????
              ?
              ?
???????????????????????????????
?  SQLite Database (local)    ?
?  copilot-usage.db           ?
???????????????????????????????
              ?
              ?
????????????????????????????????????????????
?  Cached Token Enrichment                 ?
?  Export via Copilot hidden command        ?
?  ? Parse prompt_tokens_details           ?
?  ? Match & update DB records             ?
?  ? Persist in prompt_export_cache table  ?
????????????????????????????????????????????
              ?
              ?
???????????????????????????????
?  Stats Engine               ?
?  Compute costs, efficiency, ?
?  billing, workflow insights ?
???????????????????????????????
              ?
              ?
???????????????????????????????
?  Dashboard / Tree Views     ?
?  (what you see in VS Code)  ?
???????????????????????????????
```
