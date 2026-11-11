# AI Token Usage Tracker

A VS Code extension that analyzes **GitHub Copilot** (Chat and CLI) and **Claude Code** token usage, session statistics, and cost insights from local logs. Track how many tokens you consume, estimate costs against your plan quota, and drill into individual requests — all without sending data anywhere. Switch between providers with a single click.

## Installation

Requires **VS Code 1.85 or newer**. Pick one of the two options.

### Option 1 — Install the prebuilt `.vsix` (quickest)

1. Download the latest package from the [`releases/`](releases/) folder of this repository — currently [`ai-token-usage-tracker-0.2.9.vsix`](https://github.com/alexandrulupei/Ai-Usage-Tracker/raw/main/releases/ai-token-usage-tracker-0.2.9.vsix).
2. Install it, either:
   - **From the UI:** open the **Extensions** view (`Ctrl+Shift+X`), click the `...` menu → **Install from VSIX...**, and pick the file; or
   - **From a terminal:**
     ```bash
     code --install-extension ai-token-usage-tracker-0.2.9.vsix
     ```
3. Reload VS Code when prompted, then follow [Setup](#setup).

To update later, install the newer `.vsix` the same way; it replaces the old version.

> **Installed an earlier build named "AI Usage Tracker" (`local.copilot-usage-tracker`)?** Uninstall it first. The extension now has a new ID, so the two would run side by side. The new one starts with an empty cache and rebuilds its statistics from the logs still on disk.

### Option 2 — Build from source

Requires [Node.js](https://nodejs.org/) and Git.

```bash
git clone https://github.com/alexandrulupei/Ai-Usage-Tracker.git
cd Ai-Usage-Tracker
npm install
npm run package        # compiles and writes releases/ai-token-usage-tracker-<version>.vsix
code --install-extension releases/ai-token-usage-tracker-0.2.9.vsix
```

To debug instead of installing, open the folder in VS Code and press `F5` to launch an Extension Development Host. For a rebuild-on-save dev loop, run `npm run watch`.

## Setup

### GitHub Copilot

Copilot only writes the per-request logs this extension reads when **agent debug file logging** is on. Add this to your user `settings.json` (`Ctrl+Shift+P` → **Preferences: Open User Settings (JSON)**):

```jsonc
{
  "github.copilot.chat.agentDebugLog.fileLogging.enabled": true
}
```

Then reload the window (`Ctrl+Shift+P` → **Developer: Reload Window**) and run a Copilot chat.

| Setting | Required? | Purpose |
|---------|-----------|---------|
| `github.copilot.chat.agentDebugLog.fileLogging.enabled` | **Yes** | Writes chat debug events (LLM requests, token usage, tool calls) to JSONL files under `workspaceStorage/<ws>/GitHub.copilot-chat/debug-logs/`. These are the main source this extension reads. Copilot's default is `false`. |
| `github.copilot.chat.agentDebugLog.fileLogging.maxRetainedSessionLogs` | Optional | How many chat-session logs Copilot keeps before deleting the oldest (Copilot's default: `50`). Raise it if you want a longer history. |
| `github.copilot.chat.otel.dbSpanExporter.enabled` | Optional | Has Copilot keep its OpenTelemetry spans in a local SQLite DB (`agent-traces.db`). When it has data, this extension prefers it because it records real cached-token counts. It only works from **user** settings, and Copilot turns it off when VS Code telemetry is set to `off`. |

> **Upgrading from an older setup?** Earlier versions of this README also listed `github.copilot.chat.agentDebugLog.enabled`. That key no longer exists in current Copilot Chat (verified against Copilot Chat 0.73.0 in VS Code 1.145). VS Code ignores it, so you can delete it.

Notes:

- **Chats from before you enabled logging** are partly recovered from VS Code's chat history (see `copilotUsageTracker.chatHistoryFallback`). Credits are exact for those requests, but input tokens cover only the final round, so those sessions are marked *incomplete*.
- **Other editors:** logs are discovered automatically across VS Code-family editors (Code, Insiders, VSCodium, Cursor, Windsurf, …). JetBrains IDEs are detected on a best-effort basis; there, turn on agent debug file logging in the GitHub Copilot plugin's chat settings. Use **Select IDE Sources** to choose which editors to include.
- **Copilot CLI:** sessions from the standalone `copilot` CLI and VS Code's "Copilot CLI" chat type are read from `~/.copilot/session-state` and need no extra setup.

### Claude Code

No setup. Claude Code writes its session transcripts to `~/.claude/projects` automatically.

## Features

- **Two providers, one view** — Track GitHub Copilot and Claude Code side by side; toggle the active provider with the **Switch Provider** button (orange accent for Claude, blue for Copilot).
- **Token Usage Dashboard** — Input, output, cached (read), and cache-write tokens per session, model, or billing period. A "fresh in" figure leaves out the re-read cached prefix, so it can be compared with each tool's own usage panel.
- **Cost estimation** —
  - *Copilot:* AI credits / USD against your plan quota (Free, Pro, Pro+, Business, Enterprise). It uses the billed amount Copilot logs for each request, and list prices when no billed amount is logged. It also shows activity (sessions and chat requests).
  - *Claude:* USD at Anthropic list prices, with correct cache-read (0.1×) and cache-write pricing, including the **1-hour vs 5-minute TTL** distinction.
- **Session Explorer** — Browse every conversation in a sidebar tree, grouped by date, workspace, or model. Each one has an expandable per-request timeline (prompt, output, tool inputs/results).
- **Multi-IDE sources** — Combines Copilot logs from every detected editor plus the Copilot CLI; include or exclude each with **Select IDE Sources**.
- **Accurate request accounting** — For Claude, the lines of one API response are de-duplicated to a single request by `requestId`. Deeply nested subagent/workflow transcripts are rolled into the parent session.
- **Background refresh** — Syncs at startup and then every 15 minutes by default (configurable).
- **Billing-period navigation** — Step through months or view all-time totals; the current billing period is always selectable.
- **Offline & private** — All processing is local. The extension only reads existing log files; it never intercepts traffic or phones home.

## Usage

1. Open the **AI Usage** view in the Activity Bar (left sidebar).
2. The extension automatically discovers Copilot logs (all workspaces and detected editors) and Claude Code transcripts.
3. Use the **Switch Provider** button (view title bar) to toggle between Copilot and Claude.
4. Click **Refresh** to scan for new sessions immediately.
5. Open the **Dashboard** (`AI Usage: Open AI Usage Dashboard`) for charts, per-model breakdowns, and the expandable request timeline.
6. Use the billing-period picker to view a specific month or all-time totals.

### Commands

| Command | Description |
|---------|-------------|
| `AI Usage: Open AI Usage Dashboard` | Opens the webview dashboard with full statistics |
| `AI Usage: Switch Provider (Copilot / Claude)` | Toggles the active provider |
| `AI Usage: Refresh Usage Data` | Re-scans logs/transcripts for new sessions |
| `AI Usage: Add Log Directory` | Manually add a directory to scan for Copilot debug logs |
| `AI Usage: Select IDE Sources (GitHub Copilot)` | Choose which editors (and the Copilot CLI) to include |
| `AI Usage: Select Billing Period` | Pick a month or all-time |
| `AI Usage: Clear Cache` | Clears cached data for the active provider |
| `AI Usage: Open Raw Log` | Opens the raw log file for a selected session |

## Configuration

| Setting | Default | Description |
|---------|---------|-------------|
| `copilotUsageTracker.plan` | `"business"` | Your GitHub Copilot plan — determines monthly quota for billing display |
| `copilotUsageTracker.logDirectories` | `[]` | Additional directories to scan for Copilot Chat debug logs |
| `copilotUsageTracker.autoScanWorkspaceStorage` | `true` | Auto-discover logs across VS Code-family editors plus a best-effort JetBrains probe |
| `copilotUsageTracker.enabledEditors` | `[]` | Editors to include when auto-scanning (empty = all detected). Managed via **Select IDE Sources** |
| `copilotUsageTracker.copilotCliSessionStateDirectory` | `"~/.copilot/session-state"` | Root of the Copilot CLI session store |
| `copilotUsageTracker.chatHistoryFallback` | `true` | Recover Copilot requests with no debug-log record from VS Code chat history (marked *incomplete*) |
| `copilotUsageTracker.parseSubagentLogs` | `true` | Recursively parse subagent transcripts for full token accounting |
| `copilotUsageTracker.autoRefreshIntervalMinutes` | `15` | Minutes between silent background syncs; `0` disables periodic refresh |
| `copilotUsageTracker.defaultGroupBy` | `"date"` | Default session grouping (`date`, `workspace`, or `model`) |
| `copilotUsageTracker.claudeProjectsDirectory` | `"~/.claude/projects"` | Root directory containing Claude Code transcripts |
| `copilotUsageTracker.claudeCostBasis` | `"api"` | How to present Claude cost: `api` = USD at Anthropic list prices; `subscription` = API-equivalent (included in your Claude plan) |

## How it works

The extension reads **existing local files** written by each tool:

**GitHub Copilot** (when a session exists in the OTel DB, that copy wins)
1. **OTel Agent Traces DB** — SQLite spans with cached/reasoning tokens, exported via Copilot's `exportAgentTracesDB` command. Only populated when `github.copilot.chat.otel.dbSpanExporter.enabled` is on.
2. **JSONL debug logs** — `workspaceStorage/*/GitHub.copilot-chat/debug-logs/`, written when agent debug file logging is on.
3. **Copilot CLI sessions** — `~/.copilot/session-state/<id>/events.jsonl`.
4. **VS Code chat history** — fallback for requests not covered above.
5. **Prompt export** — cached-token enrichment via Copilot's internal export (manual refresh only).

**Claude Code**
- Reads `~/.claude/projects/<project>/<sessionId>.jsonl` and its nested subagent/workflow transcripts. One API response spans several transcript lines that share a `requestId`; these are de-duplicated to a single request so tokens are counted once. Cache-read, 5-minute cache-write, and 1-hour cache-write tokens are priced separately.

Costs are computed by a shared per-token engine keyed off the **provider** (not the model name), so a Claude model run *through* Copilot is still billed under Copilot's rules.

See [DATA-COLLECTION.md](DATA-COLLECTION.md) and [COST-CALCULATION.md](COST-CALCULATION.md) for the full data-collection and billing methodology.

## Data privacy

- **No network calls** — The extension never sends data to any server.
- **Read-only sources** — It only reads existing log/transcript files; it never modifies them.
- **Local storage only** — All statistics are cached in a local SQLite database in the extension's storage folder.
- **Full content is stored locally** — To power the expandable request timeline, the local database stores full message text, assistant output, and tool inputs/results (capped at 16 KB per field). This data stays on your machine and is removed by **Clear Cache**. If you don't want it stored, avoid installing this build on shared machines.

## Development

```bash
npm run watch     # Compile in watch mode (dev)
npm run compile   # Production build into dist/
npm run package   # Build a .vsix into releases/
```

When you release a new version, bump `version` in `package.json`, run `npm run package`, commit the new `.vsix` in `releases/`, and update the download link under [Installation](#installation).

## License

MIT
