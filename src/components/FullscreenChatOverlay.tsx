"use client";

import { useEffect, useRef, useState } from "react";
import type { ChatMessage } from "@/lib/types";

interface FullscreenChatOverlayProps {
  messages: ChatMessage[];
  myName: string;
  onSend: (body: string) => void;
  onDisable: () => void;
}

const IDLE_FADE_MS = 4000;

function formatClock(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

/**
 * Lives inside VideoPlayer's fullscreen container (not a `fixed` sibling
 * like ChatDrawer), so it actually renders while the browser Fullscreen
 * API is active — only the fullscreened element's own subtree is shown
 * on screen at that point. Fades to near-transparent after a few seconds
 * of no interaction so it doesn't sit over the movie; any interaction
 * (mouse move, typing, a new message arriving) brings it back.
 */
export default function FullscreenChatOverlay({ messages, myName, onSend, onDisable }: FullscreenChatOverlayProps) {
  const [draft, setDraft] = useState("");
  const [faded, setFaded] = useState(false);
  const idleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const wake = () => {
    setFaded(false);
    if (idleTimerRef.current) clearTimeout(idleTimerRef.current);
    idleTimerRef.current = setTimeout(() => setFaded(true), IDLE_FADE_MS);
  };

  useEffect(() => {
    wake();
    return () => {
      if (idleTimerRef.current) clearTimeout(idleTimerRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // A new message wakes the panel back up even mid-fade, and keeps the
  // list scrolled to the latest line.
  useEffect(() => {
    wake();
    if (listRef.current) listRef.current.scrollTop = listRef.current.scrollHeight;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!draft.trim()) return;
    onSend(draft);
    setDraft("");
    wake();
  };

  return (
    <div
      onMouseMove={wake}
      onTouchStart={wake}
      className={`absolute bottom-20 right-3 z-20 flex w-72 max-w-[75vw] flex-col overflow-hidden rounded-xl border border-white/10 bg-black/40 backdrop-blur-md transition-opacity duration-700 ${
        faded ? "opacity-20 hover:opacity-90" : "opacity-100"
      }`}
      style={{ maxHeight: "45vh" }}
    >
      <div className="flex shrink-0 items-center justify-between border-b border-white/10 px-3 py-2">
        <span className="text-xs font-medium uppercase tracking-wide text-reel-text/90">Chat</span>
        <button
          onClick={onDisable}
          aria-label="Turn off chat overlay"
          title="Turn off chat"
          className="text-reel-text/70 hover:text-reel-text"
        >
          ✕
        </button>
      </div>

      <div ref={listRef} className="min-h-0 flex-1 space-y-2 overflow-y-auto px-3 py-2">
        {messages.length === 0 && <p className="py-4 text-center text-xs text-reel-text/50">No messages yet.</p>}
        {messages.map((m) => {
          const mine = m.sender_name === myName;
          return (
            <div key={m.id} className={`flex flex-col ${mine ? "items-end" : "items-start"}`}>
              <div
                className={`max-w-[85%] break-words rounded-xl px-2.5 py-1.5 text-xs ${
                  mine ? "bg-reel-amber/90 text-reel-bg" : "bg-white/10 text-reel-text"
                }`}
              >
                {m.body}
              </div>
              <span className="mt-0.5 px-0.5 text-[9px] text-reel-text/50">
                {mine ? "You" : m.sender_name} · {formatClock(m.created_at)}
              </span>
            </div>
          );
        })}
      </div>

      {/* min-w-0 on the input keeps it from overflowing its flex basis
          and pushing/overlapping the Send button on narrow widths. */}
      <form onSubmit={handleSubmit} className="flex shrink-0 items-center gap-2 border-t border-white/10 p-2">
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onFocus={wake}
          placeholder="Message…"
          className="min-w-0 flex-1 rounded-full border border-white/10 bg-black/30 px-3 py-1.5 text-xs text-reel-text placeholder:text-reel-text/40 focus:border-reel-amber focus:outline-none"
          autoComplete="off"
        />
        <button
          type="submit"
          className="shrink-0 rounded-full bg-reel-amber px-3 py-1.5 text-xs font-medium text-reel-bg transition hover:bg-reel-amberDim"
        >
          Send
        </button>
      </form>
    </div>
  );
}
