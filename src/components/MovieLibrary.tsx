"use client";

import { useState } from "react";
import type { Movie } from "@/lib/types";

interface MovieLibraryProps {
  movies: Movie[];
  loading: boolean;
  uploading: boolean;
  progress: number;
  resuming: boolean;
  etaSeconds: number | null;
  extracting: boolean;
  extractionStatus: string | null;
  error: string | null;
  currentMoviePath: string | null;
  onAdd: (file: File) => void;
  onCancelUpload: () => void;
  onRemove: (movie: Movie) => void;
  onPlay: (movie: Movie) => void;
  onAddSubtitle: (movie: Movie, file: File) => void;
  onRemoveSubtitle: (movie: Movie, subtitleId: string) => void;
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

// null while we don't have a reliable estimate yet (upload just started,
// or speed is effectively zero) — caller shows nothing in that case
// rather than a misleading "0s left" or "Infinity".
function formatEta(seconds: number | null): string | null {
  if (seconds == null || !Number.isFinite(seconds) || seconds <= 0) return null;
  if (seconds < 45) return "less than a minute left";
  const totalMinutes = Math.round(seconds / 60);
  if (totalMinutes < 60) return `~${totalMinutes} min left`;
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  return `~${h}h ${m}m left`;
}

export default function MovieLibrary({
  movies,
  loading,
  uploading,
  progress,
  resuming,
  etaSeconds,
  extracting,
  extractionStatus,
  error,
  currentMoviePath,
  onAdd,
  onCancelUpload,
  onRemove,
  onPlay,
  onAddSubtitle,
  onRemoveSubtitle,
}: MovieLibraryProps) {
  // Two-tap remove ("Remove" -> "Confirm?") instead of a browser confirm()
  // dialog, so it stays consistent with the app's own visual language.
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  // Which movie's subtitle list is expanded (only one at a time).
  const [expandedSubsId, setExpandedSubsId] = useState<string | null>(null);

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
          {uploading ? `${resuming ? "Resuming" : "Uploading"}… ${progress}%` : "+ Add movie"}
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
        <div className="mb-4 flex items-center gap-2">
          <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-reel-border">
            <div
              className="h-full rounded-full bg-reel-amber transition-[width] duration-200"
              style={{ width: `${progress}%` }}
            />
          </div>
          {formatEta(etaSeconds) && (
            <span className="shrink-0 text-[11px] text-reel-muted">{formatEta(etaSeconds)}</span>
          )}
          <button
            onClick={onCancelUpload}
            className="shrink-0 text-[11px] text-reel-muted underline decoration-dotted hover:text-reel-rose"
          >
            Cancel
          </button>
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
            const subsOpen = expandedSubsId === movie.id;
            const subtitleCount = movie.subtitles?.length ?? 0;
            return (
              <li
                key={movie.id}
                className={`rounded-xl border px-4 py-3 transition ${
                  isCurrent ? "border-reel-amber bg-reel-surface2" : "border-reel-border bg-reel-surface"
                }`}
              >
                <div className="flex items-center gap-3">
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
                    onClick={() => setExpandedSubsId(subsOpen ? null : movie.id)}
                    aria-expanded={subsOpen}
                    title="Subtitles"
                    className={`shrink-0 rounded-full border px-2.5 py-1.5 text-[11px] font-medium transition ${
                      subsOpen || subtitleCount > 0
                        ? "border-reel-amber text-reel-amber"
                        : "border-reel-border text-reel-muted hover:border-reel-amber hover:text-reel-amber"
                    }`}
                  >
                    CC{subtitleCount > 0 ? ` ${subtitleCount}` : ""}
                  </button>
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
                </div>

                {subsOpen && (
                  <div className="mt-3 border-t border-reel-border pt-3">
                    {subtitleCount === 0 ? (
                      <p className="mb-2 text-[11px] text-reel-muted">No subtitle files added yet.</p>
                    ) : (
                      <ul className="mb-2 space-y-1.5">
                        {movie.subtitles.map((sub) => (
                          <li
                            key={sub.id}
                            className="flex items-center justify-between gap-2 rounded-lg bg-reel-bg px-3 py-1.5"
                          >
                            <span className="truncate text-xs text-reel-text">{sub.label}</span>
                            <button
                              onClick={() => onRemoveSubtitle(movie, sub.id)}
                              className="shrink-0 text-[11px] text-reel-muted hover:text-reel-rose"
                            >
                              Remove
                            </button>
                          </li>
                        ))}
                      </ul>
                    )}
                    <label className="inline-block cursor-pointer rounded-full border border-dashed border-reel-border px-3 py-1.5 text-[11px] text-reel-muted transition hover:border-reel-amber hover:text-reel-amber">
                      + Add subtitle (.vtt / .srt)
                      <input
                        type="file"
                        accept=".vtt,.srt,text/vtt"
                        className="hidden"
                        onChange={(e) => {
                          const file = e.target.files?.[0];
                          if (file) onAddSubtitle(movie, file);
                          e.target.value = "";
                        }}
                      />
                    </label>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
