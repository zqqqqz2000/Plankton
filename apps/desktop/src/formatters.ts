export function formatStatus(status: string): string {
  return status
    .replace(/[_-]/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

export function formatDecision(decision: string | null): string {
  return decision ? formatStatus(decision) : "Pending";
}

export function formatTimestamp(
  timestamp: string | null,
  fallback = "Not resolved",
): string {
  if (!timestamp) {
    return fallback;
  }

  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) {
    return fallback;
  }

  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

export function formatElapsed(
  timestamp: string | null,
  now = Date.now(),
): string {
  if (!timestamp) {
    return "Waiting";
  }

  const value = Date.parse(timestamp);
  if (Number.isNaN(value)) {
    return "Waiting";
  }

  const delta = now - value;
  const absoluteDelta = Math.abs(delta);

  if (absoluteDelta < 60_000) {
    return "just now";
  }

  const units = [
    ["d", 86_400_000],
    ["h", 3_600_000],
    ["m", 60_000],
  ] as const;

  for (const [unit, size] of units) {
    if (absoluteDelta >= size) {
      const amount = Math.floor(absoluteDelta / size);
      return `${amount}${unit} ${delta >= 0 ? "ago" : "from now"}`;
    }
  }

  return "just now";
}

export function formatShortId(value: string): string {
  return value.length <= 8 ? value : `${value.slice(0, 8)}...`;
}
