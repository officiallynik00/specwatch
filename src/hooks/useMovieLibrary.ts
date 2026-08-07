import { useCallback, useEffect, useState } from "react";
import { supabase } from "@/lib/supabase/client";
import type { Movie, Subtitle } from "@/lib/types";

const MAX_BYTES = 5 * 1024 * 1024 * 1024; // 5GB — well under B2's 10GB free-tier storage cap

/**
 * Uploads to B2 via a presigned PUT URL obtained from our own /api/r2-upload-url
 * route. We use XMLHttpRequest instead of fetch purely to get real
 * `xhr.upload.onprogress` events for a percentage bar.
 */
function uploadWithProgress(
  url: string,
  file: File,
  onProgress: (pct: number) => void
): Promise<{ error?: string }> {
  return new Promise((resolve) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", url, true);
    xhr.setRequestHeader("Content-Type", file.type || "application/octet-stream");

    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 100));
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) resolve({});
      else resolve({ error: `Upload failed (status ${xhr.status})` });
    };
    xhr.onerror = () => resolve({ error: "Network error during upload." });
    xhr.send(file);
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
 * File bytes live in B2 (see /api/r2-upload-url, /api/r2-play-url,
 * /api/r2-delete); metadata lives in the `movies` table with realtime
 * INSERT/DELETE so every room sees the same shelf update instantly.
 */
export function useMovieLibrary({ roomId, roomCode }: UseMovieLibraryOptions) {
  const [movies, setMovies] = useState<Movie[]>([]);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);

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

      // Unique path per movie (not a fixed "movie.ext") since the
      // library can hold more than one file, from any room.
      const movieId = crypto.randomUUID();
      const ext = file.name.split(".").pop() || "mp4";
      const path = `${roomCode}/${movieId}.${ext}`;

      // Ask our server for a presigned PUT URL, then upload straight to
      // B2 with it — the file never passes through our own server.
      let signedUrl: string;
      try {
        const res = await fetch("/api/r2-upload-url", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ path, contentType: file.type || "application/octet-stream" }),
        });
        const data = await res.json();
        if (!res.ok || !data.url) {
          setError(`Couldn't start the upload: ${data.error || "unknown error"}`);
          setUploading(false);
          return;
        }
        signedUrl = data.url;
      } catch {
        setError("Couldn't reach the server to start the upload.");
        setUploading(false);
        return;
      }

      const { error: uploadError } = await uploadWithProgress(signedUrl, file, setProgress);
      if (uploadError) {
        setError(`Upload failed: ${uploadError}`);
        setUploading(false);
        return;
      }

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

    const { error: uploadError } = await uploadWithProgress(signedUrl, file, () => {});
    if (uploadError) {
      setError(`Subtitle upload failed: ${uploadError}`);
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
    error,
    addMovie,
    removeMovie,
    addSubtitle,
    removeSubtitle,
  };
}

export default useMovieLibrary;
