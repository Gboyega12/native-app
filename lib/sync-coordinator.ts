// ── Sync Coordinator ──
// Prevents duplicate sync calls across screens and shares results.
// When Home, Plan, or Chat all call requestSync() simultaneously,
// only one actual syncBankData() runs — the others await the same promise.

import { syncBankData, type SyncResult } from '@/lib/sync';

type SyncListener = (result: SyncResult | null) => void;

let _activeSyncPromise: Promise<SyncResult | null> | null = null;
let _lastResult: SyncResult | null = null;
let _lastSyncTime = 0;
const _listeners: Set<SyncListener> = new Set();

/** Minimum interval between syncs (60 seconds). */
const MIN_SYNC_INTERVAL_MS = 60_000;

/**
 * Request a bank data sync. If one is already in-flight, returns the
 * existing promise instead of starting a duplicate.
 *
 * Screens should call this instead of syncBankData() directly.
 */
export async function requestSync(userId: string): Promise<SyncResult | null> {
  // If a sync is already running, piggy-back on it
  if (_activeSyncPromise) return _activeSyncPromise;

  // Skip if synced very recently
  if (Date.now() - _lastSyncTime < MIN_SYNC_INTERVAL_MS && _lastResult) {
    return _lastResult;
  }

  _activeSyncPromise = syncBankData(userId)
    .then((result) => {
      _lastResult = result;
      _lastSyncTime = Date.now();
      // Notify all subscribers
      for (const listener of _listeners) {
        try { listener(result); } catch {}
      }
      return result;
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
