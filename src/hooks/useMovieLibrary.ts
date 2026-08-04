import { useCallback, useEffect, useState } from "react";
import { supabase } from "@/lib/supabase/client";
import type { Movie } from "@/lib/types";

const MOVIE_BUCKET = process.env.NEXT_PUBLIC_MOVIE_BUCKET || "movies";
const MAX_BYTES = 1024 * 1024 * 1024; // 1GB, matches the Supabase free-tier ceiling
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || "";
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "";

/**
 * Uploads directly to Supabase Storage's REST endpoint via XMLHttpRequest
 * instead of supabase-js's `upload()` helper, purely to get real
 * `xhr.upload.onprogress` events for a percentage bar — the JS client's
 * fetch-based upload doesn't expose upload progress.
 */
function uploadWithProgress(
  path: string,
  file: File,
  onProgress: (pct: number) => void
): Promise<{ error?: string }> {
  return new Promise((resolve) => {
    if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
      resolve({ error: "Supabase isn't configured — check your .env.local." });
      return;
    }
    const encodedPath = path.split("/").map(encodeURIComponent).join("/");
    const url = `${SUPABASE_URL}/storage/v1/object/${MOVIE_BUCKET}/${encodedPath}`;

    const xhr = new XMLHttpRequest();
    xhr.open("POST", url, true);
    xhr.setRequestHeader("Authorization", `Bearer ${SUPABASE_ANON_KEY}`);
    xhr.setRequestHeader("apikey", SUPABASE_ANON_KEY);
    xhr.setRequestHeader("x-upsert", "true");
    xhr.setRequestHeader("cache-control", "3600");
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
 * Owns a room's persistent movie library: every file ever uploaded to
 * this room, independent of whichever one happens to be loaded into
 * the shared player right now (that pointer lives on the `rooms` row
 * itself — see useRoomSync). Backed by the `movies` table plus the
 * shared `movies` storage bucket, with realtime INSERT/DELETE so both
 * partners always see the same shelf.
 */
export function useMovieLibrary({ roomId, roomCode }: UseMovieLibraryOptions) {
  const [movies, setMovies] = useState<Movie[]>([]);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!roomId) return;
    let cancelled = false;

    async function load() {
      const { data } = await supabase
        .from("movies")
        .select("*")
        .eq("room_id", roomId)
        .order("uploaded_at", { ascending: false });
      if (!cancelled && data) setMovies(data as Movie[]);
      setLoading(false);
    }
    load();

    const sub = supabase
      .channel(`movies-${roomId}`)
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "movies", filter: `room_id=eq.${roomId}` },
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
        { event: "DELETE", schema: "public", table: "movies", filter: `room_id=eq.${roomId}` },
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
  }, [roomId]);

  const addMovie = useCallback(
    async (file: File) => {
      setError(null);
      if (file.size > MAX_BYTES) {
        setError(
          `That file is ${(file.size / 1024 / 1024 / 1024).toFixed(2)}GB — over the 1GB free-tier ` +
            "limit. Compress to 480p first, or upgrade to Supabase Pro for more room."
        );
        return;
      }
      if (!roomId) return;

      setUploading(true);
      setProgress(0);

      // Unique path per movie (not a fixed "movie.ext") since the
      // library can hold more than one file per room.
      const movieId = crypto.randomUUID();
      const ext = file.name.split(".").pop() || "mp4";
      const path = `${roomCode}/${movieId}.${ext}`;

      const { error: uploadError } = await uploadWithProgress(path, file, setProgress);
      if (uploadError) {
        setError(`Upload failed: ${uploadError}`);
        setUploading(false);
        return;
      }

      const title = file.name.replace(/\.[^/.]+$/, "");
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

  const removeMovie = useCallback(
    async (movie: Movie) => {
      setError(null);
      // Optimistic removal — the storage/db calls happen after.
      setMovies((prev) => prev.filter((m) => m.id !== movie.id));

      const { error: storageError } = await supabase.storage.from(MOVIE_BUCKET).remove([movie.storage_path]);
      if (storageError) {
        setError(`Couldn't remove the file from storage: ${storageError.message}`);
      }

      const { error: deleteError } = await supabase.from("movies").delete().eq("id", movie.id);
      if (deleteError) {
        setError(`Couldn't remove "${movie.title}" from the library: ${deleteError.message}`);
        return;
      }

      // If this was the room's currently-loaded movie, clear the pointer
      // so a partner still on the lobby (or mid-heartbeat) doesn't try to
      // play a file that no longer exists.
      if (roomId) {
        await supabase
          .from("rooms")
          .update({ movie_path: null, movie_title: null, movie_uploaded_at: null })
          .eq("id", roomId)
          .eq("movie_path", movie.storage_path);
      }
    },
    [roomId]
  );

  return { movies, loading, uploading, progress, error, addMovie, removeMovie };
}

export default useMovieLibrary;
