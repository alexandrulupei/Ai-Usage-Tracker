import initSqlJs, { Database as SqlJsDatabase, SqlJsStatic } from 'sql.js';
import { acquireLock } from './fileLock';
import * as path from 'path';
import * as fs from 'fs';
import {
  SessionInfo,
  LLMRequestRecord,
  UserMessageRecord,
  ToolCallRecord,
  SessionStats,
  SessionAnalytics,
  WorkflowInsights,
  AggregateStats,
  DailyStats,
  ModelStats,
  TokenDataSource,
  ProviderId,
} from '../core/types';
import { computeCostUSD, computeListCostUSD, getPricing } from '../stats/billingCalculator';

/** Block the thread for `ms` (used only for short rename retries). */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Move `tmp` over `target`. Rename is atomic, but on Windows it fails with
 * EPERM/EBUSY/EACCES while another process has `target` open (e.g. another
 * window reading it to reload), so retry briefly; as a last resort copy the
 * bytes over (still under the write lock, and readers re-check on failure).
 */
function replaceFile(tmp: string, target: string): void {
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      fs.renameSync(tmp, target);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES') { throw err; }
      sleepSync(50);
    }
  }
  fs.copyFileSync(tmp, target);
  try { fs.unlinkSync(tmp); } catch { /* best effort */ }
}

/** Billed credits on a raw llm_requests row, or undefined when not reported. */
function rowDirectCredits(row: Record<string, unknown>): number | undefined {
  const v = row.direct_credits;
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}
import { estimateSessionCaching } from '../stats/cacheEstimator';

type SqlValue = string | number | null | Uint8Array;
type SqlRow = Record<string, unknown>;

const DB_FILENAME = 'copilot-usage.db';
const SCHEMA_VERSION = 14;

/** Thrown by withWriteLock when another window holds the lock for the whole timeout. */
export class DatabaseBusyError extends Error {
  constructor() { super('The usage database is busy (another VS Code window is writing to it).'); }
}

export interface WriteLockOptions {
  /** How long to wait for another window to finish (0 = don't wait). */
  timeoutMs?: number;
  /** Called once if we have to wait for another window. */
  onWait?: () => void;
}

/** How often readers check the file for changes made by other windows. */
const RELOAD_CHECK_MS = 1_500;

/**
 * The tracker database. sql.js keeps the whole database in memory, and every VS
 * Code window (a separate extension-host process) has its own copy of the same
 * file, so access is coordinated:
 *  - WRITES happen only inside withWriteLock(): take the cross-process lock,
 *    reload from disk if another window changed the file, apply the changes,
 *    save atomically (temp file + rename), release. No window can overwrite
 *    another's newer data.
 *  - READS reload the in-memory copy when the file on disk has changed (checked
 *    at most every RELOAD_CHECK_MS), so every window shows current data.
 */
export class TrackerDatabase {
  private db!: SqlJsDatabase;
  private SQL!: SqlJsStatic;
  private dbPath: string;
  private lockDir: string;
  private dirty = false;
  /** True while this process holds the cross-process write lock. */
  private lockHeld = false;
  /** mtime+size of the file as of our last load/save ('' = never loaded). */
  private diskSignature = '';
  private lastReloadCheck = 0;
  /** Serializes withWriteLock callers inside this process. */
  private writeQueue: Promise<unknown> = Promise.resolve();
  private reloadListeners: (() => void)[] = [];

  private constructor(storagePath: string) {
    this.dbPath = path.join(storagePath, DB_FILENAME);
    this.lockDir = this.dbPath + '.lock';
  }

  static async create(storagePath: string, wasmPath: string): Promise<TrackerDatabase> {
    const instance = new TrackerDatabase(storagePath);
    fs.mkdirSync(storagePath, { recursive: true });
    instance.SQL = await initSqlJs({ locateFile: () => wasmPath });

    // Load what is on disk now (so views work immediately), then create/migrate
    // the schema under the lock so two windows starting together can't race.
    try {
      instance.loadFromDisk();
    } catch (err) {
      // Unreadable right now (caught mid-write by another window): start empty;
      // the locked step below reloads from disk because the signature differs.
      console.warn('[AIUsageTracker] database unreadable at startup, will reload under lock:', err);
      instance.db = new instance.SQL.Database();
      instance.diskSignature = '';
    }
    instance.initialize(false);
    // Only a new or older-schema file needs persisting now; normally the schema is
    // current and startup never touches the lock (so opening a window while
    // another one syncs doesn't delay this window's views).
    if (instance.dirty) {
      try {
        await instance.withWriteLock(() => undefined, { timeoutMs: 5_000 });
      } catch (err) {
        // Another window is mid-write (it is a new version too, so it migrated the
        // file already). Our in-memory copy is migrated and fully usable; the next
        // locked write reloads from disk and persists whatever is still needed.
        if (!(err instanceof DatabaseBusyError)) { throw err; }
        console.warn('[AIUsageTracker] database busy at startup; continuing with the in-memory copy');
      }
    }
    return instance;
  }

  /**
   * Run `fn` with exclusive write access across all VS Code windows. Changes made
   * by `fn` are saved before the lock is released. Rejects with DatabaseBusyError
   * if another window holds the lock longer than `timeoutMs` (default 2 min).
   */
  withWriteLock<T>(fn: () => T | Promise<T>, opts: WriteLockOptions = {}): Promise<T> {
    const run = async (): Promise<T> => {
      const handle = await acquireLock(this.lockDir, {
        timeoutMs: opts.timeoutMs ?? 120_000,
        onWait: opts.onWait,
      });
      if (!handle) { throw new DatabaseBusyError(); }
      this.lockHeld = true;
      try {
        // Another window may have written since we last looked: start from disk.
        if (this.reloadIfDiskChanged()) { this.notifyReload(); }
        this.initialize(true);
        const result = await fn();
        this.flush();
        return result;
      } finally {
        this.lockHeld = false;
        handle.release();
      }
    };
    // Queue behind any write already in progress in this window.
    const next = this.writeQueue.then(run, run);
    this.writeQueue = next.catch(() => undefined);
    return next;
  }

  /**
   * Check whether another window changed the database file and reload if so.
   * Returns true when fresh data was loaded. Cheap (one stat) when unchanged.
   */
  checkForExternalChanges(): boolean {
    if (this.lockHeld) { return false; }
    this.lastReloadCheck = Date.now();
    const reloaded = this.reloadIfDiskChanged();
    if (reloaded) {
      this.initialize(false);   // an older window version may have written it
      this.notifyReload();
    }
    return reloaded;
  }

  /** Register a callback for when data written by another window is loaded. */
  onDidReloadFromDisk(listener: () => void): { dispose(): void } {
    this.reloadListeners.push(listener);
    return { dispose: () => { this.reloadListeners = this.reloadListeners.filter(l => l !== listener); } };
  }

  private notifyReload(): void {
    for (const l of this.reloadListeners) {
      try { l(); } catch (err) { console.error('[AIUsageTracker] reload listener failed:', err); }
    }
  }

  private readDiskSignature(): string {
    try {
      const st = fs.statSync(this.dbPath);
      return `${st.mtimeMs}:${st.size}`;
    } catch {
      return 'missing';
    }
  }

  private loadFromDisk(): void {
    const signature = this.readDiskSignature();
    const next = signature === 'missing'
      ? new this.SQL.Database()
      : new this.SQL.Database(fs.readFileSync(this.dbPath));
    if (this.db) { try { this.db.close(); } catch { /* already closed */ } }
    this.db = next;
    this.diskSignature = signature;
    this.dirty = false;
  }

  /** Reload when the file differs from what we last loaded/saved. */
  private reloadIfDiskChanged(): boolean {
    const signature = this.readDiskSignature();
    if (signature === this.diskSignature || signature === 'missing') { return false; }
    try {
      this.loadFromDisk();
      return true;
    } catch (err) {
      // E.g. caught mid-replace on a filesystem without atomic rename: keep the
      // current copy and try again on the next check.
      console.warn('[AIUsageTracker] could not reload database from disk:', err);
      return false;
    }
  }

  /**
   * Create or migrate the schema. With `persist` (only under the write lock) the
   * result is saved; otherwise it is kept in memory and marked dirty so the next
   * locked write persists it.
   */
  private initialize(persist: boolean): void {
    const result = this.db.exec('PRAGMA user_version');
    const version = result.length > 0 ? (result[0].values[0][0] as number) : 0;
    if (version >= SCHEMA_VERSION) { return; }
    if (version === 0) {
      this.db.run(SCHEMA_SQL);
    } else {
      this.migrate(version);
    }
    this.db.run(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    this.markDirty();
    if (persist) { this.save(); }
  }

  private migrate(from: number): void {
    if (from < 2) {
      // Add cached / cache-write token columns. SQLite doesn't support IF NOT EXISTS
      // for ALTER, so guard with a column probe.
      const cols = this.db.exec("PRAGMA table_info(llm_requests)");
      const names = new Set<string>(
        cols.length > 0 ? cols[0].values.map(r => String(r[1])) : []
      );
      if (!names.has('cached_input_tokens')) {
        this.db.run('ALTER TABLE llm_requests ADD COLUMN cached_input_tokens INTEGER DEFAULT 0');
      }
      if (!names.has('cache_write_tokens')) {
        this.db.run('ALTER TABLE llm_requests ADD COLUMN cache_write_tokens INTEGER DEFAULT 0');
      }
    }
    if (from < 3) {
      // Persist prompt export data so real cached token counts survive VS Code restarts.
      this.db.run(PROMPT_EXPORT_CACHE_SQL);
    }
    if (from < 4) {
      // Add OTel-sourced columns to sessions, llm_requests, tool_calls, session_stats.
      const sessCols = this.getColumnNames('sessions');
      if (!sessCols.has('repository')) {
        this.db.run('ALTER TABLE sessions ADD COLUMN repository TEXT');
      }
      if (!sessCols.has('branch')) {
        this.db.run('ALTER TABLE sessions ADD COLUMN branch TEXT');
      }
      if (!sessCols.has('cwd')) {
        this.db.run('ALTER TABLE sessions ADD COLUMN cwd TEXT');
      }
      if (!sessCols.has('agent_name')) {
        this.db.run('ALTER TABLE sessions ADD COLUMN agent_name TEXT');
      }
      if (!sessCols.has('agent_description')) {
        this.db.run('ALTER TABLE sessions ADD COLUMN agent_description TEXT');
      }
      if (!sessCols.has('data_source')) {
        this.db.run("ALTER TABLE sessions ADD COLUMN data_source TEXT DEFAULT 'jsonl'");
      }

      const reqCols = this.getColumnNames('llm_requests');
      if (!reqCols.has('reasoning_tokens')) {
        this.db.run('ALTER TABLE llm_requests ADD COLUMN reasoning_tokens INTEGER DEFAULT 0');
      }
      if (!reqCols.has('response_model')) {
        this.db.run('ALTER TABLE llm_requests ADD COLUMN response_model TEXT');
      }
      if (!reqCols.has('trace_id')) {
        this.db.run('ALTER TABLE llm_requests ADD COLUMN trace_id TEXT');
      }
      if (!reqCols.has('conversation_id')) {
        this.db.run('ALTER TABLE llm_requests ADD COLUMN conversation_id TEXT');
      }

      const toolCols = this.getColumnNames('tool_calls');
      if (!toolCols.has('tool_type')) {
        this.db.run('ALTER TABLE tool_calls ADD COLUMN tool_type TEXT');
      }
      if (!toolCols.has('tool_call_id')) {
        this.db.run('ALTER TABLE tool_calls ADD COLUMN tool_call_id TEXT');
      }

      const statsCols = this.getColumnNames('session_stats');
      if (!statsCols.has('total_reasoning_tokens')) {
        this.db.run('ALTER TABLE session_stats ADD COLUMN total_reasoning_tokens INTEGER DEFAULT 0');
      }
      if (!statsCols.has('total_cached_tokens')) {
        this.db.run('ALTER TABLE session_stats ADD COLUMN total_cached_tokens INTEGER DEFAULT 0');
      }
      if (!statsCols.has('data_source')) {
        this.db.run("ALTER TABLE session_stats ADD COLUMN data_source TEXT DEFAULT 'jsonl'");
      }
    }
    if (from < 5) {
      const reqCols = this.getColumnNames('llm_requests');
      this.addColumnIfMissing(reqCols, 'llm_requests', 'input_tokens_source', "TEXT DEFAULT 'unknown'");
      this.addColumnIfMissing(reqCols, 'llm_requests', 'output_tokens_source', "TEXT DEFAULT 'unknown'");
      this.addColumnIfMissing(reqCols, 'llm_requests', 'cached_input_tokens_source', "TEXT DEFAULT 'unknown'");
      this.addColumnIfMissing(reqCols, 'llm_requests', 'cache_write_tokens_source', "TEXT DEFAULT 'unknown'");
      this.addColumnIfMissing(reqCols, 'llm_requests', 'reasoning_tokens_source', "TEXT DEFAULT 'unknown'");
      this.addColumnIfMissing(reqCols, 'llm_requests', 'prompt_export_key', 'TEXT');
      this.addColumnIfMissing(reqCols, 'llm_requests', 'cache_match_confidence', 'REAL');
      this.addColumnIfMissing(reqCols, 'llm_requests', 'token_audit_flags', "TEXT DEFAULT '[]'");

      const statsCols = this.getColumnNames('session_stats');
      this.addColumnIfMissing(statsCols, 'session_stats', 'total_cache_write_tokens', 'INTEGER DEFAULT 0');
      this.addColumnIfMissing(statsCols, 'session_stats', 'cost_audit_state', "TEXT DEFAULT 'estimated'");
      this.addColumnIfMissing(statsCols, 'session_stats', 'cost_audit_flags', "TEXT DEFAULT '[]'");
      this.addColumnIfMissing(statsCols, 'session_stats', 'pricing_table_version', 'INTEGER DEFAULT 0');
      this.addColumnIfMissing(statsCols, 'session_stats', 'cost_formula_version', 'INTEGER DEFAULT 0');

      const promptCols = this.getColumnNames('prompt_export_cache');
      this.addColumnIfMissing(promptCols, 'prompt_export_cache', 'timestamp_ms', 'INTEGER');

      this.db.run(`DELETE FROM llm_requests
        WHERE span_id IS NOT NULL AND span_id != ''
          AND id NOT IN (
            SELECT MIN(id) FROM llm_requests
            WHERE span_id IS NOT NULL AND span_id != ''
            GROUP BY session_id, span_id
          )`);
      this.db.run("CREATE UNIQUE INDEX IF NOT EXISTS idx_llm_session_span_unique ON llm_requests(session_id, span_id) WHERE span_id IS NOT NULL AND span_id != ''");
    }
    if (from < 6) {
      const promptCols = this.getColumnNames('prompt_export_cache');
      this.addColumnIfMissing(promptCols, 'prompt_export_cache', 'cache_write_tokens', 'INTEGER DEFAULT 0');
    }
    if (from < 7) {
      // Add direct_credits column: credits reported directly by the Copilot API
      // (post-June 2026 billing change). NULL = not available (use token formula).
      const reqCols = this.getColumnNames('llm_requests');
      this.addColumnIfMissing(reqCols, 'llm_requests', 'direct_credits', 'REAL');
      this.addColumnIfMissing(reqCols, 'llm_requests', 'direct_credits_source', 'TEXT');
    }
    if (from < 8) {
      // Heal DBs created fresh at v7: the v0 init path ran SCHEMA_SQL (which was
      // missing these columns) and returned before migrate(), so the v7 block
      // above never ran for them. Ensure the columns exist. addColumnIfMissing
      // is idempotent, so this is safe regardless of how the DB reached here.
      const reqCols = this.getColumnNames('llm_requests');
      this.addColumnIfMissing(reqCols, 'llm_requests', 'direct_credits', 'REAL');
      this.addColumnIfMissing(reqCols, 'llm_requests', 'direct_credits_source', 'TEXT');
    }
    if (from < 9) {
      // Add the `provider` discriminator (multi-provider support: Copilot + Claude).
      // Orthogonal to data_source. Existing rows default to 'copilot' via the column
      // DEFAULT, so this is a pure additive migration — no backfill, no data loss.
      // Must mirror the columns added to SCHEMA_SQL (fresh installs run SCHEMA_SQL
      // and return before migrate(), so both code paths must agree).
      const sessCols = this.getColumnNames('sessions');
      this.addColumnIfMissing(sessCols, 'sessions', 'provider', "TEXT DEFAULT 'copilot'");

      const reqCols = this.getColumnNames('llm_requests');
      this.addColumnIfMissing(reqCols, 'llm_requests', 'provider', "TEXT DEFAULT 'copilot'");

      const statsCols = this.getColumnNames('session_stats');
      this.addColumnIfMissing(statsCols, 'session_stats', 'provider', "TEXT DEFAULT 'copilot'");

      this.db.run('CREATE INDEX IF NOT EXISTS idx_llm_provider ON llm_requests(provider)');
    }
    if (from < 10) {
      // Rich-detail capture: full message text, tool input/output, assistant output.
      // Nullable additive columns; existing rows stay NULL until re-parsed.
      const msgCols = this.getColumnNames('user_messages');
      this.addColumnIfMissing(msgCols, 'user_messages', 'content_full', 'TEXT');

      const toolCols = this.getColumnNames('tool_calls');
      this.addColumnIfMissing(toolCols, 'tool_calls', 'args', 'TEXT');
      this.addColumnIfMissing(toolCols, 'tool_calls', 'result', 'TEXT');
      this.addColumnIfMissing(toolCols, 'tool_calls', 'error_text', 'TEXT');

      const reqCols = this.getColumnNames('llm_requests');
      this.addColumnIfMissing(reqCols, 'llm_requests', 'output_text', 'TEXT');
      this.addColumnIfMissing(reqCols, 'llm_requests', 'reasoning_text', 'TEXT');
    }
    if (from < 11) {
      // The v10 rich-detail columns are only populated when a session is parsed,
      // but existing sessions are mtime-skipped on sync. Reset file_mtime so the
      // next syncAll re-parses every session once and backfills the new fields
      // (output text, tool input/result, full messages). One-time cost.
      this.db.run('UPDATE sessions SET file_mtime = 0');
    }
    if (from < 12) {
      // Add the 1-hour-TTL cache-write subset column (Anthropic prices 1h writes at
      // 2x input vs 1.25x for 5m). Also force a full re-parse: (a) to backfill this
      // column from cache_creation.ephemeral_1h_input_tokens, and (b) because Claude
      // discovery now recurses the session subtree (subagents/workflows/wf_*/…), so a
      // re-parse captures the previously-dropped nested subagent transcripts.
      const reqCols = this.getColumnNames('llm_requests');
      this.addColumnIfMissing(reqCols, 'llm_requests', 'cache_write_1h_tokens', 'INTEGER DEFAULT 0');
      this.db.run('UPDATE sessions SET file_mtime = 0');
    }
    if (from < 13) {
      // Copilot debug-log span ids are per-process counters that restart when a chat
      // is resumed after a reload; distinct calls sharing an id were collapsed by the
      // (session_id, span_id) unique index + INSERT OR REPLACE. The parser now
      // namespaces ids per epoch/file, so force a one-time re-parse of Copilot JSONL
      // sessions to recover the dropped calls. ingestJsonlSession deletes the old
      // rows first, so no stale/duplicate rows survive. Claude rows are untouched
      // (their ids are API requestIds and were never affected).
      this.db.run("UPDATE sessions SET file_mtime = 0 WHERE COALESCE(provider, 'copilot') = 'copilot' AND COALESCE(data_source, 'jsonl') = 'jsonl'");
    }
    if (from < 14) {
      // Chat-request accuracy: subagent prompts (runSubagent-*.jsonl user_message)
      // are no longer stored as user messages, and sessions whose requests all
      // failed now keep their prompts. Re-parse Copilot JSONL sessions once so
      // stored user_messages match (verified against VS Code chat history).
      this.db.run("UPDATE sessions SET file_mtime = 0 WHERE COALESCE(provider, 'copilot') = 'copilot' AND COALESCE(data_source, 'jsonl') = 'jsonl'");
    }
  }

  /**
   * Atomically replace the database file: write a temp file, then rename it over
   * the original, so another window never reads a half-written database.
   * Only called while holding the write lock.
   */
  private save(): void {
    if (!this.lockHeld) {
      // Writing without the lock could overwrite another window's newer data.
      console.error('[AIUsageTracker] refusing to save the database without the write lock');
      return;
    }
    const buffer = Buffer.from(this.db.export());
    const tmp = `${this.dbPath}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, buffer);
    replaceFile(tmp, this.dbPath);
    this.diskSignature = this.readDiskSignature();
    this.dirty = false;
  }

  /** Save pending changes. Only effective while holding the write lock. */
  flush(): void {
    if (this.dirty) { this.save(); }
  }

  private markDirty(): void { this.dirty = true; }

  private getColumnNames(table: string): Set<string> {
    const cols = this.db.exec(`PRAGMA table_info(${table})`);
    return new Set(cols.length > 0 ? cols[0].values.map(r => String(r[1])) : []);
  }

  private addColumnIfMissing(cols: Set<string>, table: string, column: string, definition: string): void {
    if (!cols.has(column)) {
      this.db.run(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
      cols.add(column);
    }
  }

  // ---- Write operations ---------------------------------------------------

  upsertSession(s: SessionInfo, mtimeMs: number): void {
    this.db.run(
      `INSERT INTO sessions (id, workspace_id, dir_path, start_time, end_time, copilot_version, vscode_version, file_mtime, parsed_at, repository, branch, cwd, agent_name, agent_description, data_source, provider)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         end_time=excluded.end_time, copilot_version=excluded.copilot_version,
         vscode_version=excluded.vscode_version, file_mtime=excluded.file_mtime, parsed_at=excluded.parsed_at,
         repository=excluded.repository, branch=excluded.branch, cwd=excluded.cwd,
         agent_name=excluded.agent_name, agent_description=excluded.agent_description,
         data_source=excluded.data_source, provider=excluded.provider`,
      [s.id, s.workspaceId, s.dirPath, s.startTime, s.endTime, s.copilotVersion, s.vscodeVersion, mtimeMs, Date.now(),
       s.repository ?? null, s.branch ?? null, s.cwd ?? null, s.agentName ?? null, s.agentDescription ?? null, s.dataSource ?? 'jsonl', s.provider ?? 'copilot']
    );
    this.markDirty();
  }

  insertLLMRequests(requests: LLMRequestRecord[]): void {
    const stmt = this.db.prepare(
      `INSERT OR REPLACE INTO llm_requests (session_id, span_id, parent_span_id, timestamp, duration, model, input_tokens, output_tokens, cached_input_tokens, cache_write_tokens, cache_write_1h_tokens, ttft, max_tokens, status, error, is_subagent, subagent_name, user_request_preview, reasoning_tokens, response_model, trace_id, conversation_id, input_tokens_source, output_tokens_source, cached_input_tokens_source, cache_write_tokens_source, reasoning_tokens_source, prompt_export_key, cache_match_confidence, token_audit_flags, direct_credits, direct_credits_source, provider, output_text, reasoning_text)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    for (const r of requests) {
      stmt.run([r.sessionId, r.spanId, r.parentSpanId ?? null, r.timestamp, r.duration, r.model, r.inputTokens, r.outputTokens, r.cachedInputTokens ?? 0, r.cacheWriteTokens ?? 0, r.cacheWrite1hTokens ?? 0, r.ttft, r.maxTokens, r.status, r.error ?? null, r.isSubagent ? 1 : 0, r.subagentName ?? null, r.userRequestPreview ?? null, r.reasoningTokens ?? 0, r.responseModel ?? null, r.traceId ?? null, r.conversationId ?? null, r.inputTokensSource ?? 'unknown', r.outputTokensSource ?? 'unknown', r.cachedInputTokensSource ?? 'unknown', r.cacheWriteTokensSource ?? 'unknown', r.reasoningTokensSource ?? 'unknown', r.promptExportKey ?? null, r.cacheMatchConfidence ?? null, JSON.stringify(r.tokenAuditFlags ?? []), r.directCredits ?? null, r.directCreditsSource ?? null, r.provider ?? 'copilot', r.outputText ?? null, r.reasoningText ?? null]);
    }
    stmt.free();
    this.markDirty();
  }

  insertUserMessages(messages: UserMessageRecord[]): void {
    const stmt = this.db.prepare(
      `INSERT INTO user_messages (session_id, span_id, timestamp, content_length, content_preview, content_full) VALUES (?, ?, ?, ?, ?, ?)`
    );
    for (const m of messages) {
      stmt.run([m.sessionId, m.spanId, m.timestamp, m.contentLength, m.contentPreview, m.contentFull ?? null]);
    }
    stmt.free();
    this.markDirty();
  }

  insertToolCalls(toolCalls: ToolCallRecord[]): void {
    const stmt = this.db.prepare(
      `INSERT INTO tool_calls (session_id, span_id, parent_span_id, timestamp, duration, tool_name, status, is_subagent, tool_type, tool_call_id, args, result, error_text) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    for (const t of toolCalls) {
      stmt.run([t.sessionId, t.spanId, t.parentSpanId ?? null, t.timestamp, t.duration, t.toolName, t.status, t.isSubagent ? 1 : 0, t.toolType ?? null, t.toolCallId ?? null, t.args ?? null, t.result ?? null, t.errorText ?? null]);
    }
    stmt.free();
    this.markDirty();
  }

  upsertSessionStats(stats: SessionStats): void {
    this.db.run(
      `INSERT INTO session_stats (session_id, total_input_tokens, total_output_tokens, total_tokens, weighted_cost, llm_request_count, user_message_count, tool_call_count, error_count, turn_count, subagent_count, avg_tokens_per_request, avg_ttft, duration_ms, models_used, dominant_model, efficiency_score, rework_score, total_reasoning_tokens, total_cached_tokens, total_cache_write_tokens, data_source, cost_audit_state, cost_audit_flags, pricing_table_version, cost_formula_version, provider)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(session_id) DO UPDATE SET
         total_input_tokens=excluded.total_input_tokens, total_output_tokens=excluded.total_output_tokens,
         total_tokens=excluded.total_tokens, weighted_cost=excluded.weighted_cost,
         llm_request_count=excluded.llm_request_count, user_message_count=excluded.user_message_count,
         tool_call_count=excluded.tool_call_count, error_count=excluded.error_count,
         turn_count=excluded.turn_count, subagent_count=excluded.subagent_count,
         avg_tokens_per_request=excluded.avg_tokens_per_request, avg_ttft=excluded.avg_ttft,
         duration_ms=excluded.duration_ms, models_used=excluded.models_used,
         dominant_model=excluded.dominant_model, efficiency_score=excluded.efficiency_score,
         rework_score=excluded.rework_score, total_reasoning_tokens=excluded.total_reasoning_tokens,
         total_cached_tokens=excluded.total_cached_tokens, total_cache_write_tokens=excluded.total_cache_write_tokens,
         data_source=excluded.data_source, cost_audit_state=excluded.cost_audit_state,
         cost_audit_flags=excluded.cost_audit_flags, pricing_table_version=excluded.pricing_table_version,
         cost_formula_version=excluded.cost_formula_version, provider=excluded.provider`,
      [stats.sessionId, stats.totalInputTokens, stats.totalOutputTokens,
       stats.totalTokens, stats.costUSD, stats.llmRequestCount,
       stats.userMessageCount, stats.toolCallCount, stats.errorCount,
       stats.turnCount, stats.subagentCount, stats.avgTokensPerRequest,
       stats.avgTtft, stats.durationMs, JSON.stringify(stats.modelsUsed),
       stats.dominantModel, stats.efficiencyScore, stats.reworkScore,
       stats.totalReasoningTokens ?? 0, stats.totalCachedTokens ?? 0,
       stats.totalCacheWriteTokens ?? 0, stats.dataSource ?? 'jsonl',
       stats.costAuditState ?? 'estimated', JSON.stringify(stats.costAuditFlags ?? []),
       stats.pricingTableVersion ?? 0, stats.costFormulaVersion ?? 0, stats.provider ?? 'copilot']
    );
    this.markDirty();
  }

  upsertModelBilling(modelId: string, name: string, vendor: string, multiplier: number, isPremium: boolean, maxCtx: number, maxOut: number): void {
    this.db.run(
      `INSERT INTO model_billing (model_id, name, vendor, multiplier, is_premium, max_context_tokens, max_output_tokens)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(model_id) DO UPDATE SET
         name=excluded.name, vendor=excluded.vendor, multiplier=excluded.multiplier,
         is_premium=excluded.is_premium, max_context_tokens=excluded.max_context_tokens,
         max_output_tokens=excluded.max_output_tokens`,
      [modelId, name, vendor, multiplier, isPremium ? 1 : 0, maxCtx, maxOut]
    );
    this.markDirty();
  }

  deleteSessionData(sessionId: string): void {
    this.db.run('DELETE FROM llm_requests WHERE session_id = ?', [sessionId]);
    this.db.run('DELETE FROM user_messages WHERE session_id = ?', [sessionId]);
    this.db.run('DELETE FROM tool_calls WHERE session_id = ?', [sessionId]);
    this.db.run('DELETE FROM session_stats WHERE session_id = ?', [sessionId]);
    this.markDirty();
  }

  /**
   * Delete all data for a single provider (CLAUDE-PROVIDER-PLAN.md §15 #10).
   * Children are deleted strictly before sessions so each `session_id IN (... WHERE
   * provider=?)` subquery still resolves. The global `model_billing` table is shared
   * across providers and intentionally left untouched.
   */
  clearProvider(provider: ProviderId): void {
    const sub = '(SELECT id FROM sessions WHERE provider = ?)';
    this.db.run(`DELETE FROM llm_requests WHERE session_id IN ${sub}`, [provider]);
    this.db.run(`DELETE FROM user_messages WHERE session_id IN ${sub}`, [provider]);
    this.db.run(`DELETE FROM tool_calls WHERE session_id IN ${sub}`, [provider]);
    this.db.run(`DELETE FROM session_stats WHERE session_id IN ${sub}`, [provider]);
    this.db.run('DELETE FROM sessions WHERE provider = ?', [provider]);
    this.markDirty();
  }

  /**
   * Sessions whose stored stats were computed with an older pricing table or cost
   * formula. They are recomputed from the rows already in the DB (no re-parse, so
   * sessions whose source logs were since deleted are repriced too).
   */
  getSessionIdsWithStaleCost(pricingTableVersion: number, costFormulaVersion: number): string[] {
    return this.queryRows(
      `SELECT session_id FROM session_stats
       WHERE COALESCE(pricing_table_version, 0) < ? OR COALESCE(cost_formula_version, 0) < ?`,
      [pricingTableVersion, costFormulaVersion]
    ).map(r => r.session_id as string);
  }

  /**
   * Update cached_input_tokens for a specific LLM request record.
   * Used to enrich records with real cached token data from the Copilot
   * prompt export (which has usage.prompt_tokens_details.cached_tokens).
   */
  updateCachedTokens(sessionId: string, spanId: string, cachedInputTokens: number, options?: { source?: TokenDataSource; promptExportKey?: string; confidence?: number; reasoningTokens?: number; cacheWriteTokens?: number; auditFlags?: string[] }): void {
    this.db.run(
      `UPDATE llm_requests SET
         cached_input_tokens = ?,
         cached_input_tokens_source = ?,
         cache_write_tokens = CASE WHEN ? IS NULL THEN cache_write_tokens ELSE ? END,
         cache_write_tokens_source = CASE WHEN ? IS NULL THEN cache_write_tokens_source ELSE ? END,
         prompt_export_key = COALESCE(?, prompt_export_key),
         cache_match_confidence = COALESCE(?, cache_match_confidence),
         reasoning_tokens = CASE WHEN ? IS NULL THEN reasoning_tokens ELSE ? END,
         reasoning_tokens_source = CASE WHEN ? IS NULL THEN reasoning_tokens_source ELSE ? END,
         token_audit_flags = ?
       WHERE session_id = ? AND span_id = ?`,
      [cachedInputTokens, options?.source ?? 'prompt_export',
       options?.cacheWriteTokens ?? null, options?.cacheWriteTokens ?? null,
       options?.cacheWriteTokens !== undefined ? (options?.source ?? 'prompt_export') : null, options?.cacheWriteTokens !== undefined ? (options?.source ?? 'prompt_export') : null,
       options?.promptExportKey ?? null,
       options?.confidence ?? null, options?.reasoningTokens ?? null, options?.reasoningTokens ?? null,
       options?.reasoningTokens ?? null, options?.source ?? 'prompt_export', JSON.stringify(options?.auditFlags ?? []),
       sessionId, spanId]
    );
    this.markDirty();
  }

  /**
   * Get all LLM requests that have no cached token data (cached_input_tokens = 0).
   * These are candidates for enrichment from the prompt export.
   */
  getRequestsWithoutCachedTokens(startMs: number, endMs: number): LLMRequestRecord[] {
    // Tier-3 prompt-export enrichment is Copilot-only. The `s.provider = 'copilot'`
    // predicate is LOAD-BEARING (CLAUDE-PROVIDER-PLAN.md §15 #7): the prompt-export
    // matcher keys only on model+tokens+timestamp (no provider dimension), and a
    // zero-cache Claude row stored with source 'unknown' would otherwise be a
    // candidate and could be cross-matched against Copilot data. Do not rely on the
    // source-string exclusion alone.
    return this.queryRows(
      `SELECT lr.*
       FROM llm_requests lr
       JOIN sessions s ON s.id = lr.session_id
       WHERE lr.timestamp >= ? AND lr.timestamp < ?
         AND lr.cached_input_tokens = 0
         AND s.provider = 'copilot'
         AND COALESCE(s.data_source, 'jsonl') != 'otel'
         AND COALESCE(lr.cached_input_tokens_source, 'unknown') NOT IN ('otel', 'prompt_export', 'jsonl', 'chat_history')
       ORDER BY lr.timestamp ASC`,
      [startMs, endMs]
    ).map(r => mapLLMRequest(r));
  }

  // ---- Prompt export cache ------------------------------------------------

  /**
   * Store prompt export entries so real cached token data survives VS Code restarts.
   * Uses INSERT OR REPLACE to update entries if they already exist (e.g. re-exported
   * with updated token counts during streaming).
   */
  storePromptExportEntries(entries: { key: string; model: string; promptTokens: number; completionTokens: number; totalTokens: number; cachedPromptTokens: number; cacheWriteTokens: number; reasoningTokens: number; durationMs: number | undefined; timeToFirstTokenMs: number | undefined; timestamp: string | undefined; timestampMs: number | undefined }[]): number {
    if (entries.length === 0) { return 0; }
    const now = Date.now();
    const stmt = this.db.prepare(
      `INSERT OR REPLACE INTO prompt_export_cache
        (key, model, prompt_tokens, completion_tokens, total_tokens, cached_prompt_tokens, cache_write_tokens, reasoning_tokens, duration_ms, time_to_first_token_ms, timestamp, timestamp_ms, stored_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    let count = 0;
    for (const e of entries) {
      stmt.run([e.key, e.model, e.promptTokens, e.completionTokens, e.totalTokens, e.cachedPromptTokens, e.cacheWriteTokens, e.reasoningTokens, e.durationMs ?? null, e.timeToFirstTokenMs ?? null, e.timestamp ?? null, e.timestampMs ?? null, now]);
      count++;
    }
    stmt.free();
    this.markDirty();
    return count;
  }

  /**
   * Read all stored prompt export entries, used for matching against DB records.
   */
  getStoredPromptExportEntries(): { key: string; model: string; promptTokens: number; completionTokens: number; totalTokens: number; cachedPromptTokens: number; cacheWriteTokens: number; reasoningTokens: number; durationMs: number | undefined; timeToFirstTokenMs: number | undefined; timestamp: string | undefined; timestampMs: number | undefined }[] {
    return this.queryRows('SELECT * FROM prompt_export_cache ORDER BY stored_at ASC').map(r => ({
      key: r.key as string,
      model: r.model as string,
      promptTokens: r.prompt_tokens as number,
      completionTokens: r.completion_tokens as number,
      totalTokens: r.total_tokens as number,
      cachedPromptTokens: r.cached_prompt_tokens as number,
      cacheWriteTokens: (r.cache_write_tokens as number) ?? 0,
      reasoningTokens: r.reasoning_tokens as number,
      durationMs: r.duration_ms as number | undefined,
      timeToFirstTokenMs: r.time_to_first_token_ms as number | undefined,
      timestamp: r.timestamp as string | undefined,
      timestampMs: r.timestamp_ms as number | undefined,
    }));
  }

  /**
   * Prune old prompt export entries to keep the table size bounded.
   * Keeps entries from the last N days.
   */
  prunePromptExportCache(keepDays: number = 30): number {
    const cutoff = Date.now() - keepDays * 24 * 60 * 60_000;
    const before = this.queryRows('SELECT COUNT(*) as cnt FROM prompt_export_cache WHERE stored_at < ?', [cutoff]);
    const count = (before[0]?.cnt as number) || 0;
    if (count > 0) {
      this.db.run('DELETE FROM prompt_export_cache WHERE stored_at < ?', [cutoff]);
      this.markDirty();
    }
    return count;
  }

  // ---- Read operations ----------------------------------------------------

  getSessionMtime(sessionId: string): number | undefined {
    const r = this.db.exec('SELECT file_mtime FROM sessions WHERE id = ?', [sessionId]);
    if (r.length === 0 || r[0].values.length === 0) { return undefined; }
    return r[0].values[0][0] as number;
  }

  getSessionDataSource(sessionId: string): string | undefined {
    const r = this.db.exec('SELECT data_source FROM sessions WHERE id = ?', [sessionId]);
    if (r.length === 0 || r[0].values.length === 0) { return undefined; }
    return (r[0].values[0][0] as string) || undefined;
  }

  getAllSessionIds(): string[] {
    const r = this.db.exec('SELECT id FROM sessions ORDER BY start_time DESC');
    if (r.length === 0) { return []; }
    return r[0].values.map(row => row[0] as string);
  }

  getSessionsWithStats(dateFrom?: number, dateTo?: number, provider?: ProviderId): (SessionInfo & SessionStats)[] {
    let sql = `SELECT s.id, s.workspace_id, s.dir_path, s.start_time, s.end_time, s.copilot_version, s.vscode_version,
       s.repository, s.branch, s.cwd, s.agent_name, s.agent_description, s.data_source, s.provider,
       ss.total_input_tokens, ss.total_output_tokens, ss.total_tokens, ss.weighted_cost,
       ss.llm_request_count, ss.user_message_count, ss.tool_call_count, ss.error_count,
       ss.turn_count, ss.subagent_count, ss.avg_tokens_per_request, ss.avg_ttft,
       ss.duration_ms, ss.models_used, ss.dominant_model, ss.efficiency_score, ss.rework_score,
      ss.total_reasoning_tokens, ss.total_cached_tokens, ss.total_cache_write_tokens,
      ss.data_source as stats_data_source, ss.cost_audit_state, ss.cost_audit_flags,
      ss.pricing_table_version, ss.cost_formula_version
    FROM sessions s LEFT JOIN session_stats ss ON s.id = ss.session_id WHERE 1=1`;
    const params: SqlValue[] = [];
    if (provider !== undefined) { sql += ' AND s.provider = ?'; params.push(provider); }
    if (dateFrom !== undefined || dateTo !== undefined) {
      // Include sessions that have ANY activity (LLM requests) in the date range,
      // not just sessions that started in the range
      sql += ` AND s.id IN (SELECT DISTINCT session_id FROM llm_requests WHERE 1=1`;
      if (dateFrom !== undefined) { sql += ' AND timestamp >= ?'; params.push(dateFrom); }
      // Half-open upper bound (< end), matching every cost/stats query so the session
      // list and the token/cost totals agree on which period a boundary-instant request
      // belongs to (period bounds are [start, nextStart)).
      if (dateTo !== undefined) { sql += ' AND timestamp < ?'; params.push(dateTo); }
      sql += ')';
    }
    sql += ' ORDER BY s.start_time DESC';

    return this.queryRows(sql, params).map(mapSessionWithStats);
  }

  getSessionDetail(sessionId: string): { session: SessionInfo; stats: SessionStats; requests: LLMRequestRecord[]; messages: UserMessageRecord[] } | undefined {
    const rows = this.queryRows(
      `SELECT s.id, s.workspace_id, s.dir_path, s.start_time, s.end_time, s.copilot_version, s.vscode_version,
       s.repository, s.branch, s.cwd, s.agent_name, s.agent_description, s.data_source, s.provider,
       ss.total_input_tokens, ss.total_output_tokens, ss.total_tokens, ss.weighted_cost,
       ss.llm_request_count, ss.user_message_count, ss.tool_call_count, ss.error_count,
       ss.turn_count, ss.subagent_count, ss.avg_tokens_per_request, ss.avg_ttft,
       ss.duration_ms, ss.models_used, ss.dominant_model, ss.efficiency_score, ss.rework_score,
      ss.total_reasoning_tokens, ss.total_cached_tokens, ss.total_cache_write_tokens,
      ss.data_source as stats_data_source, ss.cost_audit_state, ss.cost_audit_flags,
      ss.pricing_table_version, ss.cost_formula_version
       FROM sessions s LEFT JOIN session_stats ss ON s.id = ss.session_id WHERE s.id = ?`,
      [sessionId]
    );
    if (rows.length === 0) { return undefined; }
    const session = mapSessionInfo(rows[0]);
    const stats = mapSessionStats(rows[0]);
    const requests = this.queryRows('SELECT * FROM llm_requests WHERE session_id = ? ORDER BY timestamp', [sessionId]).map(mapLLMRequest);
    const messages = this.queryRows('SELECT * FROM user_messages WHERE session_id = ? ORDER BY timestamp', [sessionId]).map(mapUserMessage);
    return { session, stats, requests, messages };
  }

  getSessionToolCalls(sessionId: string): ToolCallRecord[] {
    return this.queryRows(
      'SELECT * FROM tool_calls WHERE session_id = ? ORDER BY timestamp',
      [sessionId]
    ).map(row => ({
      sessionId: row.session_id as string,
      spanId: (row.span_id as string) || '',
      parentSpanId: row.parent_span_id as string | undefined,
      timestamp: row.timestamp as number,
      duration: row.duration as number,
      toolName: row.tool_name as string,
      status: row.status as 'ok' | 'error',
      isSubagent: (row.is_subagent as number) === 1,
      toolType: (row.tool_type as string) || undefined,
      toolCallId: (row.tool_call_id as string) || undefined,
      args: (row.args as string) || undefined,
      result: (row.result as string) || undefined,
      errorText: (row.error_text as string) || undefined,
    }));
  }

  getSessionAnalytics(sessionId: string): SessionAnalytics | undefined {
    const requests = this.queryRows(
      'SELECT model, input_tokens, output_tokens, ttft, duration, status, is_subagent, subagent_name, max_tokens, span_id, timestamp, reasoning_tokens, cached_input_tokens, cache_write_tokens, response_model, direct_credits FROM llm_requests WHERE session_id = ? ORDER BY timestamp',
      [sessionId]
    );
    const messages = this.queryRows(
      'SELECT timestamp, content_length FROM user_messages WHERE session_id = ? ORDER BY timestamp',
      [sessionId]
    );
    const tools = this.queryRows(
      'SELECT tool_name, duration, status, parent_span_id FROM tool_calls WHERE session_id = ? ORDER BY timestamp',
      [sessionId]
    );
    const statsRow = this.queryRows(
      'SELECT turn_count, duration_ms, data_source FROM session_stats WHERE session_id = ?',
      [sessionId]
    );

    if (requests.length === 0 && messages.length === 0) { return undefined; }

    const turnCount = statsRow.length > 0 ? (statsRow[0].turn_count as number) || 0 : 0;
    const durationMs = statsRow.length > 0 ? (statsRow[0].duration_ms as number) || 0 : 0;
    const dataSource = statsRow.length > 0 ? (statsRow[0].data_source as string) || 'jsonl' : 'jsonl';
    const msgCount = messages.length;

    // Token efficiency
    let totalInput = 0, totalOutput = 0, wastedTokens = 0;
    let directTokens = 0, subagentTokens = 0;
    let totalReasoningTokens = 0, totalCachedTokens = 0;
    let modelMismatches = 0;
    const ttfts: number[] = [];
    let totalDuration = 0;
    let errorRequests = 0;
    const modelMap = new Map<string, { requests: number; tokens: number; reasoningTokens: number; cachedTokens: number }>();

    for (const r of requests) {
      const inp = (r.input_tokens as number) || 0;
      const out = (r.output_tokens as number) || 0;
      const total = inp + out;
      const reasoning = (r.reasoning_tokens as number) || 0;
      const cached = (r.cached_input_tokens as number) || 0;
      totalInput += inp;
      totalOutput += out;
      totalReasoningTokens += reasoning;
      totalCachedTokens += cached;
      totalDuration += (r.duration as number) || 0;

      if ((r.ttft as number) > 0) { ttfts.push(r.ttft as number); }
      if (r.status === 'error') { wastedTokens += total; errorRequests++; }
      if ((r.is_subagent as number) === 1) { subagentTokens += total; } else { directTokens += total; }

      // Model routing: detect response_model != request_model
      const reqModel = (r.model as string) || '';
      const respModel = (r.response_model as string) || '';
      if (respModel && respModel !== reqModel) { modelMismatches++; }

      const model = reqModel || 'unknown';
      const existing = modelMap.get(model) || { requests: 0, tokens: 0, reasoningTokens: 0, cachedTokens: 0 };
      existing.requests++;
      existing.tokens += total;
      existing.reasoningTokens += reasoning;
      existing.cachedTokens += cached;
      modelMap.set(model, existing);
    }

    const totalTokens = totalInput + totalOutput;
    const inputOutputRatio = totalOutput > 0 ? Math.round((totalInput / totalOutput) * 10) / 10 : 0;
    const tokensPerMessage = msgCount > 0 ? Math.round(totalTokens / msgCount) : 0;

    // Performance
    ttfts.sort((a, b) => a - b);
    const avgTtft = ttfts.length > 0 ? Math.round(ttfts.reduce((a, b) => a + b, 0) / ttfts.length) : 0;
    const p90Ttft = ttfts.length > 0 ? ttfts[Math.floor(ttfts.length * 0.9)] : 0;
    const avgRequestDuration = requests.length > 0 ? Math.round(totalDuration / requests.length) : 0;

    // Tool analytics
    const toolMap = new Map<string, { count: number; totalMs: number; errors: number }>();
    let toolErrors = 0;
    for (const t of tools) {
      const name = (t.tool_name as string) || 'unknown';
      const existing = toolMap.get(name) || { count: 0, totalMs: 0, errors: 0 };
      existing.count++;
      existing.totalMs += (t.duration as number) || 0;
      if (t.status === 'error') { existing.errors++; toolErrors++; }
      toolMap.set(name, existing);
    }
    const topTools = [...toolMap.entries()]
      .sort((a, b) => b[1].count - a[1].count)
      .slice(0, 8)
      .map(([name, v]) => ({ name, count: v.count, avgMs: Math.round(v.totalMs / v.count), errors: v.errors }));

    const totalActions = requests.length + tools.length;
    const totalErrors = errorRequests + toolErrors;
    const errorRate = totalActions > 0 ? Math.round((totalErrors / totalActions) * 100) : 0;

    // Model breakdown
    const modelBreakdown = [...modelMap.entries()]
      .sort((a, b) => b[1].tokens - a[1].tokens)
      .map(([model, v]) => ({
        model, requests: v.requests, tokens: v.tokens,
        pct: totalTokens > 0 ? Math.round((v.tokens / totalTokens) * 100) : 0,
        reasoningTokens: v.reasoningTokens, cachedTokens: v.cachedTokens,
      }));

    // Timeline
    const activeMinutes = Math.round(durationMs / 60000 * 10) / 10;
    const tokensPerMinute = activeMinutes > 0 ? Math.round(totalTokens / activeMinutes) : 0;

    let avgThinkTime = 0;
    if (messages.length > 1) {
      const gaps: number[] = [];
      for (let i = 1; i < messages.length; i++) {
        const gap = ((messages[i].timestamp as number) - (messages[i - 1].timestamp as number)) / 1000;
        if (gap > 0 && gap < 3600) { gaps.push(gap); } // ignore gaps > 1h (likely idle)
      }
      if (gaps.length > 0) { avgThinkTime = Math.round(gaps.reduce((a, b) => a + b, 0) / gaps.length); }
    }

    // Credits estimation - delegates to canonical billingCalculator pricing.
    let estimatedCredits = 0;
    let reasoningCostUSD = 0;
    let cacheSavingsUSD = 0;
    for (const r of requests) {
      const model = (r.model as string) || '';
      const inp = (r.input_tokens as number) || 0;
      const out = (r.output_tokens as number) || 0;
      const cached = (r.cached_input_tokens as number) || 0;
      const cw = (r.cache_write_tokens as number) || 0;
      const reasoning = (r.reasoning_tokens as number) || 0;
      estimatedCredits += computeCostUSD(model, {
        inputTokens: inp, outputTokens: out,
        cachedInputTokens: cached, cacheWriteTokens: cw,
        directCredits: rowDirectCredits(r),
      });
      // Reasoning cost / cache savings are informational list-price figures, so
      // they use the tier that applied to this prompt size.
      const pricing = getPricing(model, inp);
      // Reasoning tokens are already included in outputTokens.
      if (reasoning > 0) {
        reasoningCostUSD += (reasoning / 1_000_000) * pricing.output;
      }
      // Cache savings: difference between full input price and cached price
      if (cached > 0) {
        cacheSavingsUSD += (cached / 1_000_000) * (pricing.input - pricing.cachedInput);
      }
    }
    estimatedCredits = Math.round(estimatedCredits * 100) / 100;
    reasoningCostUSD = Math.round(reasoningCostUSD * 10000) / 10000;
    cacheSavingsUSD = Math.round(cacheSavingsUSD * 10000) / 10000;

    // Reasoning analysis
    const reasoningPct = totalOutput > 0 ? Math.round((totalReasoningTokens / totalOutput) * 100) : 0;

    // Cache analysis
    const cacheHitRate = totalInput > 0 ? Math.round((totalCachedTokens / totalInput) * 100) : 0;
    const dataConfidence: 'measured' | 'estimated' | 'mixed' =
      dataSource === 'otel' ? 'measured' : dataSource === 'hybrid' ? 'mixed' : 'estimated';

    // Optimization signals
    const signals: string[] = [];

    // -- Reasoning signals (OTel-sourced) --
    if (totalReasoningTokens > 0 && reasoningPct > 60) {
      signals.push('Heavy reasoning: ' + reasoningPct + '% of output was thinking (' + Math.round(totalReasoningTokens / 1000) + 'K tokens, $' + reasoningCostUSD.toFixed(3) + ') — consider a non-reasoning model for routine tasks');
    } else if (totalReasoningTokens > 0 && totalReasoningTokens > totalOutput * 2) {
      signals.push('Model over-thinking: ' + Math.round(totalReasoningTokens / 1000) + 'K reasoning tokens vs ' + Math.round((totalOutput - totalReasoningTokens) / 1000) + 'K visible output — wasteful thinking ratio');
    }

    // -- Cache signals --
    if (totalCachedTokens > 0 && cacheSavingsUSD > 0.01) {
      signals.push('Cache saved $' + cacheSavingsUSD.toFixed(3) + ' this session (' + cacheHitRate + '% hit rate)');
    }
    if (totalInput > 50000 && cacheHitRate < 20 && dataConfidence === 'measured') {
      signals.push('Low cache hit rate (' + cacheHitRate + '%) on ' + Math.round(totalInput / 1000) + 'K input — reorganize prompts for better prefix reuse');
    }

    // -- Data quality transparency --
    if (dataConfidence === 'estimated' && totalCachedTokens > 0) {
      signals.push('Cache data is estimated (JSONL source) — real values may differ by ±30%');
    }

    // -- Model routing --
    if (modelMismatches > 0) {
      signals.push(modelMismatches + ' request(s) served by a different model than requested — possible capacity constraints');
    }

    // -- Existing signals --
    if (inputOutputRatio > 20) {
      signals.push('Very context-heavy (ratio ' + inputOutputRatio + ':1) — trim included files or narrow scope');
    }
    if (wastedTokens > 0 && totalTokens > 0 && (wastedTokens / totalTokens) > 0.1) {
      signals.push(Math.round((wastedTokens / totalTokens) * 100) + '% tokens wasted on errors');
    }
    if (subagentTokens > 0 && totalTokens > 0 && (subagentTokens / totalTokens) > 0.5) {
      signals.push('Subagents consumed ' + Math.round((subagentTokens / totalTokens) * 100) + '% of tokens — review if needed');
    }
    if (p90Ttft > 5000) {
      signals.push('Slow p90 TTFT (' + Math.round(p90Ttft / 1000) + 's) — large context or complex model');
    }
    if (errorRate > 20) {
      signals.push('High error rate (' + errorRate + '%) — check tool call patterns');
    }
    if (turnCount > 0 && msgCount > 0 && (turnCount / msgCount) > 10) {
      signals.push('High turns/msg (' + Math.round(turnCount / msgCount) + ') — more specific prompts could reduce loops');
    }
    const dominantModel = modelBreakdown.length > 0 ? modelBreakdown[0] : null;
    if (dominantModel && (dominantModel.model.includes('opus') || dominantModel.model.includes('gpt-4o')) && tokensPerMessage < 2000 && msgCount > 3) {
      signals.push('Simple tasks on expensive model — consider Sonnet or GPT-4.1-mini');
    }

    // ---- Deep Workflow Insights ----
    const insights = this.computeWorkflowInsights(requests, messages, tools);

    // Add insight-driven signals
    if (insights.stallSequences > 0) {
      signals.push('Detected ' + insights.stallSequences + ' exploration stall(s) (longest: ' + insights.longestStall + ' turns) — ' + Math.round(insights.stallTokens / 1000) + 'K tokens without productive output');
    }
    if (insights.explorationPct > 75 && tools.length > 10) {
      signals.push('Heavy exploration (' + insights.explorationPct + '% read/search) — consider providing more upfront context');
    }
    if (insights.contextSaturationTurn > 0) {
      signals.push('Context reached 80%+ capacity at turn ' + insights.contextSaturationTurn + ' — cost per turn is now maxed');
    }
    if (insights.bloatRatio > 3) {
      signals.push('Late-half cost was ' + insights.bloatRatio + 'x first-half — context bloat made later turns expensive');
    }
    if (insights.marginalEfficiencyPct > 0 && insights.marginalEfficiencyPct < 10) {
      signals.push('Only ' + insights.marginalEfficiencyPct + '% of spend was new work — the rest was re-billed context');
    }

    return {
      inputOutputRatio,
      tokensPerMessage,
      wastedTokens,
      wastedPct: totalTokens > 0 ? Math.round((wastedTokens / totalTokens) * 100) : 0,
      avgTtft,
      p90Ttft,
      avgRequestDuration,
      turnsPerMessage: msgCount > 0 ? Math.round((turnCount / msgCount) * 10) / 10 : 0,
      toolsPerTurn: turnCount > 0 ? Math.round((tools.length / turnCount) * 10) / 10 : 0,
      errorRate,
      uniqueTools: toolMap.size,
      topTools,
      directTokens,
      subagentTokens,
      subagentPct: totalTokens > 0 ? Math.round((subagentTokens / totalTokens) * 100) : 0,
      estimatedCredits,
      modelBreakdown,
      activeMinutes,
      tokensPerMinute,
      avgThinkTime,
      signals,
      insights,
      // Reasoning analysis
      totalReasoningTokens,
      reasoningPct,
      reasoningCostUSD,
      // Cache analysis
      totalCachedTokens,
      cacheHitRate,
      cacheSavingsUSD,
      dataConfidence,
      // Model routing
      modelMismatches,
    };
  }

  private computeWorkflowInsights(
    requests: SqlRow[],
    messages: SqlRow[],
    tools: SqlRow[]
  ): WorkflowInsights {
    // Tool taxonomy: production = changes the world; exploration = gathers info; meta = housekeeping
    const PRODUCTION_TOOLS = new Set([
      'replace_string_in_file', 'multi_replace_string_in_file', 'create_file',
      'run_in_terminal', 'send_to_terminal', 'vscode_renameSymbol',
      'edit_notebook_file', 'run_notebook_cell',
    ]);
    const EXPLORATION_TOOLS = new Set([
      'read_file', 'grep_search', 'file_search', 'semantic_search', 'list_dir',
      'view_image', 'vscode_listCodeUsages', 'fetch_webpage', 'get_errors',
      'get_terminal_output',
    ]);
    const META_TOOLS = new Set([
      'manage_todo_list', 'tool_search', 'memory', 'runSubagent',
      'vscode_askQuestions',
    ]);

    // Classify tool calls
    let explorationCalls = 0, productionCalls = 0, metaCalls = 0;
    for (const t of tools) {
      const name = (t.tool_name as string) || '';
      if (PRODUCTION_TOOLS.has(name)) { productionCalls++; }
      else if (EXPLORATION_TOOLS.has(name)) { explorationCalls++; }
      else if (META_TOOLS.has(name)) { metaCalls++; }
      else { explorationCalls++; }
    }
    const totalToolCalls = explorationCalls + productionCalls + metaCalls;
    const explorationPct = totalToolCalls > 0 ? Math.round((explorationCalls / totalToolCalls) * 100) : 0;

    // Group tools by parent LLM span
    const toolsByParent = new Map<string, string[]>();
    for (const t of tools) {
      const parent = (t.parent_span_id as string) || '';
      if (!toolsByParent.has(parent)) { toolsByParent.set(parent, []); }
      toolsByParent.get(parent)!.push((t.tool_name as string) || '');
    }

    // Per-turn analysis
    const turnProductive: boolean[] = [];
    const turnCosts: number[] = [];
    const turnMarginalCosts: number[] = []; // cost of NEW tokens only (delta input + output)
    const inputTokensPerTurn: number[] = [];
    let maxContextReached = 0;
    let maxTokensCapacity = 0;
    let contextSaturationTurn = 0;
    let explorationTokens = 0, productionTokens = 0;
    let prevInput = 0;

    for (let i = 0; i < requests.length; i++) {
      const r = requests[i];
      const inp = (r.input_tokens as number) || 0;
      const out = (r.output_tokens as number) || 0;
      const maxTok = (r.max_tokens as number) || 0;
      const model = (r.model as string) || '';
      const spanId = (r.span_id as string) || '';

      inputTokensPerTurn.push(inp);
      if (inp > maxContextReached) { maxContextReached = inp; }
      if (maxTok > maxTokensCapacity) { maxTokensCapacity = maxTok; }

      // Productive: produces an edit, runs a command, or generates substantive output (>=150 tokens)
      const turnTools = toolsByParent.get(spanId) || [];
      const hasProduction = turnTools.some(name => PRODUCTION_TOOLS.has(name));
      const isProductive = hasProduction || out >= 150;
      turnProductive.push(isProductive);

      // Total cost of this turn (billed amount when reported, else list price)
      const turnUsage = {
        inputTokens: inp,
        outputTokens: out,
        cachedInputTokens: (r.cached_input_tokens as number) || 0,
        cacheWriteTokens: (r.cache_write_tokens as number) || 0,
      };
      const listCost = computeListCostUSD(model, turnUsage);
      const cost = computeCostUSD(model, { ...turnUsage, directCredits: rowDirectCredits(r) });
      turnCosts.push(cost);

      // Marginal cost: only NEW input tokens (delta from previous turn) + output
      // This is the cost attributable to *this* turn's actual work, not repeated context.
      // Priced at list (at the full prompt's tier), then scaled by billed/list so it
      // stays a consistent share of the turn's actual cost.
      const newInput = i === 0 ? inp : Math.max(0, inp - prevInput);
      const tier = getPricing(model, inp);
      const marginalList = (newInput * tier.input + out * tier.output) / 1_000_000;
      const marginalCost = listCost > 0 ? marginalList * (cost / listCost) : marginalList;
      turnMarginalCosts.push(marginalCost);
      prevInput = inp;

      const total = inp + out;
      if (isProductive) { productionTokens += total; } else { explorationTokens += total; }

      if (contextSaturationTurn === 0 && maxTok > 0 && inp > maxTok * 0.8) {
        contextSaturationTurn = i + 1;
      }
    }

    // Context growth (avg delta between consecutive turns)
    let totalGrowth = 0;
    let growthCount = 0;
    for (let i = 1; i < inputTokensPerTurn.length; i++) {
      const delta = inputTokensPerTurn[i] - inputTokensPerTurn[i - 1];
      if (delta > 0) { totalGrowth += delta; growthCount++; }
    }
    const avgContextGrowthPerTurn = growthCount > 0 ? Math.round(totalGrowth / growthCount) : 0;
    const contextUtilizationPct = maxTokensCapacity > 0 ? Math.round((maxContextReached / maxTokensCapacity) * 100) : 0;

    // Stall detection: 3+ consecutive non-productive turns
    let stallSequences = 0, longestStall = 0, stallTokens = 0;
    let currentStall = 0;
    const closeStall = (endIdx: number) => {
      if (currentStall >= 3) {
        stallSequences++;
        if (currentStall > longestStall) { longestStall = currentStall; }
        for (let j = endIdx - currentStall; j < endIdx; j++) {
          stallTokens += ((requests[j].input_tokens as number) || 0) + ((requests[j].output_tokens as number) || 0);
        }
      }
      currentStall = 0;
    };
    for (let i = 0; i < turnProductive.length; i++) {
      if (!turnProductive[i]) { currentStall++; }
      else { closeStall(i); }
    }
    closeStall(turnProductive.length);

    // Bloat ratio: cost in second half vs first half of session
    // High ratio (>3x) means context bloat made later turns much more expensive
    const totalCost = turnCosts.reduce((a, b) => a + b, 0);
    const halfPoint = Math.floor(turnCosts.length / 2);
    const firstHalfCost = turnCosts.slice(0, halfPoint).reduce((a, b) => a + b, 0);
    const secondHalfCost = turnCosts.slice(halfPoint).reduce((a, b) => a + b, 0);
    const bloatRatio = firstHalfCost > 0 ? Math.round((secondHalfCost / firstHalfCost) * 10) / 10 : 0;

    // Marginal vs total: how much of the spend was actual new work vs re-billed context
    const totalMarginalCost = turnMarginalCosts.reduce((a, b) => a + b, 0);
    const marginalEfficiencyPct = totalCost > 0 ? Math.round((totalMarginalCost / totalCost) * 100) : 0;

    // Turn cost stats
    const sortedCosts = [...turnCosts].sort((a, b) => b - a);
    const expensiveTurnCost = sortedCosts.length > 0 ? Math.round(sortedCosts[0] * 10000) / 10000 : 0;
    const medianTurnCost = sortedCosts.length > 0 ? Math.round(sortedCosts[Math.floor(sortedCosts.length / 2)] * 10000) / 10000 : 0;

    // Per-message attribution using REAL timestamps
    const promptEfficiency: { msgLength: number; turnsAfter: number; tokensAfter: number; costAfter: number; productiveTurns: number }[] = [];
    if (messages.length > 0) {
      const reqTs = requests.map(r => (r.timestamp as number) || 0);
      for (let mi = 0; mi < messages.length; mi++) {
        const msgLen = (messages[mi].content_length as number) || 0;
        const start = (messages[mi].timestamp as number) || 0;
        const end = mi < messages.length - 1 ? ((messages[mi + 1].timestamp as number) || Infinity) : Infinity;
        let turnsAfter = 0, tokensAfter = 0, costAfter = 0, productiveTurns = 0;
        for (let ri = 0; ri < requests.length; ri++) {
          if (reqTs[ri] >= start && reqTs[ri] < end) {
            turnsAfter++;
            tokensAfter += ((requests[ri].input_tokens as number) || 0) + ((requests[ri].output_tokens as number) || 0);
            costAfter += turnCosts[ri];
            if (turnProductive[ri]) { productiveTurns++; }
          }
        }
        promptEfficiency.push({
          msgLength: msgLen,
          turnsAfter,
          tokensAfter,
          costAfter: Math.round(costAfter * 10000) / 10000,
          productiveTurns,
        });
      }
    }

    return {
      explorationCalls,
      productionCalls,
      metaCalls,
      explorationPct,
      explorationTokens,
      productionTokens,
      avgContextGrowthPerTurn,
      maxContextReached,
      contextUtilizationPct,
      contextSaturationTurn,
      stallSequences,
      longestStall,
      stallTokens,
      bloatRatio,
      marginalEfficiencyPct,
      totalMarginalCost: Math.round(totalMarginalCost * 10000) / 10000,
      expensiveTurnCost,
      medianTurnCost,
      promptEfficiency,
    };
  }

  getAggregateStats(dateFrom?: number, dateTo?: number, provider?: ProviderId): AggregateStats {
    let where = '';
    const params: SqlValue[] = [];
    if (provider !== undefined) { where += ' AND lr.provider = ?'; params.push(provider); }
    if (dateFrom !== undefined) { where += ' AND lr.timestamp >= ?'; params.push(dateFrom); }
    if (dateTo !== undefined) { where += ' AND lr.timestamp <= ?'; params.push(dateTo); }

    // Aggregate from individual requests by timestamp for accurate daily stats
    const rows = this.queryRows(`
      SELECT COUNT(DISTINCT lr.session_id) as total_sessions,
        COALESCE(SUM(lr.input_tokens + lr.output_tokens), 0) as total_tokens,
        COALESCE(SUM(lr.input_tokens), 0) as total_input_tokens,
        COALESCE(SUM(lr.output_tokens), 0) as total_output_tokens,
        COUNT(*) as total_requests
      FROM llm_requests lr
      WHERE 1=1 ${where}`, params);

    if (rows.length === 0 || (rows[0].total_sessions as number) === 0) {
      return { totalSessions: 0, totalTokens: 0, totalInputTokens: 0, totalOutputTokens: 0, totalCostUSD: 0, totalRequests: 0, totalMessages: 0, totalToolCalls: 0, totalErrors: 0, avgTokensPerSession: 0, avgTokensPerRequest: 0, avgRequestsPerSession: 0 };
    }
    const r = rows[0];
    const ts = (r.total_sessions as number) || 0;
    const tr = (r.total_requests as number) || 0;
    const tt = (r.total_tokens as number) || 0;

    // Get message/tool/error counts from sessions that had activity in the range
    let extraWhere = '';
    const extraParams: SqlValue[] = [];
    if (provider !== undefined) { extraWhere += ' AND s.provider = ?'; extraParams.push(provider); }
    if (dateFrom !== undefined || dateTo !== undefined) {
      extraWhere += ` AND s.id IN (SELECT DISTINCT session_id FROM llm_requests WHERE 1=1`;
      if (dateFrom !== undefined) { extraWhere += ' AND timestamp >= ?'; extraParams.push(dateFrom); }
      if (dateTo !== undefined) { extraWhere += ' AND timestamp <= ?'; extraParams.push(dateTo); }
      extraWhere += ')';
    }
    const extra = this.queryRows(`
      SELECT COALESCE(SUM(ss.weighted_cost), 0) as total_cost_usd,
        COALESCE(SUM(ss.user_message_count), 0) as total_messages,
        COALESCE(SUM(ss.tool_call_count), 0) as total_tool_calls,
        COALESCE(SUM(ss.error_count), 0) as total_errors
      FROM sessions s INNER JOIN session_stats ss ON s.id = ss.session_id
      WHERE 1=1 ${extraWhere}`, extraParams);

    const e = extra.length > 0 ? extra[0] : {} as Record<string, unknown>;
    return {
      totalSessions: ts, totalTokens: tt,
      totalInputTokens: (r.total_input_tokens as number) || 0,
      totalOutputTokens: (r.total_output_tokens as number) || 0,
      totalCostUSD: (e.total_cost_usd as number) || 0,
      totalRequests: tr,
      totalMessages: (e.total_messages as number) || 0,
      totalToolCalls: (e.total_tool_calls as number) || 0,
      totalErrors: (e.total_errors as number) || 0,
      avgTokensPerSession: ts > 0 ? Math.round(tt / ts) : 0,
      avgTokensPerRequest: tr > 0 ? Math.round(tt / tr) : 0,
      avgRequestsPerSession: ts > 0 ? Math.round(tr / ts) : 0,
    };
  }

  getDailyStats(dateFrom?: number, dateTo?: number, provider?: ProviderId): DailyStats[] {
    let where = '';
    const params: SqlValue[] = [];
    if (provider !== undefined) { where += ' AND lr.provider = ?'; params.push(provider); }
    if (dateFrom !== undefined) { where += ' AND lr.timestamp >= ?'; params.push(dateFrom); }
    if (dateTo !== undefined) { where += ' AND lr.timestamp <= ?'; params.push(dateTo); }

    const requestRows = this.queryRows(`SELECT * FROM llm_requests lr WHERE 1=1 ${where} ORDER BY lr.timestamp ASC`, params)
      .map(r => mapLLMRequest(r));
    const estimated = estimateSessionCaching(requestRows).requests;
    const costByDate = new Map<string, number>();
    for (const req of estimated) {
      const key = localDateKey(req.timestamp);
      costByDate.set(key, (costByDate.get(key) ?? 0) + computeCostUSD(req.model, req));
    }

    // Group by request timestamp date for accurate daily attribution
    return this.queryRows(`
      SELECT date(lr.timestamp / 1000, 'unixepoch', 'localtime') as date,
        COUNT(DISTINCT lr.session_id) as sessions,
        COALESCE(SUM(lr.input_tokens + lr.output_tokens), 0) as totalTokens,
        COUNT(*) as requests
      FROM llm_requests lr
      WHERE 1=1 ${where}
      GROUP BY date(lr.timestamp / 1000, 'unixepoch', 'localtime')
      ORDER BY date DESC`, params).map(r => ({
      date: r.date as string,
      sessions: r.sessions as number,
      totalTokens: r.totalTokens as number,
      costUSD: costByDate.get(r.date as string) ?? 0,
      requests: r.requests as number,
    }));
  }

  getModelStats(startMs?: number, endMs?: number, provider?: ProviderId): ModelStats[] {
    // NOTE: this query previously had no table alias and used bare `timestamp`.
    // It now uses `FROM llm_requests lr` + a `WHERE 1=1` scaffold so the provider
    // predicate composes (CLAUDE-PROVIDER-PLAN.md §15 #6) — appending `lr.provider`
    // to an alias-less query would throw `no such column`.
    let where = '';
    const params: SqlValue[] = [];
    if (provider !== undefined) { where += ' AND lr.provider = ?'; params.push(provider); }
    if (startMs !== undefined && endMs !== undefined) {
      where += ' AND lr.timestamp >= ? AND lr.timestamp < ?';
      params.push(startMs, endMs);
    }
    const requests = this.queryRows(
      `SELECT lr.* FROM llm_requests lr WHERE 1=1 ${where} ORDER BY lr.timestamp ASC`, params
    ).map(r => mapLLMRequest(r));
    const estimated = estimateSessionCaching(requests).requests;
    const byModel = new Map<string, ModelStats>();
    for (const req of estimated) {
      const model = req.model || 'unknown';
      const existing = byModel.get(model) ?? { model, totalTokens: 0, costUSD: 0, requestCount: 0 };
      existing.totalTokens += req.inputTokens + req.outputTokens;
      existing.costUSD += computeCostUSD(model, req);
      existing.requestCount += 1;
      byModel.set(model, existing);
    }
    return Array.from(byModel.values()).sort((a, b) => b.totalTokens - a.totalTokens);
  }

  getTopSessions(limit: number = 10, provider?: ProviderId): (SessionStats & { startTime: number })[] {
    const where = provider !== undefined ? 'WHERE s.provider = ?' : '';
    const params: SqlValue[] = provider !== undefined ? [provider, limit] : [limit];
    return this.queryRows(
      `SELECT ss.*, s.start_time, s.provider FROM session_stats ss
       JOIN sessions s ON ss.session_id = s.id ${where} ORDER BY ss.total_tokens DESC LIMIT ?`,
      params
    ).map(r => ({ ...mapSessionStats(r), startTime: r.start_time as number }));
  }

  getEmptySessionCount(): number {
    const rows = this.queryRows(
      'SELECT COUNT(*) as cnt FROM sessions s WHERE NOT EXISTS (SELECT 1 FROM session_stats ss WHERE ss.session_id = s.id)'
    );
    return rows.length > 0 ? (rows[0].cnt as number) : 0;
  }

  getWorkflowStats(provider?: ProviderId): { toolName: string; count: number; errors: number; avgDuration: number }[] {
    // tool_calls has no provider column, so filter via a sessions JOIN.
    const join = provider !== undefined ? 'JOIN sessions s ON s.id = tc.session_id' : '';
    const where = provider !== undefined ? 'WHERE s.provider = ?' : '';
    const params: SqlValue[] = provider !== undefined ? [provider] : [];
    return this.queryRows(
      `SELECT tc.tool_name as tool_name, COUNT(*) as count, SUM(CASE WHEN tc.status = 'error' THEN 1 ELSE 0 END) as errors,
       AVG(tc.duration) as avg_duration
       FROM tool_calls tc ${join} ${where} GROUP BY tc.tool_name ORDER BY count DESC`,
      params
    ).map(r => ({
      toolName: r.tool_name as string,
      count: r.count as number,
      errors: (r.errors as number) || 0,
      avgDuration: Math.round(r.avg_duration as number) || 0,
    }));
  }

  getSubagentStats(provider?: ProviderId): { name: string; count: number; avgTokens: number }[] {
    const providerClause = provider !== undefined ? 'AND provider = ?' : '';
    const params: SqlValue[] = provider !== undefined ? [provider] : [];
    return this.queryRows(
      `SELECT subagent_name as name, COUNT(*) as count, AVG(input_tokens + output_tokens) as avg_tokens
       FROM llm_requests WHERE is_subagent = 1 AND subagent_name IS NOT NULL ${providerClause}
       GROUP BY subagent_name ORDER BY count DESC`,
      params
    ).map(r => ({
      name: r.name as string,
      count: r.count as number,
      avgTokens: Math.round(r.avg_tokens as number) || 0,
    }));
  }

  /**
   * Returns distinct UTC calendar months that have llm_request data, newest first.
   * Each entry carries pre-computed epoch-ms start/end boundaries for use in period queries.
   */
  getAvailableMonths(provider?: ProviderId, now: number = Date.now()): { year: number; month: number; label: string; start: number; end: number }[] {
    const providerClause = provider !== undefined ? 'WHERE provider = ?' : '';
    const params: SqlValue[] = provider !== undefined ? [provider] : [];
    const rows = this.queryRows(`
      SELECT
        CAST(strftime('%Y', timestamp / 1000, 'unixepoch') AS INTEGER) AS year,
        CAST(strftime('%m', timestamp / 1000, 'unixepoch') AS INTEGER) AS month
      FROM llm_requests
      ${providerClause}
      GROUP BY year, month
      ORDER BY year DESC, month DESC
    `, params);
    const MONTH_NAMES = ['January','February','March','April','May','June','July','August','September','October','November','December'];
    const mk = (year: number, month: number) => ({
      year, month,
      label: `${MONTH_NAMES[month - 1]} ${year}`,
      start: Date.UTC(year, month - 1, 1),
      end: Date.UTC(year, month, 1),
    });
    const months = rows.map(r => mk(r.year as number, r.month as number));

    // Always include the CURRENT calendar month (UTC, matching getBillingPeriodBounds),
    // even when it has no rows yet. The billing views treat index 0 as the live billing
    // period; without this, on a month with no activity (e.g. the 1st) the newest
    // data-month would sit at index 0, be treated as "current", and get billed over the
    // empty current range → $0 for the last real month + the current month unselectable.
    const d = new Date(now);
    const cy = d.getUTCFullYear();
    const cmonth = d.getUTCMonth() + 1; // 1-based
    const key = (y: number, m: number) => y * 12 + (m - 1);
    if (months.length === 0 || key(cy, cmonth) > key(months[0].year, months[0].month)) {
      months.unshift(mk(cy, cmonth)); // current month is newest → index 0
    }
    return months;
  }

  getWorkflowSummary(startMs?: number, endMs?: number, provider?: ProviderId): { totalToolCalls: number; totalSubagents: number; totalTurns: number; totalErrors: number; avgTurnsPerMessage: number; avgToolsPerTurn: number } {
    const hasPeriod = startMs !== undefined && endMs !== undefined;
    const join  = hasPeriod ? 'JOIN sessions s ON ss.session_id = s.id' : '';
    // session_stats carries its own provider column, so no JOIN is needed to filter it.
    const conds: string[] = [];
    const params: SqlValue[] = [];
    if (hasPeriod) { conds.push('s.start_time >= ? AND s.start_time < ?'); params.push(startMs!, endMs!); }
    if (provider !== undefined) { conds.push('ss.provider = ?'); params.push(provider); }
    const where = conds.length > 0 ? `WHERE ${conds.join(' AND ')}` : '';
    const rows = this.queryRows(
      `SELECT SUM(ss.tool_call_count) as total_tools, SUM(ss.subagent_count) as total_subagents,
       SUM(ss.turn_count) as total_turns, SUM(ss.error_count) as total_errors,
       SUM(ss.user_message_count) as total_messages FROM session_stats ss ${join} ${where}`,
      params
    );
    if (rows.length === 0) {
      return { totalToolCalls: 0, totalSubagents: 0, totalTurns: 0, totalErrors: 0, avgTurnsPerMessage: 0, avgToolsPerTurn: 0 };
    }
    const r = rows[0];
    const tools = (r.total_tools as number) || 0;
    const turns = (r.total_turns as number) || 0;
    const messages = (r.total_messages as number) || 0;
    const subagents = (r.total_subagents as number) || 0;
    const errors = (r.total_errors as number) || 0;
    return {
      totalToolCalls: tools,
      totalSubagents: subagents,
      totalTurns: turns,
      totalErrors: errors,
      avgTurnsPerMessage: messages > 0 ? Math.round((turns / messages) * 10) / 10 : 0,
      avgToolsPerTurn: turns > 0 ? Math.round((tools / turns) * 10) / 10 : 0,
    };
  }

  // ---- Billing period queries ---------------------------------------------

  getLLMRequestsInPeriod(startMs: number, endMs: number, provider?: ProviderId): LLMRequestRecord[] {
    // No sessions JOIN: llm_requests carries its own provider column (migration v9),
    // so the JOIN adds nothing for filtering and — being INNER — could silently drop
    // an llm_request whose session row is missing, diverging from getModelStats
    // (which scans llm_requests directly). Filter on lr.provider alone.
    const providerClause = provider !== undefined ? 'AND lr.provider = ?' : '';
    const params: SqlValue[] = provider !== undefined ? [startMs, endMs, provider] : [startMs, endMs];
    return this.queryRows(
      `SELECT lr.*
       FROM llm_requests lr
       WHERE lr.timestamp >= ? AND lr.timestamp < ?
       ${providerClause}
       ORDER BY lr.timestamp ASC`,
      params
    ).map(r => mapLLMRequest(r));
  }

  /**
   * Activity in [startMs, endMs) for a provider:
   *  - chatRequests: prompts the user sent (user_messages; subagent prompts are not
   *    stored as user messages, and failed requests are included);
   *  - sessions: distinct sessions with at least one chat request or LLM call.
   */
  getActivityCounts(startMs: number, endMs: number, provider: ProviderId): { sessions: number; chatRequests: number } {
    const chat = this.queryRows(
      `SELECT COUNT(*) AS n FROM user_messages um
       JOIN sessions s ON s.id = um.session_id
       WHERE um.timestamp >= ? AND um.timestamp < ? AND COALESCE(s.provider, 'copilot') = ?`,
      [startMs, endMs, provider]
    );
    const sess = this.queryRows(
      `SELECT COUNT(*) AS n FROM (
         SELECT um.session_id AS sid FROM user_messages um
         JOIN sessions s ON s.id = um.session_id
         WHERE um.timestamp >= ? AND um.timestamp < ? AND COALESCE(s.provider, 'copilot') = ?
         UNION
         SELECT lr.session_id AS sid FROM llm_requests lr
         WHERE lr.timestamp >= ? AND lr.timestamp < ? AND COALESCE(lr.provider, 'copilot') = ?
       )`,
      [startMs, endMs, provider, startMs, endMs, provider]
    );
    return {
      sessions: (sess[0]?.n as number) || 0,
      chatRequests: (chat[0]?.n as number) || 0,
    };
  }

  getSessionDominantModels(): Map<string, string> {
    const rows = this.queryRows(
      `SELECT session_id, dominant_model FROM session_stats WHERE dominant_model IS NOT NULL AND dominant_model != ''`
    );
    const map = new Map<string, string>();
    for (const r of rows) {
      map.set(r.session_id as string, r.dominant_model as string);
    }
    return map;
  }

  clearAll(): void {
    this.db.run('DELETE FROM tool_calls');
    this.db.run('DELETE FROM user_messages');
    this.db.run('DELETE FROM llm_requests');
    this.db.run('DELETE FROM session_stats');
    this.db.run('DELETE FROM model_billing');
    this.db.run('DELETE FROM sessions');
    this.markDirty();   // saved when the caller's withWriteLock completes
  }

  /**
   * Close the in-memory database. Writes are saved when their write lock is
   * released, so nothing is pending here; an in-memory schema migration that was
   * never persisted (startup lock timeout) is simply redone by the next window.
   */
  close(): void {
    if (this.dirty && !this.lockHeld) {
      console.warn('[AIUsageTracker] closing with unsaved in-memory changes (not persisted without the lock)');
    }
    this.db.close();
  }

  // ---- Helpers ------------------------------------------------------------

  private queryRows(sql: string, params?: SqlValue[]): SqlRow[] {
    // Pick up data written by other windows (throttled; never mid-write).
    if (!this.lockHeld && Date.now() - this.lastReloadCheck >= RELOAD_CHECK_MS) {
      this.checkForExternalChanges();
    }
    const result = this.db.exec(sql, params);
    if (result.length === 0) { return []; }
    const cols = result[0].columns;
    return result[0].values.map((row: SqlValue[]) => {
      const obj: SqlRow = {};
      cols.forEach((c: string, i: number) => { obj[c] = row[i]; });
      return obj;
    });
  }
}

// ---- Row mappers ----------------------------------------------------------

function mapSessionInfo(row: Record<string, unknown>): SessionInfo {
  return {
    id: (row.id as string) || (row.session_id as string) || '',
    workspaceId: (row.workspace_id as string) || '',
    dirPath: (row.dir_path as string) || '',
    startTime: (row.start_time as number) || 0,
    endTime: (row.end_time as number) || 0,
    copilotVersion: (row.copilot_version as string) || '',
    vscodeVersion: (row.vscode_version as string) || '',
    provider: ((row.provider as ProviderId) || 'copilot'),
    repository: (row.repository as string) || undefined,
    branch: (row.branch as string) || undefined,
    cwd: (row.cwd as string) || undefined,
    agentName: (row.agent_name as string) || undefined,
    agentDescription: (row.agent_description as string) || undefined,
    dataSource: (row.data_source as 'otel' | 'jsonl' | 'hybrid') || undefined,
  };
}

function mapSessionStats(row: Record<string, unknown>): SessionStats {
  return {
    sessionId: (row.session_id as string) || (row.id as string) || '',
    provider: ((row.provider as ProviderId) || 'copilot'),
    totalInputTokens: (row.total_input_tokens as number) || 0,
    totalOutputTokens: (row.total_output_tokens as number) || 0,
    totalTokens: (row.total_tokens as number) || 0,
    costUSD: (row.weighted_cost as number) || 0,
    llmRequestCount: (row.llm_request_count as number) || 0,
    userMessageCount: (row.user_message_count as number) || 0,
    toolCallCount: (row.tool_call_count as number) || 0,
    errorCount: (row.error_count as number) || 0,
    turnCount: (row.turn_count as number) || 0,
    subagentCount: (row.subagent_count as number) || 0,
    avgTokensPerRequest: (row.avg_tokens_per_request as number) || 0,
    avgTtft: (row.avg_ttft as number) || 0,
    durationMs: (row.duration_ms as number) || 0,
    modelsUsed: parseJsonArray(row.models_used as string),
    dominantModel: (row.dominant_model as string) || '',
    efficiencyScore: (row.efficiency_score as number) || 0,
    reworkScore: (row.rework_score as number) || 0,
    totalReasoningTokens: (row.total_reasoning_tokens as number) || 0,
    totalCachedTokens: (row.total_cached_tokens as number) || 0,
    totalCacheWriteTokens: (row.total_cache_write_tokens as number) || 0,
    dataSource: ((row.data_source as string) || 'jsonl') as 'otel' | 'jsonl' | 'hybrid',
    costAuditState: ((row.cost_audit_state as string) || 'estimated') as SessionStats['costAuditState'],
    costAuditFlags: parseJsonArray(row.cost_audit_flags as string),
    pricingTableVersion: (row.pricing_table_version as number) || 0,
    costFormulaVersion: (row.cost_formula_version as number) || 0,
  };
}

function mapSessionWithStats(row: Record<string, unknown>): SessionInfo & SessionStats {
  return { ...mapSessionInfo(row), ...mapSessionStats(row) };
}

function mapLLMRequest(row: Record<string, unknown>): LLMRequestRecord {
  return {
    sessionId: row.session_id as string,
    provider: ((row.provider as ProviderId) || 'copilot'),
    spanId: (row.span_id as string) || '',
    parentSpanId: row.parent_span_id as string | undefined,
    timestamp: row.timestamp as number,
    duration: row.duration as number,
    model: row.model as string,
    inputTokens: row.input_tokens as number,
    outputTokens: row.output_tokens as number,
    cachedInputTokens: (row.cached_input_tokens as number) || 0,
    cacheWriteTokens: (row.cache_write_tokens as number) || 0,
    cacheWrite1hTokens: (row.cache_write_1h_tokens as number) || 0,
    totalTokens: (row.input_tokens as number) + (row.output_tokens as number),
    ttft: row.ttft as number,
    maxTokens: row.max_tokens as number,
    status: row.status as 'ok' | 'error',
    error: row.error as string | undefined,
    isSubagent: (row.is_subagent as number) === 1,
    subagentName: row.subagent_name as string | undefined,
    userRequestPreview: row.user_request_preview as string | undefined,
    reasoningTokens: (row.reasoning_tokens as number) || 0,
    responseModel: (row.response_model as string) || undefined,
    traceId: (row.trace_id as string) || undefined,
    conversationId: (row.conversation_id as string) || undefined,
    inputTokensSource: ((row.input_tokens_source as string) || 'unknown') as TokenDataSource,
    outputTokensSource: ((row.output_tokens_source as string) || 'unknown') as TokenDataSource,
    cachedInputTokensSource: ((row.cached_input_tokens_source as string) || 'unknown') as TokenDataSource,
    cacheWriteTokensSource: ((row.cache_write_tokens_source as string) || 'unknown') as TokenDataSource,
    reasoningTokensSource: ((row.reasoning_tokens_source as string) || 'unknown') as TokenDataSource,
    promptExportKey: (row.prompt_export_key as string) || undefined,
    cacheMatchConfidence: row.cache_match_confidence as number | undefined,
    tokenAuditFlags: parseJsonArray(row.token_audit_flags as string),
    directCredits: row.direct_credits != null ? (row.direct_credits as number) : undefined,
    directCreditsSource: (row.direct_credits_source as TokenDataSource) || undefined,
    outputText: (row.output_text as string) || undefined,
    reasoningText: (row.reasoning_text as string) || undefined,
  };
}

function mapUserMessage(row: Record<string, unknown>): UserMessageRecord {
  return {
    sessionId: row.session_id as string,
    spanId: (row.span_id as string) || '',
    timestamp: row.timestamp as number,
    contentLength: row.content_length as number,
    contentPreview: row.content_preview as string,
    contentFull: (row.content_full as string) || undefined,
  };
}

function parseJsonArray(val: string | null | undefined): string[] {
  if (!val) { return []; }
  try { return JSON.parse(val); } catch { return []; }
}

function localDateKey(timestamp: number): string {
  const d = new Date(timestamp);
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

// ---- Schema ---------------------------------------------------------------

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY, workspace_id TEXT, dir_path TEXT,
  start_time INTEGER NOT NULL, end_time INTEGER,
  copilot_version TEXT, vscode_version TEXT,
  file_mtime INTEGER, parsed_at INTEGER,
  repository TEXT, branch TEXT, cwd TEXT,
  agent_name TEXT, agent_description TEXT,
  data_source TEXT DEFAULT 'jsonl',
  provider TEXT DEFAULT 'copilot'
);
CREATE TABLE IF NOT EXISTS llm_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  span_id TEXT, parent_span_id TEXT, timestamp INTEGER NOT NULL,
  duration INTEGER, model TEXT, input_tokens INTEGER DEFAULT 0,
  output_tokens INTEGER DEFAULT 0,
  cached_input_tokens INTEGER DEFAULT 0,
  cache_write_tokens INTEGER DEFAULT 0,
  cache_write_1h_tokens INTEGER DEFAULT 0,
  ttft INTEGER, max_tokens INTEGER,
  status TEXT, error TEXT, is_subagent INTEGER DEFAULT 0,
  subagent_name TEXT, user_request_preview TEXT,
  reasoning_tokens INTEGER DEFAULT 0,
  response_model TEXT, trace_id TEXT, conversation_id TEXT,
  input_tokens_source TEXT DEFAULT 'unknown',
  output_tokens_source TEXT DEFAULT 'unknown',
  cached_input_tokens_source TEXT DEFAULT 'unknown',
  cache_write_tokens_source TEXT DEFAULT 'unknown',
  reasoning_tokens_source TEXT DEFAULT 'unknown',
  prompt_export_key TEXT,
  cache_match_confidence REAL,
  token_audit_flags TEXT DEFAULT '[]',
  direct_credits REAL,
  direct_credits_source TEXT,
  provider TEXT DEFAULT 'copilot',
  output_text TEXT,
  reasoning_text TEXT
);
CREATE TABLE IF NOT EXISTS user_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  span_id TEXT, timestamp INTEGER NOT NULL,
  content_length INTEGER, content_preview TEXT,
  content_full TEXT
);
CREATE TABLE IF NOT EXISTS tool_calls (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  span_id TEXT, parent_span_id TEXT, timestamp INTEGER NOT NULL,
  duration INTEGER, tool_name TEXT, status TEXT, is_subagent INTEGER DEFAULT 0,
  tool_type TEXT, tool_call_id TEXT,
  args TEXT, result TEXT, error_text TEXT
);
CREATE TABLE IF NOT EXISTS model_billing (
  model_id TEXT PRIMARY KEY, name TEXT, vendor TEXT,
  multiplier REAL DEFAULT 1.0, is_premium INTEGER DEFAULT 0,
  max_context_tokens INTEGER, max_output_tokens INTEGER
);
CREATE TABLE IF NOT EXISTS session_stats (
  session_id TEXT PRIMARY KEY REFERENCES sessions(id),
  total_input_tokens INTEGER, total_output_tokens INTEGER,
  total_tokens INTEGER, weighted_cost REAL,
  llm_request_count INTEGER, user_message_count INTEGER,
  tool_call_count INTEGER, error_count INTEGER,
  turn_count INTEGER, subagent_count INTEGER,
  avg_tokens_per_request REAL, avg_ttft REAL,
  duration_ms INTEGER, models_used TEXT, dominant_model TEXT,
  efficiency_score REAL, rework_score REAL,
  total_reasoning_tokens INTEGER DEFAULT 0,
  total_cached_tokens INTEGER DEFAULT 0,
  total_cache_write_tokens INTEGER DEFAULT 0,
  data_source TEXT DEFAULT 'jsonl',
  cost_audit_state TEXT DEFAULT 'estimated',
  cost_audit_flags TEXT DEFAULT '[]',
  pricing_table_version INTEGER DEFAULT 0,
  cost_formula_version INTEGER DEFAULT 0,
  provider TEXT DEFAULT 'copilot'
);
CREATE INDEX IF NOT EXISTS idx_llm_session ON llm_requests(session_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_llm_session_span_unique ON llm_requests(session_id, span_id) WHERE span_id IS NOT NULL AND span_id != '';
CREATE INDEX IF NOT EXISTS idx_llm_timestamp ON llm_requests(timestamp);
CREATE INDEX IF NOT EXISTS idx_llm_provider ON llm_requests(provider);
CREATE INDEX IF NOT EXISTS idx_messages_session ON user_messages(session_id);
CREATE INDEX IF NOT EXISTS idx_tools_session ON tool_calls(session_id);
CREATE INDEX IF NOT EXISTS idx_sessions_start ON sessions(start_time);

CREATE TABLE IF NOT EXISTS prompt_export_cache (
  key TEXT PRIMARY KEY,
  model TEXT NOT NULL,
  prompt_tokens INTEGER NOT NULL,
  completion_tokens INTEGER NOT NULL,
  total_tokens INTEGER NOT NULL,
  cached_prompt_tokens INTEGER NOT NULL,
  cache_write_tokens INTEGER NOT NULL DEFAULT 0,
  reasoning_tokens INTEGER NOT NULL,
  duration_ms INTEGER,
  time_to_first_token_ms INTEGER,
  timestamp TEXT,
  timestamp_ms INTEGER,
  stored_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_prompt_cache_model_tokens
  ON prompt_export_cache(model, prompt_tokens, completion_tokens);
`;

const PROMPT_EXPORT_CACHE_SQL = `
CREATE TABLE IF NOT EXISTS prompt_export_cache (
  key TEXT PRIMARY KEY,
  model TEXT NOT NULL,
  prompt_tokens INTEGER NOT NULL,
  completion_tokens INTEGER NOT NULL,
  total_tokens INTEGER NOT NULL,
  cached_prompt_tokens INTEGER NOT NULL,
  cache_write_tokens INTEGER NOT NULL DEFAULT 0,
  reasoning_tokens INTEGER NOT NULL,
  duration_ms INTEGER,
  time_to_first_token_ms INTEGER,
  timestamp TEXT,
  timestamp_ms INTEGER,
  stored_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_prompt_cache_model_tokens
  ON prompt_export_cache(model, prompt_tokens, completion_tokens);
`;
