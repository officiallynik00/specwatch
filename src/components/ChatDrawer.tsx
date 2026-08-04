"use client";

import { useEffect, useRef, useState } from "react";
import type { ChatMessage } from "@/lib/types";

interface ChatDrawerProps {
  open: boolean;
  onToggle: () => void;
  messages: ChatMessage[];
  myName: string;
  onSend: (body: string) => void;
}

function formatClock(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

export default function ChatDrawer({ open, onToggle, messages, myName, onSend }: ChatDrawerProps) {
  const [draft, setDraft] = useState("");
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (open && listRef.current) {
      listRef.current.scrollTop = listRef.current.scrollHeight;
    }
  }, [messages, open]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!draft.trim()) return;
    onSend(draft);
    setDraft("");
  };

  return (
    <>
      <button
        onClick={onToggle}
        className="fixed bottom-5 right-5 z-30 flex h-12 w-12 items-center justify-center rounded-full border border-reel-border bg-reel-surface text-reel-text shadow-lg shadow-black/40 transition hover:border-reel-amber"
        aria-label={open ? "Close chat" : "Open chat"}
      >
        💬
      </button>

      {open && (
        <div className="fixed bottom-0 right-0 z-20 flex h-[70dvh] w-full max-w-sm animate-slideUp flex-col rounded-t-2xl border border-reel-border bg-reel-surface shadow-2xl shadow-black/60 sm:bottom-5 sm:right-5 sm:h-[520px] sm:rounded-2xl">
          <div className="flex items-center justify-between rounded-t-2xl border-b border-reel-border bg-reel-surface2 px-4 py-3">
            <span className="font-display text-lg italic text-reel-text">Chat</span>
            <button onClick={onToggle} className="text-reel-muted hover:text-reel-text" aria-label="Close chat">
              ✕
            </button>
          </div>

          <div ref={listRef} className="flex-1 space-y-3 overflow-y-auto px-4 py-3">
            {messages.length === 0 && (
              <p className="pt-8 text-center text-sm text-reel-muted">
                No messages yet. Say hi before the movie starts.
              </p>
            )}
            {messages.map((m) => {
              const mine = m.sender_name === myName;
              return (
                <div key={m.id} className={`flex flex-col ${mine ? "items-end" : "items-start"}`}>
                  <div
                    className={`max-w-[85%] rounded-2xl px-3 py-2 text-sm ${
                      mine
                        ? "rounded-br-sm bg-reel-amber text-reel-bg"
                        : "rounded-bl-sm bg-reel-surface2 text-reel-text"
                    }`}
                  >
                    {m.body}
                  </div>
                  <span className="mt-1 px-1 text-[10px] text-reel-muted">
                    {mine ? "You" : m.sender_name} · {formatClock(m.created_at)}
                  </span>
                </div>
              );
            })}
          </div>

          <form onSubmit={handleSubmit} className="flex gap-2 border-t border-reel-border p-3">
            <input
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder="Type a message…"
              className="flex-1 rounded-full border border-reel-border bg-reel-bg px-4 py-2 text-sm text-reel-text placeholder:text-reel-muted/60 focus:border-reel-amber focus:outline-none"
              autoComplete="off"
            />
            <button
              type="submit"
              className="rounded-full bg-reel-amber px-4 py-2 text-sm font-medium text-reel-bg transition hover:bg-reel-amberDim"
            >
              Send
            </button>
          </form>
        </div>
      )}
    </>
  );
}
