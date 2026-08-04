"use client";

import type { ConnectionStatus as Status } from "@/hooks/useRoomSync";

const COPY: Record<Status, { label: string; dot: string }> = {
  "both-connected": { label: "Both here", dot: "bg-emerald-400" },
  "waiting-for-partner": { label: "Waiting for partner", dot: "bg-reel-amber animate-pulseGlow" },
  "partner-away": { label: "Partner disconnected", dot: "bg-reel-rose animate-pulseGlow" },
  reconnecting: { label: "Reconnecting…", dot: "bg-reel-rose animate-pulseGlow" },
  connecting: { label: "Connecting…", dot: "bg-reel-amber animate-pulseGlow" },
};

interface ConnectionStatusProps {
  status: Status;
  reconnectAttempts?: number;
}

export default function ConnectionStatus({ status, reconnectAttempts }: ConnectionStatusProps) {
  const { label, dot } = COPY[status];
  const displayLabel =
    status === "reconnecting" && reconnectAttempts && reconnectAttempts > 1
      ? `${label} (attempt ${reconnectAttempts})`
      : label;

  return (
    <div className="flex items-center gap-2 rounded-full border border-reel-border bg-reel-surface px-3 py-1.5 text-xs text-reel-muted">
      <span className={`h-2 w-2 rounded-full ${dot}`} />
      {displayLabel}
    </div>
  );
}
