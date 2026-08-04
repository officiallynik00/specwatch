"use client";

import { useState } from "react";
import type { Movie } from "@/lib/types";

interface MovieLibraryProps {
  movies: Movie[];
  loading: boolean;
  uploading: boolean;
  progress: number;
  error: string | null;
  currentMoviePath: string | null;
  onAdd: (file: File) => void;
  onRemove: (movie: Movie) => void;
  onPlay: (movie: Movie) => void;
}

function formatBytes(bytes: number | null): string {
  if (!bytes) return "";
  const gb = bytes / 1024 / 1024 / 1024;
  if (gb >= 1) return `${gb.toFixed(2)} GB`;
  return `${Math.round(bytes / 1024 / 1024)} MB`;
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export default function MovieLibrary({
  movies,
  loading,
  uploading,
  progress,
  error,
  currentMoviePath,
  onAdd,
  onRemove,
  onPlay,
}: MovieLibraryProps) {
  // Two-tap remove ("Remove" -> "Confirm?") instead of a browser confirm()
  // dialog, so it stays consistent with the app's own visual language.
  const [confirmingId, setConfirmingId] = useState<string | null>(null);

  function handleRemoveClick(movie: Movie) {
    if (confirmingId === movie.id) {
      setConfirmingId(null);
      onRemove(movie);
    } else {
      setConfirmingId(movie.id);
    }
  }

  return (
    <div className="w-full text-left">
      <div className="mb-3 flex items-center justify-between">
        <p className="font-display text-lg italic text-reel-text">Library</p>
        <label className="cursor-pointer rounded-full border border-reel-border px-3 py-1.5 text-xs text-reel-muted transition hover:border-reel-amber hover:text-reel-amber">
          {uploading ? `Uploading… ${progress}%` : "+ Add movie"}
          <input
            type="file"
            accept="video/mp4,video/*"
            className="hidden"
            disabled={uploading}
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) onAdd(file);
              e.target.value = "";
            }}
          />
        </label>
      </div>

      {uploading && (
        <div className="mb-4 h-1.5 w-full overflow-hidden rounded-full bg-reel-border">
          <div
            className="h-full rounded-full bg-reel-amber transition-[width] duration-200"
            style={{ width: `${progress}%` }}
          />
        </div>
      )}

      {error && <p className="mb-4 text-sm text-reel-rose">{error}</p>}

      {loading ? (
        <p className="py-8 text-center text-sm text-reel-muted">Loading library…</p>
      ) : movies.length === 0 ? (
        <div className="rounded-xl border border-dashed border-reel-border bg-reel-surface p-6 text-center">
          <p className="mb-1 text-sm text-reel-text">No movies yet</p>
          <p className="text-xs text-reel-muted">
            MP4, H.264, 480p recommended · under 1GB on the free tier
          </p>
        </div>
      ) : (
        <ul className="space-y-2">
          {movies.map((movie) => {
            const isCurrent = movie.storage_path === currentMoviePath;
            const confirming = confirmingId === movie.id;
            return (
              <li
                key={movie.id}
                className={`flex items-center gap-3 rounded-xl border px-4 py-3 transition ${
                  isCurrent ? "border-reel-amber bg-reel-surface2" : "border-reel-border bg-reel-surface"
                }`}
              >
                <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-reel-bg text-lg">
                  🎬
                </div>
                <div className="min-w-0 flex-1">
                  <p className="truncate font-display text-sm italic text-reel-text">{movie.title}</p>
                  <p className="truncate text-[11px] text-reel-muted">
                    {formatDate(movie.uploaded_at)}
                    {movie.file_size_bytes ? ` · ${formatBytes(movie.file_size_bytes)}` : ""}
                    {isCurrent ? " · Now loaded" : ""}
                  </p>
                </div>
                <button
                  onClick={() => onPlay(movie)}
                  className="shrink-0 rounded-full bg-reel-amber px-4 py-1.5 text-xs font-medium text-reel-bg transition hover:bg-reel-amberDim"
                >
                  Play
                </button>
                <button
                  onClick={() => handleRemoveClick(movie)}
                  onBlur={() => setConfirmingId(null)}
                  className={`shrink-0 rounded-full border px-3 py-1.5 text-xs transition ${
                    confirming
                      ? "border-reel-rose text-reel-rose"
                      : "border-reel-border text-reel-muted hover:border-reel-rose hover:text-reel-rose"
                  }`}
                >
                  {confirming ? "Confirm?" : "Remove"}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
