import { TrackerDatabase } from './database';
import { DiscoveredSession, ParsedSession } from '../core/types';
import { computeSessionStats } from '../stats/tokenStats';

/**
 * Ingest a fully-parsed JSONL session into the database.
 *
 * Ordering is deliberate: the file mtime is persisted ONLY after every write
 * has succeeded. The session row is first written with mtime 0 (present, but
 * not yet "up-to-date"), then the real mtime is recorded at the very end. If
 * any insert in between throws, the stored mtime stays 0, so the next sync
 * re-parses the session instead of skipping it as up-to-date with no data.
 *
 * (This is what previously stranded sessions as permanently "empty": the old
 * code recorded the mtime before the inserts, so a failed insert left the
 * session looking current while holding zero rows.)
 *
 * Caller guarantees the session has LLM requests and/or user messages (a session
 * whose requests all failed has messages but no LLM rows; stats handle zero).
 */
export function ingestJsonlSession(
  db: TrackerDatabase,
  disc: DiscoveredSession,
  parsed: ParsedSession,
  hadExistingRow: boolean
): void {
  if (hadExistingRow) {
    db.deleteSessionData(disc.sessionId);
  }

  // Create/refresh the session row but do NOT mark it up-to-date yet.
  db.upsertSession(parsed.session, 0);

  db.insertLLMRequests(parsed.llmRequests);
  db.insertUserMessages(parsed.userMessages);
  db.insertToolCalls(parsed.toolCalls);

  for (const [, model] of parsed.models) {
    db.upsertModelBilling(
      model.id, model.name, model.vendor,
      model.billingMultiplier, model.isPremium,
      model.maxContextTokens, model.maxOutputTokens
    );
  }

  db.upsertSessionStats(computeSessionStats(parsed));

  // All writes succeeded: record the file mtime so future syncs can skip it.
  db.upsertSession(parsed.session, disc.mtimeMs);
}
