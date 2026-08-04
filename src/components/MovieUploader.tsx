"use client";

import { useState } from "react";
import { supabase } from "@/lib/supabase/client";

const MOVIE_BUCKET = process.env.NEXT_PUBLIC_MOVIE_BUCKET || "movies";
const MAX_BYTES = 1024 * 1024 * 1024; // 1GB, matches the Supabase free-tier ceiling in the spec
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || "";
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "";

interface MovieUploaderProps {
  roomId: string;
  roomCode: string;
  onUploaded: () => void;
}

/**
 * Uploads directly to Supabase Storage's REST endpoint via XMLHttpRequest
 * instead of supabase-js's `upload()` helper, purely to get real
 * `xhr.upload.onprogress` events for a percentage bar — the JS client's
 * fetch-based upload doesn't expose upload progress. This mirrors what the
 * client does under the hood (POST with an upsert header). If your project
 * has non-default storage policies, this is the one spot to double check
 * against the network tab if uploads start failing here.
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

export default function MovieUploader({ roomId, roomCode, onUploaded }: MovieUploaderProps) {
  const [uploading, setUploading] = useState(false);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);

  async function handleFile(file: File) {
    setError(null);
    if (file.size > MAX_BYTES) {
      setError(
        `That file is ${(file.size / 1024 / 1024 / 1024).toFixed(2)}GB — over the 1GB free-tier ` +
          "limit. Compress to 480p first, or upgrade to Supabase Pro for more room."
      );
      return;
    }

    setUploading(true);
    setProgress(0);
    setFileName(file.name);

    const ext = file.name.split(".").pop() || "mp4";
    const path = `${roomCode}/movie.${ext}`;

    const { error: uploadError } = await uploadWithProgress(path, file, setProgress);

    if (uploadError) {
      setError(`Upload failed: ${uploadError}`);
      setUploading(false);
      return;
    }

    const { error: updateError } = await supabase
      .from("rooms")
      .update({
        movie_path: path,
        movie_title: file.name.replace(/\.[^/.]+$/, ""),
        movie_uploaded_at: new Date().toISOString(),
      })
      .eq("id", roomId);

    setUploading(false);
    if (updateError) {
      setError(`Saved the file but couldn't update the room: ${updateError.message}`);
      return;
    }
    onUploaded();
  }

  return (
    <div className="rounded-xl border border-dashed border-reel-border bg-reel-surface p-6 text-center">
      <p className="mb-1 font-display text-lg italic text-reel-text">Load tonight's movie</p>
      <p className="mb-4 text-xs text-reel-muted">
        MP4, H.264, 480p recommended · under 1GB on the free tier
      </p>

      <label className="inline-block cursor-pointer rounded-full bg-reel-amber px-5 py-2.5 text-sm font-medium text-reel-bg transition hover:bg-reel-amberDim">
        {uploading ? `Uploading… ${progress}%` : "Choose file"}
        <input
          type="file"
          accept="video/mp4,video/*"
          className="hidden"
          disabled={uploading}
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) handleFile(file);
          }}
        />
      </label>

      {uploading && (
        <div className="mx-auto mt-4 h-1.5 w-full max-w-xs overflow-hidden rounded-full bg-reel-border">
          <div
            className="h-full rounded-full bg-reel-amber transition-[width] duration-200"
            style={{ width: `${progress}%` }}
          />
        </div>
      )}

      {fileName && !error && !uploading && (
        <p className="mt-3 text-xs text-reel-muted">
          Uploaded <span className="text-reel-text">{fileName}</span>
        </p>
      )}
      {error && <p className="mt-3 text-sm text-reel-rose">{error}</p>}
    </div>
  );
}
