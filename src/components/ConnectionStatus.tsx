"use client";

import type { ConnectionStatus as Status } from "@/hooks/useRoomSync";

const COPY: Record<Status, { label: string; dot: string }> = {
  "both-connected": { label: "Both here", dot: "bg-emerald-400" },
  "partner-away": { label: "Partner away", dot: "bg-reel-rose animate-pulseGlow" },
  connecting: { label: "Connecting…", dot: "bg-reel-amber animate-pulseGlow" },
};

export default function ConnectionStatus({ status }: { status: Status }) {
  const { label, dot } = COPY[status];
  return (
    <div className="flex items-center gap-2 rounded-full border border-reel-border bg-reel-surface px-3 py-1.5 text-xs text-reel-muted">
      <span className={`h-2 w-2 rounded-full ${dot}`} />
      {label}
    </div>
  );
}
