"use client";

import { useState } from "react";
import { extractYouTubeId } from "@/lib/youtube";

interface YouTubePreview {
  videoId: string;
  title: string;
  thumbnailUrl: string;
  authorName: string;
}

interface YouTubeLinkInputProps {
  currentVideoId: string | null;
  onPlay: (preview: YouTubePreview) => void;
}

/**
 * Paste-a-link → preview → confirm. Deliberately the lighter of the two
 * "browsing" options: no search API, no Google Cloud key, no quota to
 * manage. The person finds the video wherever they normally would
 * (YouTube itself), and this just confirms it's the right one before
 * committing the room to it — via YouTube's public oEmbed endpoint,
 * which needs no credentials at all.
 */
export default function YouTubeLinkInput({ currentVideoId, onPlay }: YouTubeLinkInputProps) {
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<YouTubePreview | null>(null);
  const [entering, setEntering] = useState(false);

  async function handleLookup(e: React.FormEvent) {
    e.preventDefault();
    if (!input.trim() || loading) return;

    if (!extractYouTubeId(input)) {
      setError("That doesn't look like a YouTube link.");
      setPreview(null);
      return;
    }

    setLoading(true);
    setError(null);
    setPreview(null);
    try {
      const res = await fetch("/api/youtube-oembed", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: input }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "Couldn't load that video.");
      } else {
        setPreview(data as YouTubePreview);
      }
    } catch {
      setError("Couldn't reach YouTube — try again.");
    } finally {
      setLoading(false);
    }
  }

  function confirmPlay() {
    if (!preview || entering) return;
    setEntering(true);
    onPlay(preview);
  }

  return (
    <div className="w-full text-left">
      <p className="mb-3 font-display text-lg italic text-reel-text">Paste a YouTube link</p>

      <form onSubmit={handleLookup} className="mb-3 flex gap-2">
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="https://youtube.com/watch?v=…"
          className="min-w-0 flex-1 rounded-lg border border-reel-border bg-reel-bg px-3 py-2.5 text-sm text-reel-text placeholder:text-reel-muted/50 focus:border-reel-amber focus:outline-none"
        />
        <button
          type="submit"
          disabled={loading || !input.trim()}
          className="shrink-0 rounded-lg border border-reel-border px-4 py-2.5 text-sm text-reel-muted transition hover:border-reel-amber hover:text-reel-amber disabled:cursor-not-allowed disabled:opacity-40"
        >
          {loading ? "Looking up…" : "Find it"}
        </button>
      </form>

      {error && <p className="mb-3 text-sm text-reel-rose">{error}</p>}

      {preview && (
        <div
          className={`flex items-center gap-3 rounded-xl border p-3 transition ${
            preview.videoId === currentVideoId
              ? "border-reel-amber bg-reel-surface2"
              : "border-reel-border bg-reel-surface"
          }`}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={preview.thumbnailUrl}
            alt=""
            className="h-14 w-24 shrink-0 rounded-lg object-cover"
          />
          <div className="min-w-0 flex-1">
            <p className="truncate font-display text-sm italic text-reel-text">{preview.title}</p>
            <p className="truncate text-[11px] text-reel-muted">{preview.authorName}</p>
          </div>
          <button
            onClick={confirmPlay}
            disabled={entering}
            className="shrink-0 rounded-full bg-reel-amber px-4 py-1.5 text-xs font-medium text-reel-bg transition hover:bg-reel-amberDim disabled:cursor-wait disabled:opacity-60"
          >
            {entering ? "Loading…" : "Use this video"}
          </button>
        </div>
      )}

      {!preview && !error && (
        <p className="text-[11px] text-reel-muted">
          Occasionally a video's owner disables embedding — if a link doesn't work, it's
          almost always that, not a problem on your end.
        </p>
      )}
    </div>
  );
}
