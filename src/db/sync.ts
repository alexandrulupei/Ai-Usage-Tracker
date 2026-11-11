import * as vscode from 'vscode';
import { TrackerDatabase, DatabaseBusyError } from './database';
import { computeSessionStats } from '../stats/tokenStats';
import { getConfig } from '../config';
import { exportAndParsePromptLogs, buildMatchIndex } from '../core/promptExportReader';
import { exportAndReadOtelDB, mapOtelToParsedSession } from '../core/otelReader';
import { ingestJsonlSession } from './ingest';
import { PROVIDERS } from '../core/providers';
import { PRICING_TABLE_VERSION, COST_FORMULA_VERSION } from '../stats/billingCalculator';

export interface SyncResult {
  totalDiscovered: number;
  newOrUpdated: number;
  skipped: number;
  errors: number;
  emptyCount: number;
  cachedTokensEnriched: number;
  // Hybrid source tracking
  otelSessions: number;
  jsonlSessions: number;
  otelAvailable: boolean;
  /** Stored sessions whose cost was recomputed for a newer pricing table/formula. */
  repriced: number;
  /** True when the sync didn't run because another window held the database. */
  busy: boolean;
}

let activeSync: Promise<SyncResult> | undefined;

export interface SyncOptions {
  /**
   * Call Copilot's prompt-export command in Tier 3. Default true. Automatic /
   * background syncs pass false: that command shows a "No chat prompts found to
   * export." notification whenever the window has no prompts — even when called
   * with a path (verified in Copilot Chat 0.73 source) — so running it on a timer
   * would spam users. Matching against previously stored export entries still
   * runs. Current debug logs carry cachedTokens on every call anyway; manual
   * Refresh still performs the export.
   */
  includePromptExport?: boolean;
  /**
   * How long to wait if another VS Code window is writing the database. Background
   * syncs pass 0: the other window is already doing the same work, so skip.
   * Default 2 minutes (manual refresh).
   */
  waitForOtherWindowMs?: number;
}

/**
 * Three-tier hybrid sync:
 *   Tier 1: OTel Agent Traces DB (primary — richest data)
 *   Tier 2: JSONL logs (fallback — historical / when OTel unavailable)
 *   Tier 3: Prompt Export (supplemental — only for JSONL sessions missing cached tokens)
 */
export async function syncAll(
  db: TrackerDatabase,
  progress?: vscode.Progress<{ message?: string; increment?: number }>,
  wasmPath?: string,
  options: SyncOptions = {}
): Promise<SyncResult> {
  if (activeSync) { return activeSync; }
  // The whole sync is one cross-window transaction: it starts from the latest
  // file on disk and saves before releasing the lock (see TrackerDatabase).
  activeSync = db.withWriteLock(
    () => syncAllInternal(db, progress, wasmPath, options),
    {
      timeoutMs: options.waitForOtherWindowMs ?? 120_000,
      onWait: () => progress?.report({ message: 'Waiting for another VS Code window to finish syncing...' }),
    },
  ).catch(err => {
    if (err instanceof DatabaseBusyError) { return { ...emptyResult(), busy: true }; }
    throw err;
  }).finally(() => {
    activeSync = undefined;
  });
  return activeSync;
}

function emptyResult(): SyncResult {
  return {
    totalDiscovered: 0, newOrUpdated: 0, skipped: 0, errors: 0, emptyCount: 0,
    cachedTokensEnriched: 0, otelSessions: 0, jsonlSessions: 0, otelAvailable: false,
    repriced: 0, busy: false,
  };
}

async function syncAllInternal(
  db: TrackerDatabase,
  progress: vscode.Progress<{ message?: string; increment?: number }> | undefined,
  wasmPath: string | undefined,
  options: SyncOptions
): Promise<SyncResult> {
  const config = getConfig();

  const result: SyncResult = emptyResult();

  // Track which session IDs were already ingested from OTel
  const otelSessionIds = new Set<string>();

  // ---- Tier 1: OTel Agent Traces DB ---------------------------------------
  if (wasmPath) {
    try {
      progress?.report({ message: 'Exporting OTel traces...' });
      const otelData = await exportAndReadOtelDB(wasmPath);
      result.otelAvailable = otelData.length > 0;

      if (otelData.length > 0) {
        progress?.report({ message: `Processing ${otelData.length} OTel sessions...` });
        for (const data of otelData) {
          try {
            const parsed = mapOtelToParsedSession(data);
            if (!parsed || parsed.llmRequests.length === 0) {
              result.emptyCount++;
              continue;
            }

            // Check if we already have this session with the same data source
            const existingSource = db.getSessionDataSource(parsed.session.id);
            if (existingSource === 'otel') {
              // Already ingested from OTel — skip unless data changed.
              // OTel DB is always re-exported fresh, so we re-ingest to get latest spans.
              db.deleteSessionData(parsed.session.id);
            }

            db.upsertSession(parsed.session, Date.now());
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

            const stats = computeSessionStats(parsed);
            db.upsertSessionStats(stats);

            otelSessionIds.add(parsed.session.id);
            result.otelSessions++;
            result.newOrUpdated++;
          } catch (err) {
            result.errors++;
            console.error(`Error processing OTel session ${data.session.id}:`, err);
          }
        }
      }
    } catch (err) {
      // Non-fatal — fall through to JSONL
      console.warn('[CopilotTracker] OTel tier failed, falling back to JSONL:', err);
    }
  }

  // ---- Tier 2: provider adapters (JSONL/transcript) ------------------------
  // Each adapter (Copilot, Claude) discovers sessions on disk and parses them to
  // the shared ParsedSession shape. OTel-covered Copilot sessions are skipped
  // (richer data wins). Discovery is read-only and tolerant of missing roots.
  const discoveredPairs: { adapter: typeof PROVIDERS[number]; disc: ReturnType<typeof PROVIDERS[number]['discover']>[number] }[] = [];
  for (const adapter of PROVIDERS) {
    let found: ReturnType<typeof adapter.discover>;
    try {
      found = adapter.discover(config);
    } catch (err) {
      console.warn(`[AIUsageTracker] ${adapter.id} discovery failed:`, err);
      continue;
    }
    for (const disc of found) {
      discoveredPairs.push({ adapter, disc });
    }
  }
  result.totalDiscovered = discoveredPairs.length + result.otelSessions;

  const incrementPer = discoveredPairs.length > 0 ? 80 / discoveredPairs.length : 80;

  for (const { adapter, disc } of discoveredPairs) {
    // Copilot sessions already ingested from OTel (richer) win.
    if (adapter.id === 'copilot' && otelSessionIds.has(disc.sessionId)) {
      result.skipped++;
      continue;
    }

    progress?.report({ message: `Parsing ${disc.sessionId.substring(0, 14)}...`, increment: incrementPer });

    const existingMtime = db.getSessionMtime(disc.sessionId);
    if (existingMtime !== undefined && existingMtime >= disc.mtimeMs) {
      result.skipped++;
      continue;
    }

    try {
      const parsed = await adapter.parse(disc, config.parseSubagentLogs);
      // A session with chat requests but no LLM calls (every request failed, e.g.
      // "Language model unavailable") is still real activity: ingest it so its
      // chat requests are counted. Only sessions with neither are "empty".
      if (!parsed || (parsed.llmRequests.length === 0 && parsed.userMessages.length === 0)) {
        // Clear any stale rows from a prior non-empty parse before recording the
        // session as empty, so orphaned requests don't linger (§15 #11b).
        if (existingMtime !== undefined) { db.deleteSessionData(disc.sessionId); }
        if (parsed?.session) {
          parsed.session.provider = adapter.id;
          db.upsertSession(parsed.session, disc.mtimeMs);
        }
        result.emptyCount++;
        continue;
      }

      // Invariant (§6): the discovered id, the parsed session id, and every child
      // record's sessionId must all agree, or mtime-skip / FK joins break.
      parsed.session.id = disc.sessionId;
      ingestJsonlSession(db, disc, parsed, existingMtime !== undefined);

      result.jsonlSessions++;
      result.newOrUpdated++;
    } catch (err) {
      result.errors++;
      console.error(`Error parsing session ${disc.sessionId}:`, err);
    }
  }

  // ---- Tier 3: Prompt Export enrichment (only for JSONL sessions) ----------
  // OTel sessions already have real cached_tokens — no enrichment needed.
  // Only enrich JSONL-sourced sessions that lack cached token data.
  try {
    progress?.report({ message: 'Enriching cached token data...' });

    // Step 1: Export fresh data from the current VS Code session. Skipped for
    // background syncs (see SyncOptions.includePromptExport) — it is the only
    // step that can raise a Copilot notification; steps 3-4 are DB-only.
    if (options.includePromptExport !== false) {
      const freshEntries = await exportAndParsePromptLogs();
      if (freshEntries.length > 0) {
        // Step 2: Persist to DB so it survives restarts.
        db.storePromptExportEntries(freshEntries);
      }
    }

    // Step 3: Build index from ALL stored entries (fresh + previously stored).
    const allStored = db.getStoredPromptExportEntries();
    if (allStored.length > 0) {
      const matchIndex = buildMatchIndex(allStored);
      const enrichedSessionIds = new Set<string>();

      // Step 4: Match against JSONL-sourced records that lack cached token data.
      const candidates = db.getRequestsWithoutCachedTokens(0, Date.now());

      for (const req of candidates) {
        const match = matchIndex.findMatch(
          req.model, req.inputTokens, req.outputTokens, req.timestamp
        );
        if (match) {
          db.updateCachedTokens(req.sessionId, req.spanId, match.cachedPromptTokens, {
            source: 'prompt_export',
            promptExportKey: match.entry.key,
            confidence: match.confidence,
            reasoningTokens: match.reasoningTokens,
            cacheWriteTokens: match.cacheWriteTokens > 0 ? match.cacheWriteTokens : undefined,
            auditFlags: match.auditFlags,
          });
          enrichedSessionIds.add(req.sessionId);
          result.cachedTokensEnriched++;
        }
      }

      for (const sessionId of enrichedSessionIds) {
        recomputeStoredSessionStats(db, sessionId);
      }
    }

    // Prune entries older than 30 days to keep the table bounded.
    db.prunePromptExportCache(30);
  } catch (err) {
    // Non-fatal — we still have estimated values as fallback.
    console.warn('[CopilotTracker] Cached token enrichment failed:', err);
  }

  // ---- Reprice: sessions stored under an older pricing table / cost formula ----
  // Runs after ingest + enrichment so it sees final rows. Cheap no-op once current.
  try {
    const stale = db.getSessionIdsWithStaleCost(PRICING_TABLE_VERSION, COST_FORMULA_VERSION);
    if (stale.length > 0) {
      progress?.report({ message: `Repricing ${stale.length} sessions...` });
      for (const sessionId of stale) { recomputeStoredSessionStats(db, sessionId); }
      result.repriced = stale.length;
    }
  } catch (err) {
    console.warn('[AIUsageTracker] Repricing stored sessions failed:', err);
  }

  db.flush();
  return result;
}

function recomputeStoredSessionStats(db: TrackerDatabase, sessionId: string): void {
  const detail = db.getSessionDetail(sessionId);
  if (!detail) { return; }
  const toolCalls = db.getSessionToolCalls(sessionId);
  const namesFromRows = [...new Set(
    detail.requests
      .filter(r => r.isSubagent && r.subagentName)
      .map(r => r.subagentName!)
  )];
  // The original parse also counts subagents seen only as events (no LLM rows);
  // keep the stored count so recomputing cost never shrinks this metric.
  const storedCount = detail.stats.subagentCount || 0;
  const subagentNames = storedCount > namesFromRows.length
    ? [...namesFromRows, ...Array.from({ length: storedCount - namesFromRows.length }, (_, i) => `subagent-${i + 1}`)]
    : namesFromRows;
  const stats = computeSessionStats({
    session: detail.session,
    llmRequests: detail.requests,
    userMessages: detail.messages,
    toolCalls,
    turnCount: detail.stats.turnCount,
    subagentNames,
    childSessionFiles: [],
    models: new Map(),
  });
  db.upsertSessionStats(stats);
}
