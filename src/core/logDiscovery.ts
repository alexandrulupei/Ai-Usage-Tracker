import * as fs from 'fs';
import * as path from 'path';
import { DiscoveredSession } from './types';
import { discoverCopilotCliSessions, COPILOT_CLI_EDITOR_KEY } from './providers/copilotCliDiscovery';

const COPILOT_CHAT_DEBUG = 'GitHub.copilot-chat/debug-logs';
const COPILOT_CHAT_DEBUG_ALT = 'GitHub.copilot-chat\\debug-logs';

/**
 * Discover all Copilot Chat debug-log sessions across configured directories
 * and (optionally) auto-detected editor workspaceStorage folders.
 *
 * `enabledEditors` (when non-empty) restricts the auto-scan to those editor
 * keys — VS Code-family folder names (e.g. "Code", "Cursor") or the synthetic
 * "JetBrains" key. Empty = include every detected editor.
 */
export function discoverSessions(
  logDirectories: string[],
  autoScanWorkspaceStorage: boolean,
  enabledEditors: string[] = []
): DiscoveredSession[] {
  const debugLogRoots: { dirPath: string; workspaceId: string }[] = [];

  // User-configured directories: can point to a debug-logs folder or a parent
  for (const dir of logDirectories) {
    collectDebugLogRoots(dir, debugLogRoots);
  }

  // Auto-discover: scan the enabled VS Code-family editors' workspaceStorage,
  // plus a best-effort probe of JetBrains IDE directories.
  if (autoScanWorkspaceStorage) {
    collectAutoDiscoverRoots(enabledEditors, debugLogRoots);
  }

  // Enumerate session folders inside each debug-logs root
  const sessions: DiscoveredSession[] = [];
  const seenIds = new Set<string>();

  for (const { dirPath, workspaceId } of debugLogRoots) {
    for (const sessionDir of readdirSafe(dirPath)) {
      if (seenIds.has(sessionDir)) { continue; }
      const sessionPath = path.join(dirPath, sessionDir);
      const mainJsonl = path.join(sessionPath, 'main.jsonl');
      if (!fs.existsSync(mainJsonl)) { continue; }

      const stat = fs.statSync(mainJsonl);
      const modelsJson = path.join(sessionPath, 'models.json');
      const childJsonlPaths = findChildJsonlFiles(sessionPath);

      seenIds.add(sessionDir);
      sessions.push({
        sessionId: sessionDir,
        dirPath: sessionPath,
        workspaceId,
        mainJsonlPath: mainJsonl,
        modelsJsonPath: fs.existsSync(modelsJson) ? modelsJson : undefined,
        childJsonlPaths,
        mtimeMs: stat.mtimeMs,
      });
    }
  }

  return sessions;
}

// ---------------------------------------------------------------------------
// Auto-discover across editors
// ---------------------------------------------------------------------------

/** Directory names never worth recursing into during the best-effort probe. */
const PRUNE_DIRS = new Set([
  'caches', 'index', 'tmp', 'node_modules', 'CachedData', 'GPUCache',
  'Cache', 'blob_storage', 'compile-server', '.git', 'jdbc-drivers', 'javadocs',
  'multiLanguageContextProviderDocumentSymbols',
]);

/**
 * Platform roots that use the VS Code "User/workspaceStorage" layout. Every
 * VS Code fork (Code, Code - Insiders, VSCodium, Cursor, Windsurf, Positron,
 * Trae, ...) lives directly under one of these roots.
 */
function getEditorParentRoots(): string[] {
  const home = process.env.HOME || process.env.USERPROFILE || '';
  if (process.platform === 'win32') {
    return [process.env.APPDATA || path.join(home, 'AppData', 'Roaming')];
  }
  if (process.platform === 'darwin') {
    return [path.join(home, 'Library', 'Application Support')];
  }
  return [path.join(home, '.config')];
}

/** Editor key that groups all JetBrains-family detections. */
export const JETBRAINS_EDITOR_KEY = 'JetBrains';

/** One Copilot debug-logs root discovered under a specific editor. */
interface EditorDebugRoot { editor: string; dirPath: string; workspaceId: string; }

/** A detected editor that has GitHub Copilot debug-logs, with a session count. */
export interface DetectedEditor { editor: string; sessionCount: number; }

/**
 * Raw enumeration (ungated) of Copilot debug-logs roots across ALL VS Code-family
 * editors — Code, Code - Insiders, VSCodium, Cursor, Windsurf, Positron, Trae, ...
 * The editor key is the editor's folder name; no per-editor hardcoding.
 */
function vsCodeFamilyDebugRoots(): EditorDebugRoot[] {
  const roots: EditorDebugRoot[] = [];
  for (const parent of getEditorParentRoots()) {
    for (const editor of readdirSafe(parent)) {
      const wsStorage = path.join(parent, editor, 'User', 'workspaceStorage');
      if (!fs.existsSync(wsStorage)) { continue; }
      for (const entry of readdirSafe(wsStorage)) {
        const wsPath = path.join(wsStorage, entry);
        const dl = firstExisting([
          path.join(wsPath, COPILOT_CHAT_DEBUG),
          path.join(wsPath, COPILOT_CHAT_DEBUG_ALT),
        ]);
        if (dl) { roots.push({ editor, dirPath: dl, workspaceId: entry }); }
      }
    }
  }
  return roots;
}

/** A VS Code chat-history file (chatSessions/<sessionId>.jsonl|.json). */
export interface ChatHistoryFile {
  sessionId: string;
  filePath: string;
  /** workspaceStorage hash, or 'empty-window' for globalStorage/emptyWindowChatSessions. */
  workspaceId: string;
  mtimeMs: number;
}

function chatFilesIn(dir: string, workspaceId: string, out: Map<string, ChatHistoryFile>): void {
  for (const f of readdirSafe(dir)) {
    const m = /^(.+)\.(jsonl|json)$/i.exec(f);
    if (!m) { continue; }
    const filePath = path.join(dir, f);
    let mtimeMs: number;
    try { mtimeMs = fs.statSync(filePath).mtimeMs; } catch { continue; }
    const existing = out.get(m[1]);
    // Prefer the newer file if a session exists in both formats.
    if (!existing || mtimeMs > existing.mtimeMs) {
      out.set(m[1], { sessionId: m[1], filePath, workspaceId, mtimeMs });
    }
  }
}

/**
 * Enumerate VS Code chat-history files across the enabled VS Code-family editors:
 * <editor>/User/workspaceStorage/<ws>/chatSessions/ and
 * <editor>/User/globalStorage/emptyWindowChatSessions/ (chats opened with no
 * folder, which have no workspace debug-logs at all). Keyed by session id.
 */
export function discoverChatHistoryFiles(enabledEditors: string[]): Map<string, ChatHistoryFile> {
  const out = new Map<string, ChatHistoryFile>();
  for (const parent of getEditorParentRoots()) {
    for (const editor of readdirSafe(parent)) {
      if (!editorEnabled(editor, enabledEditors)) { continue; }
      const user = path.join(parent, editor, 'User');
      const wsStorage = path.join(user, 'workspaceStorage');
      if (!fs.existsSync(wsStorage)) { continue; }
      for (const ws of readdirSafe(wsStorage)) {
        chatFilesIn(path.join(wsStorage, ws, 'chatSessions'), ws, out);
      }
      chatFilesIn(path.join(user, 'globalStorage', 'emptyWindowChatSessions'), 'empty-window', out);
    }
  }
  return out;
}

/**
 * The chat-history file that belongs to a debug-log session, derived from the
 * workspaceStorage layout <ws>/GitHub.copilot-chat/debug-logs/<id>/.
 */
export function chatHistoryPathForDebugSession(sessionDir: string, sessionId: string): string | undefined {
  const wsDir = path.dirname(path.dirname(path.dirname(sessionDir)));
  for (const ext of ['.jsonl', '.json']) {
    const p = path.join(wsDir, 'chatSessions', sessionId + ext);
    if (fs.existsSync(p)) { return p; }
  }
  return undefined;
}

/**
 * Raw enumeration (ungated) of JetBrains Copilot debug-logs. JetBrains IDEs
 * store data under a different layout than VS Code; the GitHub Copilot plugin's
 * "Enable Agent debug File Logging" setting writes logs somewhere under these
 * roots, but the exact sub-path is not yet verified — so this is a bounded,
 * pruned, best-effort search. All hits collapse under JETBRAINS_EDITOR_KEY.
 */
function jetBrainsDebugRoots(): EditorDebugRoot[] {
  const home = process.env.HOME || process.env.USERPROFILE || '';
  const searchRoots: string[] = [];

  // PRIMARY: the cross-editor GitHub Copilot data dir. The JetBrains plugin
  // stores its data here under a `jbc/` ("JetBrains Copilot") subtree — e.g.
  // github-copilot/jbc/chat-sessions/. Agent debug file logging output lands in
  // this tree. On Windows this is %LOCALAPPDATA%\github-copilot; on macOS AND
  // Linux it is ~/.config/github-copilot (XDG-style, not ~/Library).
  if (process.platform === 'win32') {
    if (process.env.LOCALAPPDATA) { searchRoots.push(path.join(process.env.LOCALAPPDATA, 'github-copilot')); }
  } else {
    searchRoots.push(path.join(home, '.config', 'github-copilot'));
  }

  // SECONDARY fallback: the JetBrains IDE directories, in case a build writes
  // debug logs under the IDE log/config tree instead of the shared copilot dir.
  if (process.platform === 'win32') {
    if (process.env.LOCALAPPDATA) { searchRoots.push(path.join(process.env.LOCALAPPDATA, 'JetBrains')); }
    if (process.env.APPDATA) { searchRoots.push(path.join(process.env.APPDATA, 'JetBrains')); }
  } else if (process.platform === 'darwin') {
    searchRoots.push(path.join(home, 'Library', 'Application Support', 'JetBrains'));
    searchRoots.push(path.join(home, 'Library', 'Logs', 'JetBrains'));
  } else {
    searchRoots.push(path.join(home, '.config', 'JetBrains'));
    searchRoots.push(path.join(home, '.cache', 'JetBrains'));
  }

  const hits: { dirPath: string; workspaceId: string }[] = [];
  for (const root of searchRoots) { findDebugLogsDirs(root, 5, hits); }
  return hits.map(h => ({ editor: JETBRAINS_EDITOR_KEY, dirPath: h.dirPath, workspaceId: h.workspaceId }));
}

/** True when `editor` should be scanned given the enabled-editors selection. */
export function editorEnabled(editor: string, enabledEditors: string[]): boolean {
  return enabledEditors.length === 0 || enabledEditors.includes(editor);
}

/**
 * Collect auto-discovered Copilot debug-logs roots, restricted to the selected
 * editors (empty selection = all). GitHub Copilot only — never touches Claude.
 */
function collectAutoDiscoverRoots(
  enabledEditors: string[],
  out: { dirPath: string; workspaceId: string }[]
): void {
  for (const r of vsCodeFamilyDebugRoots()) {
    if (editorEnabled(r.editor, enabledEditors)) {
      out.push({ dirPath: r.dirPath, workspaceId: r.workspaceId });
    }
  }
  if (editorEnabled(JETBRAINS_EDITOR_KEY, enabledEditors)) {
    for (const r of jetBrainsDebugRoots()) {
      out.push({ dirPath: r.dirPath, workspaceId: r.workspaceId });
    }
  }
}

/**
 * Detect every editor on this machine that has GitHub Copilot debug-logs, with
 * a session count each. Ungated (ignores the current selection) so the picker
 * can always show the full set. GitHub Copilot only.
 */
export function detectCopilotEditors(copilotCliDir?: string): DetectedEditor[] {
  const counts = new Map<string, number>();
  for (const r of [...vsCodeFamilyDebugRoots(), ...jetBrainsDebugRoots()]) {
    counts.set(r.editor, (counts.get(r.editor) ?? 0) + countSessionDirs(r.dirPath));
  }
  // Copilot CLI sessions live outside any editor's storage; expose them as their
  // own selectable source so users can include/exclude them like an IDE.
  const cliCount = discoverCopilotCliSessions(copilotCliDir).length;
  if (cliCount > 0) { counts.set(COPILOT_CLI_EDITOR_KEY, cliCount); }
  return [...counts.entries()]
    .map(([editor, sessionCount]) => ({ editor, sessionCount }))
    .filter(e => e.sessionCount > 0)
    .sort((a, b) => b.sessionCount - a.sessionCount);
}

/** Count session folders (those containing main.jsonl) directly under a root. */
function countSessionDirs(debugLogsDir: string): number {
  let n = 0;
  for (const s of readdirSafe(debugLogsDir)) {
    if (fs.existsSync(path.join(debugLogsDir, s, 'main.jsonl'))) { n++; }
  }
  return n;
}

/**
 * Bounded, pruned search for a "debug-logs" root: a directory that directly
 * contains `<sessionId>/main.jsonl`. Used for editors whose exact on-disk
 * layout is unknown (JetBrains). Depth-limited and denylist-pruned for speed.
 */
function findDebugLogsDirs(
  dir: string,
  depth: number,
  out: { dirPath: string; workspaceId: string }[]
): void {
  if (depth < 0) { return; }
  const entries = readdirSafe(dir);
  if (entries.length === 0) { return; }
  // Is THIS a debug-logs root? (some child folder has main.jsonl)
  for (const e of entries) {
    if (fs.existsSync(path.join(dir, e, 'main.jsonl'))) {
      out.push({ dirPath: dir, workspaceId: path.basename(path.dirname(dir)) });
      return;
    }
  }
  // Otherwise recurse into non-pruned subdirectories.
  for (const e of entries) {
    if (PRUNE_DIRS.has(e)) { continue; }
    const sub = path.join(dir, e);
    if (isDirSafe(sub)) { findDebugLogsDirs(sub, depth - 1, out); }
  }
}

function firstExisting(paths: string[]): string | undefined {
  return paths.find(p => fs.existsSync(p));
}

function isDirSafe(p: string): boolean {
  try { return fs.statSync(p).isDirectory(); } catch { return false; }
}

/**
 * Given a directory, determine if it is a debug-logs root directly
 * or contains workspace storage structure. Adds results to `out`.
 */
function collectDebugLogRoots(
  dir: string,
  out: { dirPath: string; workspaceId: string }[]
): void {
  if (!fs.existsSync(dir)) { return; }
  // If ANY immediate child is a session folder (has main.jsonl), treat `dir`
  // as a debug-logs root directly. Probing only the first entry is fragile: a
  // stray file/folder sorted ahead of the session folders would hide them.
  const hasSessionChild = readdirSafe(dir).some(
    e => fs.existsSync(path.join(dir, e, 'main.jsonl'))
  );
  if (hasSessionChild) {
    out.push({ dirPath: dir, workspaceId: path.basename(path.dirname(dir)) });
    return;
  }
  // Otherwise try to find a nested debug-logs subfolder.
  const debugLogsPath = path.join(dir, COPILOT_CHAT_DEBUG);
  if (fs.existsSync(debugLogsPath)) {
    out.push({ dirPath: debugLogsPath, workspaceId: path.basename(dir) });
  }
}

/**
 * Find child JSONL files (runSubagent-*.jsonl, etc.) in a session directory.
 */
function findChildJsonlFiles(sessionDir: string): string[] {
  return readdirSafe(sessionDir)
    .filter(f => f.endsWith('.jsonl') && f !== 'main.jsonl')
    .map(f => path.join(sessionDir, f));
}

function readdirSafe(dir: string): string[] {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}
