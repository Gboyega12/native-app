// ── Sync Coordinator ──
// Prevents duplicate sync calls across screens and shares results.
// When Home, Plan, or Chat all call requestSync() simultaneously,
// only one actual syncBankData() runs — the others await the same promise.
//
// Adaptive sync intervals:
// - First sync after app open: always runs (no cache)
// - Subsequent syncs within a session: 30s minimum between calls
// - Force-sync: bypass cache entirely (e.g., pull-to-refresh)

import { syncBankData, type SyncResult } from '@/lib/sync';

type SyncListener = (result: SyncResult | null) => void;

let _activeSyncPromise: Promise<SyncResult | null> | null = null;
let _lastResult: SyncResult | null = null;
let _lastSyncTime = 0;
const _listeners: Set<SyncListener> = new Set();

/** Minimum interval between automatic syncs (30 seconds). */
const MIN_SYNC_INTERVAL_MS = 30_000;

/** Maximum time the entire sync pipeline may run before we bail out (30 seconds). */
const SYNC_TIMEOUT_MS = 30_000;

/**
 * Request a bank data sync. If one is already in-flight, returns the
 * existing promise instead of starting a duplicate.
 *
 * @param userId - The authenticated user's ID.
 * @param force  - Skip the cooldown cache and always fetch fresh data.
 *                 Use for pull-to-refresh or explicit user-initiated sync.
 */
export async function requestSync(
  userId: string,
  force: boolean = false,
): Promise<SyncResult | null> {
  // If a sync is already running, piggy-back on it
  if (_activeSyncPromise) return _activeSyncPromise;

  // Skip if synced very recently (unless force-requested)
  if (!force && Date.now() - _lastSyncTime < MIN_SYNC_INTERVAL_MS && _lastResult) {
    return _lastResult;
  }

  _activeSyncPromise = Promise.race([
    syncBankData(userId),
    new Promise<null>((resolve) =>
      setTimeout(() => {
        console.warn('[sync-coordinator] sync timed out after', SYNC_TIMEOUT_MS, 'ms');
        resolve(null);
      }, SYNC_TIMEOUT_MS),
    ),
  ])
    .then((result) => {
      if (result) {
        _lastResult = result;
        _lastSyncTime = Date.now();
      }
      // Notify all subscribers
      for (const listener of _listeners) {
        try { listener(result); } catch {}
      }
      return result;
    })
    .catch((e) => {
      console.warn('[sync-coordinator] syncBankData failed:', e?.message || e);
      return null;
    })
    .finally(() => {
      _activeSyncPromise = null;
    });

  return _activeSyncPromise;
}

/**
 * Subscribe to sync completions. Returns an unsubscribe function.
 * Useful for screens that want to update when another screen triggers a sync.
 */
export function onSyncComplete(listener: SyncListener): () => void {
  _listeners.add(listener);
  return () => { _listeners.delete(listener); };
}

/** Get the last sync result without triggering a new sync. */
export function getLastSyncResult(): SyncResult | null {
  return _lastResult;
}

/** Whether a sync is currently in-flight. */
export function isSyncing(): boolean {
  return _activeSyncPromise !== null;
}

/** Epoch ms of last successful sync. Returns 0 if never synced. */
export function getLastSyncTime(): number {
  return _lastSyncTime;
}

/** Invalidate the cache so the next requestSync() always fetches fresh. */
export function invalidateSyncCache(): void {
  _lastSyncTime = 0;
  _lastResult = null;
}
