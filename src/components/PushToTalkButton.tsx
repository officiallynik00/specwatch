"use client";

import { useCallback } from "react";
import type { PttStatus } from "@/hooks/usePushToTalk";

interface PushToTalkButtonProps {
  status: PttStatus;
  isTalking: boolean;
  partnerTalking: boolean;
  error: string | null;
  partnerName: string | null;
  onStart: () => void;
  onStop: () => void;
  onRetry: () => void;
  // The windowed chat drawer becomes a full-width bottom sheet
  // (h-[70dvh]) on mobile, but only below Tailwind's sm breakpoint —
  // at sm and up it's a fixed-size corner panel that doesn't reach
  // this button's corner at all. So this only needs to reposition the
  // mic on the narrow/mobile case; see the className below.
  chatOpen?: boolean;
}

const STATUS_COPY: Record<PttStatus, string> = {
  idle: "Waiting for partner to talk to",
  connecting: "Connecting voice…",
  connected: "Tap to talk",
  failed: "Voice unavailable — tap to retry",
  unsupported: "Voice not supported in this browser",
};

export default function PushToTalkButton({
  status,
  isTalking,
  partnerTalking,
  error,
  partnerName,
  onStart,
  onStop,
  onRetry,
  chatOpen,
}: PushToTalkButtonProps) {
  // Tap-to-toggle: one tap turns the mic on and leaves it on, the next
  // tap turns it off — as opposed to the earlier press-and-hold design.
  // A single onClick now covers both "start talking" and "retry a
  // failed connection", branching on status, so there's no separate
  // down/up pair (and nothing left that can get stuck "held").
  const handleClick = useCallback(() => {
    if (status === "failed") {
      onRetry();
    } else if (status === "connected") {
      if (isTalking) onStop();
      else onStart();
    }
  }, [status, isTalking, onStart, onStop, onRetry]);

  const disabled = status !== "connected" && status !== "failed";
  const label = error ?? (partnerTalking ? `${partnerName ?? "Partner"} is talking…` : STATUS_COPY[status]);

  return (
    <div
      className={`fixed left-5 z-30 flex flex-col items-start gap-2 transition-[bottom] duration-300 ${
        // Lifted above the open chat drawer on mobile only — the drawer
        // isn't full-width at sm+ so bottom-5 is always correct there,
        // regardless of chatOpen.
        chatOpen ? "bottom-[calc(70dvh+1rem)] sm:bottom-5" : "bottom-5"
      }`}
    >
      {(isTalking || partnerTalking || error || status === "failed") && (
        <span
          className={`rounded-full border px-3 py-1 text-xs ${
            error || status === "failed"
              ? "border-reel-rose/40 bg-reel-rose/10 text-reel-rose"
              : "border-reel-border bg-reel-surface text-reel-muted"
          }`}
        >
          {label}
        </span>
      )}
      <button
        onClick={handleClick}
        onContextMenu={(e) => e.preventDefault()}
        disabled={disabled}
        aria-pressed={isTalking}
        aria-label={status === "failed" ? "Retry voice connection" : isTalking ? "Tap to stop talking" : "Tap to talk"}
        title={status === "failed" ? label : disabled ? label : isTalking ? "Tap to stop talking" : "Tap to talk"}
        className={`flex h-14 w-14 select-none items-center justify-center rounded-full border text-xl shadow-lg shadow-black/40 transition ${
          status === "failed"
            ? "border-reel-rose/50 bg-reel-rose/10 text-reel-rose hover:bg-reel-rose/20"
            : disabled
              ? "cursor-not-allowed border-reel-border bg-reel-surface text-reel-muted/50"
              : isTalking
                ? "border-reel-amber bg-reel-amber text-reel-bg animate-pulseGlow"
                : "border-reel-border bg-reel-surface text-reel-text hover:border-reel-amber"
        }`}
      >
        {status === "failed" ? "↻" : isTalking ? "🔴" : "🎙️"}
      </button>
    </div>
  );
}
