import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DiscoveredSession } from '../types';

/** Id prefix that namespaces Copilot CLI sessions away from VS Code chat UUIDs. */
export const COPILOT_CLI_ID_PREFIX = 'copilotcli:';

/**
 * Editor-picker key for Copilot CLI sessions. Lets users include/exclude them via
 * "Select IDE Sources" alongside VS Code-family editors and JetBrains.
 */
export const COPILOT_CLI_EDITOR_KEY = 'Copilot CLI';

/** Default location of the Copilot CLI / Copilot SDK session store. */
export const DEFAULT_COPILOT_CLI_DIR = path.join('~', '.copilot', 'session-state');

function expandHome(p: string): string {
  if (p === '~') { return os.homedir(); }
  if (p.startsWith('~/') || p.startsWith('~\\')) { return path.join(os.homedir(), p.slice(2)); }
  return p;
}

/** Resolve the configured session-state root ('' falls back to the default). */
export function resolveCopilotCliRoot(configured: string | undefined): string {
  return expandHome(configured && configured.trim() ? configured.trim() : DEFAULT_COPILOT_CLI_DIR);
}

/**
 * Discover Copilot CLI sessions.
 *
 * VS Code's "Copilot CLI" chat session type (agent-host provider `copilotcli`) and
 * the standalone `copilot` CLI both persist each session to
 * `<root>/<sdkSessionId>/events.jsonl`. These sessions never write to
 * workspaceStorage/.../debug-logs, so the debug-log scanner cannot see them.
 *
 * Read-only and tolerant: a missing root returns [] so users without the CLI
 * never see an error. Folders without events.jsonl (e.g. lock-only folders of a
 * session that never ran a turn) are skipped.
 */
export function discoverCopilotCliSessions(configuredRoot: string | undefined): DiscoveredSession[] {
  const root = resolveCopilotCliRoot(configuredRoot);
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return []; }

  const sessions: DiscoveredSession[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) { continue; }
    const dirPath = path.join(root, entry.name);
    const eventsPath = path.join(dirPath, 'events.jsonl');
    let mtimeMs: number;
    try { mtimeMs = fs.statSync(eventsPath).mtimeMs; } catch { continue; }
    sessions.push({
      sessionId: COPILOT_CLI_ID_PREFIX + entry.name,
      provider: 'copilot',
      sourceKind: 'copilot-cli',
      dirPath,
      workspaceId: COPILOT_CLI_EDITOR_KEY,
      mainJsonlPath: eventsPath,
      modelsJsonPath: undefined,
      childJsonlPaths: [],
      mtimeMs,
    });
  }
  return sessions;
}
