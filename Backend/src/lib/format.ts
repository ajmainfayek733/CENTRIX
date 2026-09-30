/** Shared formatting for Backend. Kept in one place so a duration reads identically on every screen. */

/** Seconds as "6h 12m", "12m", or "45s". Zero renders as "0m". */
export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds)) return "-";
  if (seconds <= 0) return "0m";

  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);

  if (hours > 0) return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  if (minutes > 0) return `${minutes}m`;
  return `${Math.floor(seconds)}s`;
}

export function formatPercent(value: number): string {
  return `${Math.round(value * 10) / 10}%`;
}

export function formatTime(value: string | Date | null | undefined): string {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "-";
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

export function formatDateTime(value: string | Date | null | undefined): string {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "-";
  return date.toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

