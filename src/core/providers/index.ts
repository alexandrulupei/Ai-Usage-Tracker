import { ProviderAdapter } from './types';
import { copilotAdapter } from './copilotAdapter';
import { claudeAdapter } from './claudeAdapter';
import { copilotCliAdapter } from './copilotCliAdapter';

/**
 * The ordered provider registry consumed by the JSONL/transcript tier of
 * syncAll. OTel (Copilot Tier-1) is handled separately in sync.ts because it
 * is command-driven, not filesystem-discoverable.
 */
export const PROVIDERS: ProviderAdapter[] = [copilotAdapter, copilotCliAdapter, claudeAdapter];

export { ProviderAdapter };
export { copilotAdapter, copilotCliAdapter, claudeAdapter };
