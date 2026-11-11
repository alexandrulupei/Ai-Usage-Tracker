# Changelog

## 0.2.9

First Marketplace release, published as **AI Token Usage Tracker** (`AlexandruLupei.ai-token-usage-tracker`).

- Tracks GitHub Copilot and Claude Code token usage, sessions and estimated cost from local logs.
- Reads Copilot usage from VS Code-family editors (Code, Insiders, VSCodium, Cursor, Windsurf), the Copilot CLI and, best-effort, JetBrains IDEs. Choose sources with **Select IDE Sources**.
- Recovers Copilot requests that have no debug-log record from VS Code chat history (marked *incomplete*).
- Syncs in the background at startup and every 15 minutes by default (`copilotUsageTracker.autoRefreshIntervalMinutes`).

If you installed an earlier build from a `.vsix` (extension ID `local.copilot-usage-tracker`), uninstall it. This release has a new extension ID, so it starts with an empty cache and rebuilds its statistics from the logs still on disk.
