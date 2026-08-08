"use client";

import { useEffect, useRef, useState } from "react";
import type { ChatMessage } from "@/lib/types";

interface FullscreenChatOverlayProps {
  messages: ChatMessage[];
  myName: string;
  onSend: (body: string) => void;
  onDisable: () => void;
}

interface FloatingLine {
  key: string;
  message: ChatMessage;
}

const MAX_VISIBLE = 4;
const LINE_LIFETIME_MS = 5000;

/**
 * Non-obstructing fullscreen chat. Instead of a persistent panel sitting
 * over the video, new messages float up briefly near the bottom-left
 * (caption style) and remove themselves — same animate-then-remove
 * pattern EmojiOverlay uses for reaction bubbles. The message area is
 * pointer-events-none so taps pass through to the video/controls
 * underneath even while a line is visible. Only the slim input pill at
 * the very bottom is actually interactive.
 */
export default function FullscreenChatOverlay({ messages, myName, onSend, onDisable }: FullscreenChatOverlayProps) {
  const [draft, setDraft] = useState("");
  const [lines, setLines] = useState<FloatingLine[]>([]);
  const lastMessageIdRef = useRef<string | null>(null);

  // Diff against the last id we've floated rather than replaying the
  // whole `messages` array, so re-renders never re-float old lines.
  useEffect(() => {
    if (messages.length === 0) return;
    const lastIndex = lastMessageIdRef.current
      ? messages.findIndex((m) => m.id === lastMessageIdRef.current)
      : -1;
    const fresh = messages.slice(lastIndex + 1);
    if (fresh.length === 0) return;
    lastMessageIdRef.current = messages[messages.length - 1].id;
    setLines((prev) =>
      [...prev, ...fresh.map((message) => ({ key: `${message.id}-${Date.now()}`, message }))].slice(-MAX_VISIBLE)
    );
  }, [messages]);

  const removeLine = (key: string) => setLines((prev) => prev.filter((l) => l.key !== key));

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!draft.trim()) return;
    onSend(draft);
    setDraft("");
  };

  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-0 z-20 flex flex-col items-start gap-1.5 px-3 pb-[calc(env(safe-area-inset-bottom)+5rem)] sm:px-4 sm:pb-[calc(env(safe-area-inset-bottom)+6rem)]">
      {/* Floating lines — fade in, hold, fade out, self-remove. Capped
          width + clamp so one long message never covers much of the frame. */}
      <div className="flex w-full max-w-[78vw] flex-col gap-1.5 sm:max-w-sm">
        {lines.map(({ key, message }) => {
          const mine = message.sender_name === myName;
          return (
            <div
              key={key}
              onAnimationEnd={() => removeLine(key)}
              style={{ animationDuration: `${LINE_LIFETIME_MS}ms` }}
              className="animate-chatFloat line-clamp-2 w-fit max-w-full rounded-lg bg-black/55 px-2.5 py-1.5 text-xs text-reel-text backdrop-blur-sm sm:text-sm"
            >
              <span className={mine ? "text-reel-amber" : "text-reel-amber/80"}>{mine ? "You" : message.sender_name}</span>
              <span className="text-reel-text/60"> · </span>
              {message.body}
            </div>
          );
        })}
      </div>

      {/* Slim docked input — small footprint instead of a full panel.
          Sits above the fullscreen control bar via the bottom padding
          on the wrapper above. */}
      <form onSubmit={handleSubmit} className="pointer-events-auto flex w-full max-w-xs items-center gap-1.5 sm:max-w-sm">
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="Message…"
          className="min-w-0 flex-1 rounded-full border border-white/10 bg-black/40 px-3 py-1.5 text-xs text-reel-text placeholder:text-reel-text/40 backdrop-blur-sm focus:border-reel-amber focus:outline-none sm:text-sm"
          autoComplete="off"
        />
        <button
          type="submit"
          className="shrink-0 rounded-full bg-reel-amber px-3 py-1.5 text-xs font-medium text-reel-bg transition hover:bg-reel-amberDim sm:text-sm"
        >
          Send
        </button>
        <button
          type="button"
          onClick={onDisable}
          aria-label="Turn off chat overlay"
          title="Turn off chat"
          className="shrink-0 rounded-full bg-black/40 p-1.5 text-reel-text/70 backdrop-blur-sm hover:text-reel-text"
        >
          <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M18 6 6 18M6 6l12 12" />
          </svg>
        </button>
      </form>
    </div>
  );
}
