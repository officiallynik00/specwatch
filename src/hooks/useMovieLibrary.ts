import { useCallback, useEffect, useRef, useState } from "react";
import { supabase } from "@/lib/supabase/client";
import type { Movie, Subtitle } from "@/lib/types";

const MAX_BYTES = 5 * 1024 * 1024 * 1024; // 5GB — well under B2's 10GB free-tier storage cap
// If no new progress event arrives within this window, treat the current
// request as stalled rather than waiting forever. For movie uploads this
// only costs re-doing one PART_SIZE chunk, not the whole file — see the
// multipart section below.
const STALL_TIMEOUT_MS = 25_000;
// Chunk size for resumable movie uploads. Must be >=5MB per S3/B2's
// multipart spec for every part except the last. 10MB keeps a stall's
// cost small while keeping the part count (and therefore request count)
// reasonable even at the 5GB cap (~500 parts).
const PART_SIZE = 10 * 1024 * 1024;
// Single slot is enough — the UI only allows one upload in flight at a
// time (the file input is disabled while uploading is true), so there's
// never more than one real in-progress session to remember.
const SESSION_KEY = "specwatch:movie-upload-session";

interface UploadSession {
  fingerprint: string; // name::size::lastModified — "is this the same file" check
  movieId: string;
  path: string;
  uploadId: string;
  roomCode: string;
  totalParts: number;
}

function fileFingerprint(file: File): string {
  return `${file.name}::${file.size}::${file.lastModified}`;
}

function loadSession(): UploadSession | null {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    return raw ? (JSON.parse(raw) as UploadSession) : null;
  } catch {
    return null;
  }
}
function saveSession(session: UploadSession) {
  try {
    localStorage.setItem(SESSION_KEY, JSON.stringify(session));
  } catch {
    // Storage full/unavailable (private browsing, quota, etc.) — the
    // current upload still proceeds normally, it just won't be
    // resumable later. Not fatal.
  }
}
function clearSession() {
  try {
    localStorage.removeItem(SESSION_KEY);
  } catch {
    // Nothing to do if this fails — worst case a stale session lingers
    // and gets discarded next time its fingerprint doesn't match.
  }
}

/**
 * Uploads a single blob (a whole file, or one part of a multipart movie
 * upload) via XHR, purely for real `xhr.upload.onprogress` events and a
 * stall watchdog — `fetch` doesn't expose upload progress at all, and
 * neither fetch nor a bare XHR times out on a connection that goes
 * silent without closing (mobile network switches, a backgrounded tab).
 * Returns the response's ETag header when present, since B2's multipart
 * UploadPart response needs to be threaded back into CompleteMultipart.
 */
function uploadBlobWithProgress(
  url: string,
  blob: Blob,
  contentType: string | undefined,
  onProgressDelta: (deltaBytes: number) => void,
  xhrRef: { current: XMLHttpRequest | null }
): Promise<{ etag?: string; error?: string; cancelled?: boolean }> {
  return new Promise((resolve) => {
    const xhr = new XMLHttpRequest();
    xhrRef.current = xhr;
    xhr.open("PUT", url, true);
    if (contentType) xhr.setRequestHeader("Content-Type", contentType);

    let stallTimer: ReturnType<typeof setTimeout> | null = null;
    let settled = false;
    let lastLoaded = 0;

    const finish = (result: { etag?: string; error?: string; cancelled?: boolean }) => {
      if (settled) return;
      settled = true;
      if (stallTimer) clearTimeout(stallTimer);
      xhrRef.current = null;
      resolve(result);
    };
    const resetStallTimer = () => {
      if (stallTimer) clearTimeout(stallTimer);
      stallTimer = setTimeout(() => {
        xhr.abort();
        finish({ error: "Stalled — no progress for a while. Check your connection." });
      }, STALL_TIMEOUT_MS);
    };
    resetStallTimer();

    xhr.upload.onprogress = (e) => {
      resetStallTimer();
      const delta = e.loaded - lastLoaded;
      lastLoaded = e.loaded;
      if (delta > 0) onProgressDelta(delta);
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        // ETag is only meaningful for multipart part uploads — a plain
        // single-PUT caller (subtitles) just ignores it.
        const etag = xhr.getResponseHeader("ETag") || xhr.getResponseHeader("etag") || undefined;
        finish({ etag });
      } else {
        finish({ error: `Upload failed (status ${xhr.status})` });
      }
    };
    xhr.onerror = () => finish({ error: "Network error during upload." });
    xhr.onabort = () => finish({ cancelled: true });
    xhr.send(blob);
  });
}

interface UseMovieLibraryOptions {
  roomId: string | null;
  roomCode: string;
}

/**
 * Owns the global movie library: every file ever uploaded, from any room,
 * by anyone — not scoped to whichever room happens to be open right now.
 * A room's *currently playing* movie (room.movie_path on the `rooms` row —
 * see useRoomSync) is a separate, per-room pointer into this shared shelf.
 * File bytes live in B2 (see /api/r2-multipart-*, /api/r2-play-url,
 * /api/r2-delete); metadata lives in the `movies` table with realtime
 * INSERT/DELETE so every room sees the same shelf update instantly.
 *
 * Movie uploads are resumable: the file is sent in PART_SIZE chunks via
 * B2's multipart upload API. Re-selecting the same file (same name, size,
 * and last-modified time) after a stall, a tab close, or hitting Cancel
 * picks up from whichever parts B2 confirms it already has — not from
 * whatever a stale localStorage record claims, which is the actual
 * source of truth check in /api/r2-multipart-list-parts.
 */
export function useMovieLibrary({ roomId, roomCode }: UseMovieLibraryOptions) {
  const [movies, setMovies] = useState<Movie[]>([]);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [progress, setProgress] = useState(0);
  const [resuming, setResuming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const activeXhrRef = useRef<XMLHttpRequest | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      const { data } = await supabase
        .from("movies")
        .select("*")
        .order("uploaded_at", { ascending: false });
      if (!cancelled && data) setMovies(data as Movie[]);
      setLoading(false);
    }
    load();

    const sub = supabase
      .channel("movies-global")
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "movies" },
        (payload) => {
          setMovies((prev) => {
            const incoming = payload.new as Movie;
            if (prev.some((m) => m.id === incoming.id)) return prev;
            return [incoming, ...prev];
          });
        }
      )
      .on(
        "postgres_changes",
        { event: "DELETE", schema: "public", table: "movies" },
        (payload) => {
          const removedId = (payload.old as Partial<Movie>).id;
          setMovies((prev) => prev.filter((m) => m.id !== removedId));
        }
      )
      .subscribe();

    return () => {
      cancelled = true;
      supabase.removeChannel(sub);
    };
  }, []);

  const addMovie = useCallback(
    async (file: File) => {
      setError(null);
      if (file.size > MAX_BYTES) {
        setError(
          `That file is ${(file.size / 1024 / 1024 / 1024).toFixed(2)}GB — over the ${(
            MAX_BYTES /
            1024 /
            1024 /
            1024
          ).toFixed(0)}GB limit. Compress it first.`
        );
        return;
      }

      setUploading(true);
      setProgress(0);
      setResuming(false);

      const fingerprint = fileFingerprint(file);
      const contentType = file.type || "application/octet-stream";
      let session = loadSession();
      // A stale session for a *different* file than the one just picked
      // is simply not reachable through this UI anymore — drop it
      // locally rather than trying to resume the wrong upload. (Its
      // held parts on B2 are cheap and not visible to anyone; not worth
      // an extra network round trip to abort them here.)
      if (session && session.fingerprint !== fingerprint) session = null;

      let alreadyUploaded: { PartNumber: number; ETag: string; Size: number }[] = [];

      if (session) {
        try {
          const res = await fetch("/api/r2-multipart-list-parts", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ path: session.path, uploadId: session.uploadId }),
          });
          if (res.ok) {
            const data = await res.json();
            alreadyUploaded = data.parts ?? [];
          } else {
            // uploadId is gone (expired, already completed elsewhere,
            // or never existed) — can't resume it, fall through to a
            // fresh session below.
            session = null;
          }
        } catch {
          session = null;
        }
      }

      const totalParts = Math.max(1, Math.ceil(file.size / PART_SIZE));
      const movieId = session?.movieId ?? crypto.randomUUID();
      const ext = file.name.split(".").pop() || "mp4";
      const path = session?.path ?? `${roomCode}/${movieId}.${ext}`;

      let uploadId = session?.uploadId ?? null;
      if (!uploadId) {
        try {
          const res = await fetch("/api/r2-multipart-init", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ path, contentType }),
          });
          const data = await res.json();
          if (!res.ok || !data.uploadId) {
            setError(`Couldn't start the upload: ${data.error || "unknown error"}`);
            setUploading(false);
            return;
          }
          uploadId = data.uploadId;
        } catch {
          setError("Couldn't reach the server to start the upload.");
          setUploading(false);
          return;
        }
      }

      if (!uploadId) {
        // Unreachable in practice — the block above always either sets
        // uploadId or returns early — but keeps TypeScript's narrowing
        // happy without an assertion.
        setError("Couldn't determine an upload session. Try again.");
        setUploading(false);
        return;
      }

      saveSession({ fingerprint, movieId, path, uploadId, roomCode, totalParts });

      const finishedParts = new Map<number, { PartNumber: number; ETag: string }>();
      let doneBytes = 0;
      for (const p of alreadyUploaded) {
        finishedParts.set(p.PartNumber, { PartNumber: p.PartNumber, ETag: p.ETag });
        doneBytes += p.Size;
      }
      if (finishedParts.size > 0) {
        setResuming(true);
        setProgress(Math.min(99, Math.round((doneBytes / file.size) * 100)));
      }

      for (let partNumber = 1; partNumber <= totalParts; partNumber++) {
        if (finishedParts.has(partNumber)) continue;

        const start = (partNumber - 1) * PART_SIZE;
        const end = Math.min(start + PART_SIZE, file.size);
        const blob = file.slice(start, end);

        let partUrl: string;
        try {
          const res = await fetch("/api/r2-multipart-part-url", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ path, uploadId, partNumber }),
          });
          const data = await res.json();
          if (!res.ok || !data.url) {
            setError(
              `Couldn't get an upload slot for part ${partNumber}/${totalParts}: ${data.error || "unknown error"}. ` +
                "Re-select the same file to resume from here."
            );
            setUploading(false);
            return;
          }
          partUrl = data.url;
        } catch {
          setError("Couldn't reach the server. Re-select the same file to resume from here.");
          setUploading(false);
          return;
        }

        const result = await uploadBlobWithProgress(
          partUrl,
          blob,
          undefined,
          (deltaBytes) => {
            doneBytes += deltaBytes;
            setProgress(Math.min(99, Math.round((doneBytes / file.size) * 100)));
          },
          activeXhrRef
        );

        if (result.cancelled) {
          // Deliberate pause, not a failure — the session stays saved so
          // re-selecting the same file continues from here.
          setError("Upload paused. Re-select the same file to continue.");
          setUploading(false);
          return;
        }
        if (result.error || !result.etag) {
          setError(
            `Upload failed on part ${partNumber}/${totalParts}: ${result.error ?? "no ETag returned"}. ` +
              "Re-select the same file to resume from here."
          );
          setUploading(false);
          return;
        }
        finishedParts.set(partNumber, { PartNumber: partNumber, ETag: result.etag });
      }

      try {
        const res = await fetch("/api/r2-multipart-complete", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ path, uploadId, parts: Array.from(finishedParts.values()) }),
        });
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          setError(`Couldn't finalize the upload: ${data.error || "unknown error"}. Re-select the same file to retry.`);
          setUploading(false);
          return;
        }
      } catch {
        setError("Couldn't reach the server to finalize the upload. Re-select the same file to retry.");
        setUploading(false);
        return;
      }

      clearSession();
      setProgress(100);
      setResuming(false);

      const title = file.name.replace(/\.[^/.]+$/, "");
      // room_id is kept only as a breadcrumb of which room the upload
      // happened in — it's nullable now and never used to filter the
      // library, which is intentionally global.
      const { data, error: insertError } = await supabase
        .from("movies")
        .insert({
          id: movieId,
          room_id: roomId,
          storage_path: path,
          title,
          file_size_bytes: file.size,
        })
        .select()
        .single();

      setUploading(false);
      if (insertError) {
        setError(`Saved the file but couldn't add it to the library: ${insertError.message}`);
        return;
      }
      // Realtime INSERT will usually add this too, but insert it locally
      // right away so the uploader sees it instantly instead of waiting
      // on the round trip.
      if (data) {
        const inserted = data as Movie;
        setMovies((prev) => (prev.some((m) => m.id === inserted.id) ? prev : [inserted, ...prev]));
      }
    },
    [roomId, roomCode]
  );

  const cancelUpload = useCallback(() => {
    activeXhrRef.current?.abort();
    // xhr.onabort (in uploadBlobWithProgress) resolves with `cancelled`,
    // which addMovie's loop turns into a "paused, re-select to resume"
    // message — the multipart session is deliberately NOT cleared here,
    // that's the whole point of "cancel" meaning "pause" for a movie
    // upload rather than "discard".
  }, []);

  // If the person leaves the room (or the room screen unmounts for any
  // other reason) mid-upload, don't leave the XHR running unattended in
  // the background — abort it along with the component. The session
  // stays saved, same as a manual cancel.
  useEffect(() => {
    return () => {
      activeXhrRef.current?.abort();
    };
  }, []);

  const removeMovie = useCallback(async (movie: Movie) => {
    setError(null);
    // Optimistic removal — the storage/db calls happen after.
    setMovies((prev) => prev.filter((m) => m.id !== movie.id));

    try {
      const res = await fetch("/api/r2-delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: movie.storage_path }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(`Couldn't remove the file from storage: ${data.error || "unknown error"}`);
      }
    } catch {
      setError("Couldn't reach the server to remove the file from storage.");
    }

    const { error: deleteError } = await supabase.from("movies").delete().eq("id", movie.id);
    if (deleteError) {
      setError(`Couldn't remove "${movie.title}" from the library: ${deleteError.message}`);
      return;
    }

    // Any room that currently has this movie loaded as "now playing"
    // should clear its pointer — not just the room it was uploaded in,
    // since the library (and therefore playback) is global now.
    await supabase
      .from("rooms")
      .update({ movie_path: null, movie_title: null, movie_uploaded_at: null })
      .eq("movie_path", movie.storage_path);
  }, []);

  const addSubtitle = useCallback(async (movie: Movie, file: File) => {
    setError(null);
    const ext = file.name.split(".").pop()?.toLowerCase();
    if (ext !== "vtt" && ext !== "srt") {
      setError("Subtitles must be a .vtt or .srt file.");
      return;
    }

    const subId = crypto.randomUUID();
    const path = `${movie.storage_path.split("/")[0]}/${movie.id}/subs/${subId}.${ext}`;

    let signedUrl: string;
    try {
      const res = await fetch("/api/r2-upload-url", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path, contentType: "text/plain" }),
      });
      const data = await res.json();
      if (!res.ok || !data.url) {
        setError(`Couldn't start the subtitle upload: ${data.error || "unknown error"}`);
        return;
      }
      signedUrl = data.url;
    } catch {
      setError("Couldn't reach the server to start the subtitle upload.");
      return;
    }

    // Subtitle files are tiny (KB, not GB) — no need for the multipart/
    // resumable machinery movies use above, a plain single PUT is fine.
    const result = await uploadBlobWithProgress(signedUrl, file, "text/plain", () => {}, { current: null });
    if (result.error || result.cancelled) {
      setError(`Subtitle upload failed: ${result.error ?? "cancelled"}`);
      return;
    }

    const label = file.name.replace(/\.[^/.]+$/, "");
    const newSubtitle: Subtitle = { id: subId, storage_path: path, label };
    const subtitles = [...(movie.subtitles ?? []), newSubtitle];

    const { error: updateError } = await supabase
      .from("movies")
      .update({ subtitles })
      .eq("id", movie.id);

    if (updateError) {
      setError(`Uploaded the file but couldn't attach it: ${updateError.message}`);
      return;
    }
    setMovies((prev) => prev.map((m) => (m.id === movie.id ? { ...m, subtitles } : m)));
  }, []);

  const removeSubtitle = useCallback(async (movie: Movie, subtitleId: string) => {
    setError(null);
    const target = movie.subtitles?.find((s) => s.id === subtitleId);
    const subtitles = (movie.subtitles ?? []).filter((s) => s.id !== subtitleId);

    // Optimistic — update local state first.
    setMovies((prev) => prev.map((m) => (m.id === movie.id ? { ...m, subtitles } : m)));

    const { error: updateError } = await supabase
      .from("movies")
      .update({ subtitles })
      .eq("id", movie.id);
    if (updateError) {
      setError(`Couldn't remove the subtitle: ${updateError.message}`);
      return;
    }

    if (target) {
      try {
        await fetch("/api/r2-delete", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ path: target.storage_path }),
        });
      } catch {
        // Non-fatal — the DB reference is already gone, an orphaned
        // object in B2 isn't visible to anyone.
      }
    }
  }, []);

  return {
    movies,
    loading,
    uploading,
    progress,
    resuming,
    error,
    addMovie,
    cancelUpload,
    removeMovie,
    addSubtitle,
    removeSubtitle,
  };
}

export default useMovieLibrary;
