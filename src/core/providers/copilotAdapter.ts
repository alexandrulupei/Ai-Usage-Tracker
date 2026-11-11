import * as fs from 'fs';
import * as path from 'path';
import { DiscoveredSession, ParsedSession, SessionInfo, ModelInfo } from '../types';
import { ExtensionConfig } from '../../config';
import { ProviderAdapter } from './types';
import { discoverSessions, discoverChatHistoryFiles, chatHistoryPathForDebugSession } from '../logDiscovery';
import { buildSession, ensureUniqueSpanIds } from '../sessionBuilder';
import { readChatSessionState, recoverFromChatHistory } from '../chatHistory';

/**
 * GitHub Copilot Chat (VS Code-family + JetBrains debug-logs), with an optional
 * VS Code chat-history fallback for requests the debug log does not cover.
 * Stamps provider='copilot' on everything it returns. (OTel Tier-1 remains a
 * sync.ts special case outside the adapter registry.)
 */
export const copilotAdapter: ProviderAdapter = {
  id: 'copilot',
  displayName: 'GitHub Copilot',

  discover(config: ExtensionConfig): DiscoveredSession[] {
    const debugSessions = discoverSessions(config.logDirectories, config.autoScanWorkspaceStorage, config.enabledEditors)
      .map(d => ({ ...d, provider: 'copilot' as const, sourceKind: 'debug-log' as const }));
    if (!config.chatHistoryFallback) { return debugSessions; }

    const chatFiles = config.autoScanWorkspaceStorage
      ? discoverChatHistoryFiles(config.enabledEditors)
      : new Map();
    const out: DiscoveredSession[] = [];
    const debugIds = new Set<string>();

    for (const d of debugSessions) {
      debugIds.add(d.sessionId);
      const chatPath = chatHistoryPathForDebugSession(d.dirPath, d.sessionId) ?? chatFiles.get(d.sessionId)?.filePath;
      if (!chatPath) { out.push(d); continue; }
      // The chat file can gain requests the debug log never saw (logging off), so
      // its mtime must also invalidate the cached parse.
      const chatMtime = mtimeSafe(chatPath);
      out.push({ ...d, chatHistoryPath: chatPath, mtimeMs: Math.max(d.mtimeMs, chatMtime) });
    }

    // Chats with no debug-log folder at all (before file logging was enabled, or
    // empty-window chats). Empty ones parse to null and are never stored.
    for (const f of chatFiles.values()) {
      if (debugIds.has(f.sessionId)) { continue; }
      out.push({
        sessionId: f.sessionId,
        provider: 'copilot',
        sourceKind: 'chat-history',
        chatHistoryPath: f.filePath,
        dirPath: path.dirname(f.filePath),
        workspaceId: f.workspaceId,
        mainJsonlPath: f.filePath,
        modelsJsonPath: undefined,
        childJsonlPaths: [],
        mtimeMs: f.mtimeMs,
      });
    }
    return out;
  },

  async parse(disc: DiscoveredSession, parseSubagents: boolean): Promise<ParsedSession | null> {
    let parsed = disc.sourceKind === 'chat-history' ? null : await buildSession(disc, parseSubagents);

    if (disc.chatHistoryPath) {
      parsed = mergeChatHistory(parsed, disc);
    }

    if (!parsed) { return null; }
    parsed.session.provider = 'copilot';
    for (const r of parsed.llmRequests) { r.provider = 'copilot'; }
    return parsed;
  },
};

function mtimeSafe(p: string): number {
  try { return fs.statSync(p).mtimeMs; } catch { return 0; }
}

/**
 * Add chat-history records for requests the debug log did not capture. Returns
 * the (possibly newly created) session, or the input unchanged when the chat has
 * nothing uncovered.
 */
function mergeChatHistory(parsed: ParsedSession | null, disc: DiscoveredSession): ParsedSession | null {
  const state = readChatSessionState(disc.chatHistoryPath!);
  if (!state) { return parsed; }
  const coveredCalls = parsed ? parsed.llmRequests.map(r => r.timestamp) : [];
  const coveredMessages = parsed ? parsed.userMessages.map(m => m.timestamp) : [];
  const rec = recoverFromChatHistory(state, disc.sessionId, coveredCalls, coveredMessages);
  if (rec.llmRequests.length === 0 && rec.userMessages.length === 0) { return parsed; }

  if (!parsed) {
    const session: SessionInfo = {
      id: disc.sessionId,
      workspaceId: disc.workspaceId,
      dirPath: path.dirname(disc.chatHistoryPath!),
      startTime: rec.startTime,
      endTime: rec.endTime,
      copilotVersion: '',
      vscodeVersion: '',
      provider: 'copilot',
      dataSource: 'jsonl',
    };
    return {
      session,
      llmRequests: rec.llmRequests,
      userMessages: rec.userMessages,
      toolCalls: [],
      turnCount: rec.llmRequests.length,
      subagentNames: [],
      childSessionFiles: [],
      models: new Map<string, ModelInfo>(),
    };
  }

  parsed.llmRequests.push(...rec.llmRequests);
  parsed.llmRequests.sort((a, b) => a.timestamp - b.timestamp);
  parsed.userMessages.push(...rec.userMessages);
  parsed.userMessages.sort((a, b) => a.timestamp - b.timestamp);
  parsed.turnCount += rec.llmRequests.length;
  // Only stretch the session bounds for recovered requests that carried usage; a
  // failed prompt alone shouldn't move a session's start/end.
  if (rec.llmRequests.length > 0) {
    if (rec.startTime > 0 && rec.startTime < parsed.session.startTime) { parsed.session.startTime = rec.startTime; }
    if (rec.endTime > parsed.session.endTime) { parsed.session.endTime = rec.endTime; }
  }
  ensureUniqueSpanIds(parsed.llmRequests, disc.sessionId);
  return parsed;
}
