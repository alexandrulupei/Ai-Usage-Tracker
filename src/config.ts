import * as vscode from 'vscode';

export type CopilotPlan = 'free' | 'pro' | 'pro+' | 'business' | 'enterprise';
export type ClaudeCostBasis = 'api' | 'subscription';

export interface ExtensionConfig {
  logDirectories: string[];
  autoScanWorkspaceStorage: boolean;
  /** Editor keys to include in the Copilot auto-scan (empty = all detected). */
  enabledEditors: string[];
  parseSubagentLogs: boolean;
  defaultGroupBy: 'date' | 'workspace' | 'model';
  plan: CopilotPlan;
  /** Root directory for Claude Code transcripts (default ~/.claude/projects). */
  claudeProjectsDirectory: string;
  /** How to frame Claude USD: 'api' = list-price spend; 'subscription' = API-equivalent. */
  claudeCostBasis: ClaudeCostBasis;
  /** Root of the Copilot CLI session store (default ~/.copilot/session-state). */
  copilotCliSessionStateDirectory: string;
  /** Use VS Code chat history for chats with no debug-log usage (lower-bound tokens). */
  chatHistoryFallback: boolean;
  /** Minutes between background syncs; 0 disables periodic refresh. */
  autoRefreshIntervalMinutes: number;
}

export function getConfig(): ExtensionConfig {
  const cfg = vscode.workspace.getConfiguration('copilotUsageTracker');
  return {
    logDirectories: cfg.get<string[]>('logDirectories', []),
    autoScanWorkspaceStorage: cfg.get<boolean>('autoScanWorkspaceStorage', true),
    enabledEditors: cfg.get<string[]>('enabledEditors', []),
    parseSubagentLogs: cfg.get<boolean>('parseSubagentLogs', true),
    defaultGroupBy: cfg.get<'date' | 'workspace' | 'model'>('defaultGroupBy', 'date'),
    plan: cfg.get<CopilotPlan>('plan', 'business'),
    claudeProjectsDirectory: cfg.get<string>('claudeProjectsDirectory', '~/.claude/projects'),
    claudeCostBasis: cfg.get<ClaudeCostBasis>('claudeCostBasis', 'api'),
    copilotCliSessionStateDirectory: cfg.get<string>('copilotCliSessionStateDirectory', '~/.copilot/session-state'),
    chatHistoryFallback: cfg.get<boolean>('chatHistoryFallback', true),
    autoRefreshIntervalMinutes: cfg.get<number>('autoRefreshIntervalMinutes', 15),
  };
}
