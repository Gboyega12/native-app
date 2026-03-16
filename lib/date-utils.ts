// ── Shared date formatting utilities ──
// Consolidated from index.tsx and api/chat/index.ts to avoid duplication.

/** Human-friendly "X ago" label from epoch ms */
export function formatTimeAgo(epochMs: number): string {
  const diffSec = Math.round((Date.now() - epochMs) / 1000);
  if (diffSec < 10) return 'just now';
  if (diffSec < 60) return `${diffSec}s ago`;
  const mins = Math.floor(diffSec / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

/** Format a date-only string (e.g. "2026-03-09") as a human-friendly age label.
 *  Date-only strings become midnight UTC when parsed, so we compare date strings
 *  directly for "today"/"yesterday" to avoid timezone-induced hour drift. */
export function formatTxDateAge(dateStr: string): string {
  const today = new Date().toISOString().split('T')[0];
  if (dateStr === today) return 'today';
  const yesterday = new Date(Date.now() - 86400000).toISOString().split('T')[0];
  if (dateStr === yesterday) return 'yesterday';
  const diffDays = Math.floor((Date.now() - new Date(dateStr).getTime()) / 86400000);
  return `${diffDays}d ago`;
}

/** Format a date string as a relative label: "Today", "Yesterday", or "Friday, 9 Mar" */
export function formatRelativeDate(dateStr: string): string {
  const d = new Date(dateStr + 'T00:00:00');
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const diff = Math.floor((today.getTime() - d.getTime()) / (1000 * 60 * 60 * 24));
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Yesterday';
  return d.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'short' });
}
