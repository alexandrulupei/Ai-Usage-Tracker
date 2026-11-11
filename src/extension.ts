import * as vscode from 'vscode';
import * as path from 'path';
import { TrackerDatabase } from './db/database';
import { syncAll } from './db/sync';
import { SessionTreeProvider, QuickStatsTreeProvider } from './views/treeView/statsTreeProvider';
import { DashboardPanel } from './views/webview/dashboardPanel';
import { ProviderId } from './core/types';
import { detectCopilotEditors } from './core/logDiscovery';
import { COPILOT_CLI_EDITOR_KEY, COPILOT_CLI_ID_PREFIX } from './core/providers/copilotCliDiscovery';
import { getConfig } from './config';

let db: TrackerDatabase | undefined;

const ACTIVE_PROVIDER_KEY = 'copilotUsageTracker.activeProvider';

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  // Resolve WASM path — try dist/ first (webpack-copied), fall back to node_modules
  let wasmPath = path.join(context.extensionPath, 'dist', 'sql-wasm.wasm');
  if (!require('fs').existsSync(wasmPath)) {
    wasmPath = path.join(context.extensionPath, 'node_modules', 'sql.js', 'dist', 'sql-wasm.wasm');
  }

  // Initialize database in extension global storage
  db = await TrackerDatabase.create(context.globalStorageUri.fsPath, wasmPath);

  // Active provider is a user-global preference (one global DB; ~/.claude and VS Code
  // workspaceStorage are user-global). The toggle re-queries; it never re-syncs.
  let activeProvider = context.globalState.get<ProviderId>(ACTIVE_PROVIDER_KEY, 'copilot');

  // Tree view providers
  const sessionTree = new SessionTreeProvider(db);
  const quickStatsTree = new QuickStatsTreeProvider(db);
  // Seed both trees from persisted state BEFORE the first render (§15 #11a),
  // otherwise a restart shows Copilot even when Claude was the active provider.
  sessionTree.setActiveProvider(activeProvider);
  quickStatsTree.setActiveProvider(activeProvider);

  context.subscriptions.push(
    vscode.window.registerTreeDataProvider('copilotUsageTracker.sessions', sessionTree),
    vscode.window.registerTreeDataProvider('copilotUsageTracker.quickStats', quickStatsTree),
  );

  // Switch the active provider across the webview AND both trees in lockstep.
  // This is a re-query + re-render path only — it must NOT call syncAll (§8/§15 #10).
  const setActiveProvider = (provider: ProviderId): void => {
    activeProvider = provider;
    context.globalState.update(ACTIVE_PROVIDER_KEY, provider);
    sessionTree.setActiveProvider(provider);
    quickStatsTree.setActiveProvider(provider);
    sessionTree.refresh();
    quickStatsTree.refresh();
    DashboardPanel.currentPanel?.setActiveProvider(provider);
  };

  // Commands
  context.subscriptions.push(
    vscode.commands.registerCommand('copilotUsageTracker.setProvider', (provider: ProviderId) => {
      if (provider === 'copilot' || provider === 'claude') { setActiveProvider(provider); }
    }),

    vscode.commands.registerCommand('copilotUsageTracker.toggleProvider', () => {
      const next: ProviderId = activeProvider === 'claude' ? 'copilot' : 'claude';
      setActiveProvider(next);
      vscode.window.showInformationMessage(`AI Usage: now showing ${next === 'claude' ? 'Claude' : 'GitHub Copilot'}.`);
    }),

    vscode.commands.registerCommand('copilotUsageTracker.refresh', async () => {
      if (!db) { return; }
      const result = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'Scanning AI usage logs...', cancellable: false },
        (progress) => syncAll(db!, progress, wasmPath)
      );
      sessionTree.refresh();
      quickStatsTree.refresh();
      DashboardPanel.currentPanel?.refresh();
      if (result.busy) {
        vscode.window.showWarningMessage('AI Usage: another VS Code window is still writing usage data. Try again in a moment.');
        return;
      }
      vscode.window.showInformationMessage(
        `AI Usage: Found ${result.totalDiscovered} sessions. ${result.newOrUpdated} parsed, ${result.skipped} up-to-date, ${result.emptyCount} empty, ${result.errors} errors.`
      );
    }),

    vscode.commands.registerCommand('copilotUsageTracker.openDashboard', () => {
      if (!db) { return; }
      DashboardPanel.createOrShow(db, context.extensionUri, activeProvider);
    }),

    vscode.commands.registerCommand('copilotUsageTracker.addLogDirectory', async () => {
      const uris = await vscode.window.showOpenDialog({
        canSelectFolders: true,
        canSelectFiles: false,
        canSelectMany: false,
        openLabel: 'Select Log Directory',
      });
      if (uris && uris.length > 0) {
        const config = vscode.workspace.getConfiguration('copilotUsageTracker');
        const dirs = config.get<string[]>('logDirectories', []);
        const newDir = uris[0].fsPath;
        if (!dirs.includes(newDir)) {
          dirs.push(newDir);
          await config.update('logDirectories', dirs, vscode.ConfigurationTarget.Global);
          vscode.window.showInformationMessage(`Added log directory: ${newDir}`);
        }
      }
    }),

    vscode.commands.registerCommand('copilotUsageTracker.selectIdeSources', async () => {
      if (!db) { return; }
      const detected = detectCopilotEditors(getConfig().copilotCliSessionStateDirectory);
      if (detected.length === 0) {
        vscode.window.showInformationMessage(
          'AI Usage: no GitHub Copilot debug-logs found in any IDE. Enable file logging (VS Code: "github.copilot.chat.agentDebugLog.fileLogging.enabled"; JetBrains: Tools › GitHub Copilot › Chat › Enable Agent debug File Logging), run an agent chat, then retry.'
        );
        return;
      }
      const cfg = vscode.workspace.getConfiguration('copilotUsageTracker');
      const enabled = cfg.get<string[]>('enabledEditors', []);
      type IdeItem = vscode.QuickPickItem & { editor: string };
      const items: IdeItem[] = detected.map(d => ({
        label: d.editor === 'JetBrains' ? 'JetBrains IDEs (experimental)'
          : d.editor === COPILOT_CLI_EDITOR_KEY ? 'Copilot CLI sessions (~/.copilot)' : d.editor,
        description: `${d.sessionCount} Copilot session${d.sessionCount === 1 ? '' : 's'}`,
        editor: d.editor,
        picked: enabled.length === 0 ? true : enabled.includes(d.editor),
      }));
      const chosen = await vscode.window.showQuickPick(items, {
        canPickMany: true,
        title: 'Select IDEs to include (GitHub Copilot only)',
        placeHolder: 'Only checked IDEs are summed · selecting all = auto-include future editors',
      });
      if (!chosen) { return; }                                  // cancelled: no change
      const selected = chosen.map(c => c.editor);
      if (selected.length === 0) {
        vscode.window.showWarningMessage('AI Usage: no IDE selected — selection left unchanged.');
        return;
      }
      // Store [] when EVERY detected editor is selected ("all"; also auto-includes
      // future installs); otherwise persist the explicit subset.
      const toStore = selected.length === detected.length ? [] : selected;
      await cfg.update('enabledEditors', toStore, vscode.ConfigurationTarget.Global);

      // Re-sum: clear ONLY Copilot data (Claude untouched), then resync with the
      // new editor filter so totals reflect exactly the selection.
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'Rebuilding GitHub Copilot usage from selected IDEs...', cancellable: false },
        async (progress) => {
          await db!.withWriteLock(() => db!.clearProvider('copilot'), {
            onWait: () => progress.report({ message: 'Waiting for another VS Code window to finish syncing...' }),
          });
          await syncAll(db!, progress, wasmPath);
        }
      );
      sessionTree.refresh();
      quickStatsTree.refresh();
      DashboardPanel.currentPanel?.refresh();
      vscode.window.showInformationMessage(
        `AI Usage: now summing ${selected.length} IDE source${selected.length === 1 ? '' : 's'}: ${selected.join(', ')}.`
      );
    }),

    vscode.commands.registerCommand('copilotUsageTracker.clearCache', async () => {
      if (!db) { return; }
      const label = activeProvider === 'claude' ? 'Claude' : 'GitHub Copilot';
      const answer = await vscode.window.showWarningMessage(
        `Clear cached ${label} data? Other providers are unaffected. Data is re-parsed on next refresh.`,
        'Clear', 'Cancel'
      );
      if (answer === 'Clear') {
        try {
          await db.withWriteLock(() => db!.clearProvider(activeProvider));
        } catch (err) {
          vscode.window.showWarningMessage(`AI Usage: could not clear the cache (${err instanceof Error ? err.message : String(err)}).`);
          return;
        }
        sessionTree.refresh();
        quickStatsTree.refresh();
        DashboardPanel.currentPanel?.refresh();
        vscode.window.showInformationMessage(`${label} cache cleared.`);
      }
    }),

    vscode.commands.registerCommand('copilotUsageTracker.openRawLog', (item: { id?: string }) => {
      if (!item?.id || !db) { return; }
      const detail = db.getSessionDetail(item.id);
      if (!detail?.session.dirPath) { return; }
      // Copilot writes main.jsonl under the session dir; Claude's raw file is
      // <stem>.jsonl in the project dir (strip the 'claude:' id prefix). §15 #9.
      // Copilot CLI sessions keep events.jsonl in their session dir; chat-history
      // sessions point at the chatSessions dir and the file is <id>.jsonl|.json.
      const fsMod = require('fs');
      const dir = detail.session.dirPath;
      let candidates: string[];
      if (detail.session.provider === 'claude') {
        candidates = [path.join(dir, item.id.replace(/^claude:/, '') + '.jsonl')];
      } else if (item.id.startsWith(COPILOT_CLI_ID_PREFIX)) {
        candidates = [path.join(dir, 'events.jsonl')];
      } else {
        candidates = [path.join(dir, 'main.jsonl'), path.join(dir, item.id + '.jsonl'), path.join(dir, item.id + '.json')];
      }
      const found = candidates.find(p => fsMod.existsSync(p));
      if (found) {
        vscode.window.showTextDocument(vscode.Uri.file(found));
      } else {
        vscode.window.showWarningMessage(`Raw log not found: ${candidates[0]}`);
      }
    }),

    vscode.commands.registerCommand('copilotUsageTracker.stats.prevMonth', () => {
      quickStatsTree.navOlder();
    }),
    vscode.commands.registerCommand('copilotUsageTracker.stats.nextMonth', () => {
      quickStatsTree.navNewer();
    }),
    vscode.commands.registerCommand('copilotUsageTracker.stats.allTime', () => {
      quickStatsTree.navAllTime();
    }),
    vscode.commands.registerCommand('copilotUsageTracker.stats.currentMonth', () => {
      quickStatsTree.navCurrentMonth();
    }),
    vscode.commands.registerCommand('copilotUsageTracker.stats.selectMonth', () => {
      quickStatsTree.showMonthPicker();
    }),
  );

  // Automatic sync: once on activation (the extension now activates on startup),
  // then every `autoRefreshIntervalMinutes`. Background syncs are silent and skip
  // Copilot's prompt-export command (it can raise its own notification). syncAll
  // de-duplicates concurrent runs, so a timer tick during a manual refresh is a no-op.
  // With several VS Code windows open, all share one database: a background sync
  // that finds another window already syncing skips (that window does the work),
  // and this window picks up the result through the external-change check below.
  const backgroundSync = (reason: string): void => {
    if (!db) { return; }
    syncAll(db, undefined, wasmPath, { includePromptExport: false, waitForOtherWindowMs: 0 }).then(result => {
      if (result.busy) {
        console.log(`[AIUsageTracker] ${reason} sync skipped: another window is syncing`);
        return;
      }
      if (result.newOrUpdated > 0) {
        sessionTree.refresh();
        quickStatsTree.refresh();
        DashboardPanel.currentPanel?.refresh();
      }
      console.log(`[AIUsageTracker] ${reason} sync: ${result.newOrUpdated} updated, ${result.skipped} up-to-date, ${result.errors} errors`);
    }).catch(err => {
      console.error(`[AIUsageTracker] ${reason} sync failed:`, err);
    });
  };

  let timer: ReturnType<typeof setInterval> | undefined;
  const scheduleBackgroundSync = (): void => {
    if (timer) { clearInterval(timer); timer = undefined; }
    const minutes = getConfig().autoRefreshIntervalMinutes;
    if (minutes > 0) {
      timer = setInterval(() => backgroundSync('periodic'), Math.max(1, minutes) * 60_000);
    }
  };
  scheduleBackgroundSync();
  context.subscriptions.push(
    { dispose: () => { if (timer) { clearInterval(timer); } } },
    vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration('copilotUsageTracker.autoRefreshIntervalMinutes')) {
        scheduleBackgroundSync();
      }
    }),
  );

  // Show data written by other windows: reload when the file changes (a cheap
  // stat every 30s) and refresh the views when it did.
  const externalChangeTimer = setInterval(() => { db?.checkForExternalChanges(); }, 30_000);
  context.subscriptions.push(
    { dispose: () => clearInterval(externalChangeTimer) },
    db.onDidReloadFromDisk(() => {
      sessionTree.refresh();
      quickStatsTree.refresh();
      DashboardPanel.currentPanel?.refresh();
    }),
  );

  sessionTree.refresh();
  quickStatsTree.refresh();
  backgroundSync('startup');
}

export function deactivate(): void {
  db?.close();
  db = undefined;
}
