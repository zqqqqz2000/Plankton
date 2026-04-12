import type { DashboardData } from "./types";

export function normalizeHandoffRequestId(
  value: string | null | undefined,
): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

export function resolvePendingHandoffRequestId(
  dashboard: DashboardData,
  requestId: string | null,
): string | null {
  const normalized = normalizeHandoffRequestId(requestId);
  if (!normalized) {
    return null;
  }

  return (
    dashboard.pending_requests.find((request) => request.id === normalized)
      ?.id ?? null
  );
}
