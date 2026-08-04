"use client";

import { QUICK_EMOJIS } from "@/lib/types";

export interface FloatingBubble {
  id: string;
  emoji: string;
  left: number; // percent, 0-100
  count?: number; // >1 when rapid taps/reactions got batched into one burst
}

interface EmojiOverlayProps {
  bubbles: FloatingBubble[];
  onRemove: (id: string) => void;
  onTap: (emoji: string) => void;
}

export default function EmojiOverlay({ bubbles, onRemove, onTap }: EmojiOverlayProps) {
  return (
    <>
      {/* Transparent overlay for floating reactions, sits above the video */}
      <div className="pointer-events-none absolute inset-x-0 bottom-0 h-full overflow-hidden">
        {bubbles.map((b) => (
          <span
            key={b.id}
            onAnimationEnd={() => onRemove(b.id)}
            className="absolute bottom-16 flex animate-floatUp items-end gap-0.5 text-4xl drop-shadow-lg"
            style={{ left: `${b.left}%` }}
          >
            {b.emoji}
            {b.count && b.count > 1 && (
              <span className="mb-1 rounded-full bg-black/60 px-1.5 py-0.5 text-xs font-bold text-reel-text">
                ×{b.count}
              </span>
            )}
          </span>
        ))}
      </div>

      {/* Quick-tap reaction bar */}
      <div className="mt-3 flex justify-center gap-2">
        {QUICK_EMOJIS.map((emoji) => (
          <button
            key={emoji}
            onClick={() => onTap(emoji)}
            className="rounded-full border border-reel-border bg-reel-surface px-3 py-2 text-xl transition hover:scale-110 hover:border-reel-amber active:scale-95"
            aria-label={`React with ${emoji}`}
          >
            {emoji}
          </button>
        ))}
      </div>
    </>
  );
}
