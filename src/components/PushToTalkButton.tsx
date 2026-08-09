"use client";

import { useCallback, useRef } from "react";
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
}

const STATUS_COPY: Record<PttStatus, string> = {
  idle: "Waiting for partner to talk to",
  connecting: "Connecting voice…",
  connected: "Hold to talk",
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
}: PushToTalkButtonProps) {
  // Guards against a stray pointerup firing onStop twice (once from the
  // element, once from a window-level fallback) or onStop firing without
  // a matching onStart having gone through.
  const heldRef = useRef(false);

  const handleDown = useCallback(
    (e: React.PointerEvent) => {
      if (status !== "connected" || heldRef.current) return;
      e.preventDefault();
      heldRef.current = true;
      // Pointer capture keeps this element as the event target even if
      // the finger drifts a few pixels during the hold (normal on a
      // small touch button) — without it, a brief pointerleave would
      // fire onStop and cut the audio mid-sentence even though the
      // finger never actually lifted.
      try {
        e.currentTarget.setPointerCapture(e.pointerId);
      } catch {
        // Pointer capture isn't available in every environment; the
        // handlers below still work without it, just less forgivingly.
      }
      onStart();
    },
    [status, onStart]
  );

  const handleUp = useCallback(
    (e: React.PointerEvent) => {
      if (!heldRef.current) return;
      e.preventDefault();
      heldRef.current = false;
      try {
        e.currentTarget.releasePointerCapture(e.pointerId);
      } catch {
        // Already released or never captured — fine either way.
      }
      onStop();
    },
    [onStop]
  );

  const disabled = status !== "connected" && status !== "failed";
  const label = error ?? (partnerTalking ? `${partnerName ?? "Partner"} is talking…` : STATUS_COPY[status]);

  return (
    <div className="fixed bottom-5 left-5 z-30 flex flex-col items-start gap-2">
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
        // Pointer events unify mouse, touch, and pen in one handler pair.
        // When the connection has failed, this becomes a plain tap-to-retry
        // button instead of a press-and-hold one.
        onPointerDown={status === "failed" ? undefined : handleDown}
        onPointerUp={status === "failed" ? undefined : handleUp}
        onPointerCancel={status === "failed" ? undefined : handleUp}
        onClick={status === "failed" ? onRetry : undefined}
        onContextMenu={(e) => e.preventDefault()}
        disabled={disabled}
        aria-pressed={isTalking}
        aria-label={status === "failed" ? "Retry voice connection" : isTalking ? "Release to stop talking" : "Hold to talk"}
        title={status === "failed" ? label : disabled ? label : isTalking ? "Release to stop talking" : "Hold to talk"}
        className={`flex h-14 w-14 select-none items-center justify-center rounded-full border text-xl shadow-lg shadow-black/40 transition ${
          status === "failed"
            ? "border-reel-rose/50 bg-reel-rose/10 text-reel-rose hover:bg-reel-rose/20"
            : disabled
              ? "cursor-not-allowed border-reel-border bg-reel-surface text-reel-muted/50"
              : isTalking
                ? "border-reel-amber bg-reel-amber text-reel-bg animate-pulseGlow"
                : "border-reel-border bg-reel-surface text-reel-text hover:border-reel-amber"
        }`}
        style={{ touchAction: "none" }}
      >
        {status === "failed" ? "↻" : isTalking ? "🔴" : "🎙️"}
      </button>
    </div>
  );
}
