import { DiscoveredSession, ParsedSession } from '../types';
import { ExtensionConfig } from '../../config';
import { ProviderAdapter } from './types';
import { discoverCopilotCliSessions, COPILOT_CLI_EDITOR_KEY } from './copilotCliDiscovery';
import { readCliEvents, collectCopilotCliEvents } from './copilotCliCollect';
import { editorEnabled } from '../logDiscovery';

/**
 * GitHub Copilot CLI sessions (VS Code "Copilot CLI" chat session type and the
 * standalone `copilot` CLI). Reported under provider 'copilot' because they draw
 * from the same Copilot plan/credits; the session's agentName is 'Copilot CLI'.
 */
export const copilotCliAdapter: ProviderAdapter = {
  id: 'copilot',
  displayName: 'GitHub Copilot CLI',

  discover(config: ExtensionConfig): DiscoveredSession[] {
    if (!editorEnabled(COPILOT_CLI_EDITOR_KEY, config.enabledEditors)) { return []; }
    return discoverCopilotCliSessions(config.copilotCliSessionStateDirectory);
  },

  async parse(disc: DiscoveredSession): Promise<ParsedSession | null> {
    const { events, parseErrors } = readCliEvents(disc.mainJsonlPath);
    const { parsed, stats } = collectCopilotCliEvents(events, disc.sessionId, disc.workspaceId, disc.dirPath);
    if (parseErrors > 0) {
      console.warn(`[AIUsageTracker] ${disc.sessionId}: skipped ${parseErrors} unparseable line(s)`);
    }
    if (stats.inheritedEvents > 0) {
      console.info(`[AIUsageTracker] ${disc.sessionId}: skipped ${stats.inheritedEvents} event(s) inherited from a parent session`);
    }
    return parsed;
  },
};
