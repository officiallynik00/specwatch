"use client";

import { useState } from "react";
import { supabase } from "@/lib/supabase/client";

const MOVIE_BUCKET = process.env.NEXT_PUBLIC_MOVIE_BUCKET || "movies";
const MAX_BYTES = 1024 * 1024 * 1024; // 1GB, matches the Supabase free-tier ceiling in the spec

interface MovieUploaderProps {
  roomId: string;
  roomCode: string;
  onUploaded: () => void;
}

export default function MovieUploader({ roomId, roomCode, onUploaded }: MovieUploaderProps) {
  const [uploading, setUploading] = useState(false);
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
    setFileName(file.name);

    const ext = file.name.split(".").pop() || "mp4";
    const path = `${roomCode}/movie.${ext}`;

    const { error: uploadError } = await supabase.storage
      .from(MOVIE_BUCKET)
      .upload(path, file, { upsert: true, cacheControl: "3600" });

    if (uploadError) {
      setError(`Upload failed: ${uploadError.message}`);
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
        {uploading ? "Uploading…" : "Choose file"}
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

      {fileName && !error && (
        <p className="mt-3 text-xs text-reel-muted">
          {uploading ? "Uploading" : "Uploaded"} <span className="text-reel-text">{fileName}</span>
        </p>
      )}
      {error && <p className="mt-3 text-sm text-reel-rose">{error}</p>}
    </div>
  );
}
