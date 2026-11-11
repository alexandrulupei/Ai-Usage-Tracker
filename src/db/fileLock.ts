import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';

// =============================================================================
// Cross-process exclusive lock for the tracker database.
//
// Every VS Code window runs its own extension host (a separate process) and all
// of them share one database file. The lock is a DIRECTORY: `mkdir` is atomic on
// every platform (including Windows/NTFS), so exactly one process can create it.
// The owner records itself in `owner.json` and refreshes a heartbeat while it
// holds the lock. A lock is considered abandoned (its window crashed or was
// closed mid-write) when the heartbeat is older than `staleMs`, or when the owner
// process no longer exists on this machine. An abandoned lock is taken over by
// RENAMING it away first, so two waiters can never both "steal" it.
// =============================================================================

export interface LockOptions {
  /** Give up after this long (0 = try once). */
  timeoutMs: number;
  /** A lock whose heartbeat is older than this is abandoned. */
  staleMs?: number;
  /** How often the owner refreshes its heartbeat. */
  heartbeatMs?: number;
  /** Called once if the lock is busy and we start waiting. */
  onWait?: () => void;
}

export interface LockHandle {
  release(): void;
}

interface OwnerInfo {
  pid: number;
  host: string;
  token: string;
  acquiredAt: number;
  heartbeatAt: number;
}

const OWNER_FILE = 'owner.json';
const DEFAULT_STALE_MS = 120_000;
const DEFAULT_HEARTBEAT_MS = 5_000;
const RETRY_MS = 250;

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function readOwner(lockDir: string): OwnerInfo | undefined {
  try {
    return JSON.parse(fs.readFileSync(path.join(lockDir, OWNER_FILE), 'utf8')) as OwnerInfo;
  } catch {
    return undefined;
  }
}

function writeOwner(lockDir: string, owner: OwnerInfo): void {
  fs.writeFileSync(path.join(lockDir, OWNER_FILE), JSON.stringify(owner));
}

/** True when `pid` is a live process (EPERM means it exists but isn't ours). */
function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Decide whether the existing lock was abandoned. */
function isStale(lockDir: string, staleMs: number): boolean {
  const owner = readOwner(lockDir);
  const now = Date.now();
  if (!owner) {
    // Just created and owner.json not written yet, or the writer died in
    // between: judge by the directory's own age.
    try { return now - fs.statSync(lockDir).mtimeMs > staleMs; } catch { return false; }
  }
  if (owner.host === os.hostname() && !processAlive(owner.pid)) { return true; }
  return now - owner.heartbeatAt > staleMs;
}

/** Remove an abandoned lock without racing other waiters doing the same. */
function takeOverStale(lockDir: string): void {
  const graveyard = `${lockDir}.stale-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
  try {
    fs.renameSync(lockDir, graveyard);   // only one process can win this rename
  } catch {
    return;                              // someone else took it over first
  }
  try { fs.rmSync(graveyard, { recursive: true, force: true }); } catch { /* best effort */ }
}

/**
 * Acquire the lock at `lockDir`, waiting up to `timeoutMs`. Resolves to a handle,
 * or undefined if the lock stayed busy for the whole timeout.
 */
export async function acquireLock(lockDir: string, opts: LockOptions): Promise<LockHandle | undefined> {
  const staleMs = opts.staleMs ?? DEFAULT_STALE_MS;
  const heartbeatMs = opts.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
  const deadline = Date.now() + Math.max(0, opts.timeoutMs);
  let notifiedWait = false;

  for (;;) {
    try {
      fs.mkdirSync(lockDir);
      return holdLock(lockDir, heartbeatMs);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') { throw err; }
    }
    if (isStale(lockDir, staleMs)) {
      takeOverStale(lockDir);
      continue;
    }
    if (Date.now() >= deadline) { return undefined; }
    if (!notifiedWait) { notifiedWait = true; opts.onWait?.(); }
    await sleep(RETRY_MS);
  }
}

function holdLock(lockDir: string, heartbeatMs: number): LockHandle {
  const owner: OwnerInfo = {
    pid: process.pid,
    host: os.hostname(),
    token: crypto.randomBytes(8).toString('hex'),
    acquiredAt: Date.now(),
    heartbeatAt: Date.now(),
  };
  writeOwner(lockDir, owner);
  const timer = setInterval(() => {
    owner.heartbeatAt = Date.now();
    try { writeOwner(lockDir, owner); } catch { /* lock dir gone; release() will notice */ }
  }, heartbeatMs);
  // Never keep a process alive just to heartbeat.
  if (typeof timer.unref === 'function') { timer.unref(); }

  let released = false;
  return {
    release(): void {
      if (released) { return; }
      released = true;
      clearInterval(timer);
      // Only remove the lock if it is still ours (it may have been taken over
      // as stale if this process stalled for longer than staleMs).
      const current = readOwner(lockDir);
      if (current && current.token !== owner.token) {
        console.warn('[AIUsageTracker] database lock was taken over by another window while held');
        return;
      }
      try { fs.rmSync(lockDir, { recursive: true, force: true }); } catch { /* best effort */ }
    },
  };
}
