"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { supabase } from "@/lib/supabase/client";
import type { ConnectionStatus } from "@/hooks/useRoomSync";
import type { Room, SyncEvent } from "@/lib/types";

const SMALL_DRIFT_THRESHOLD = 0.5; // seconds — silently correct
const LARGE_DRIFT_THRESHOLD = 1.5; // seconds — hard resync + visible status

const MOVIE_BUCKET = process.env.NEXT_PUBLIC_MOVIE_BUCKET || "movies";

interface VideoPlayerProps {
  room: Room;
  myName: string;
  isController: boolean;
  connectionStatus: ConnectionStatus;
  partnerName: string | null;
  lastEvent: SyncEvent | null;
  heartbeatIntervalMs: number;
  broadcastPlay: (t: number) => void;
  broadcastPause: (t: number) => void;
  broadcastSeek: (t: number) => void;
  broadcastHeartbeat: (t: number, playing: boolean) => void;
  takeController: () => void;
  onEmoji: (emoji: string, by: string) => void;
}

function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  const mm = h > 0 ? String(m).padStart(2, "0") : String(m);
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

export default function VideoPlayer({
  room,
  myName,
  isController,
  connectionStatus,
  partnerName,
  lastEvent,
  heartbeatIntervalMs,
  broadcastPlay,
  broadcastPause,
  broadcastSeek,
  broadcastHeartbeat,
  takeController,
  onEmoji,
}: VideoPlayerProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [current, setCurrent] = useState(room.last_position_seconds);
  const [duration, setDuration] = useState(0);
  const [statusNote, setStatusNote] = useState<string | null>(null);
  const [resyncing, setResyncing] = useState(false);
  const wasBothConnectedRef = useRef(false);
  const initializedRef = useRef(false);
  const noteTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const movieUrl = room.movie_path
    ? supabase.storage.from(MOVIE_BUCKET).getPublicUrl(room.movie_path).data.publicUrl
    : null;

  const showNote = useCallback((text: string, ms = 2500) => {
    setStatusNote(text);
    if (noteTimeoutRef.current) clearTimeout(noteTimeoutRef.current);
    noteTimeoutRef.current = setTimeout(() => setStatusNote(null), ms);
  }, []);

  // ── Resume from last saved position once metadata is ready ──
  const handleLoadedMetadata = useCallback(() => {
    const video = videoRef.current;
    if (!video || initializedRef.current) return;
    initializedRef.current = true;
    video.currentTime = room.last_position_seconds || 0;
    setDuration(video.duration || 0);
  }, [room.last_position_seconds]);

  // ── Controller heartbeat loop ──
  useEffect(() => {
    if (!isController) return;
    const id = setInterval(() => {
      const video = videoRef.current;
      if (!video) return;
      broadcastHeartbeat(video.currentTime, !video.paused);
    }, heartbeatIntervalMs);
    return () => clearInterval(id);
  }, [isController, heartbeatIntervalMs, broadcastHeartbeat]);

  // ── React to incoming sync events (follower + controller notifications) ──
  useEffect(() => {
    if (!lastEvent || !videoRef.current) return;
    const video = videoRef.current;

    const compensate = (t: number, sentAt: number, assumePlaying: boolean) =>
      assumePlaying ? t + (Date.now() - sentAt) / 1000 : t;

    switch (lastEvent.type) {
      case "heartbeat": {
        if (isController) return; // controller is ground truth, ignore stray echoes
        const target = compensate(lastEvent.currentTime, lastEvent.serverSentAt, lastEvent.isPlaying);
        const gap = Math.abs(video.currentTime - target);
        if (lastEvent.isPlaying && video.paused) video.play().catch(() => {});
        if (!lastEvent.isPlaying && !video.paused) video.pause();
        if (gap >= LARGE_DRIFT_THRESHOLD) {
          setResyncing(true);
          video.currentTime = target;
          showNote("Resyncing…");
          setTimeout(() => setResyncing(false), 400);
        } else if (gap >= SMALL_DRIFT_THRESHOLD) {
          video.currentTime = target; // silent correction, no visible jump/status
        }
        break;
      }
      case "play": {
        if (isController) break;
        const target = compensate(lastEvent.currentTime, lastEvent.serverSentAt, true);
        video.currentTime = target;
        video.play().catch(() => {});
        break;
      }
      case "pause": {
        video.pause();
        video.currentTime = lastEvent.currentTime;
        if (lastEvent.by !== myName) showNote(`${lastEvent.by} paused`);
        break;
      }
      case "seek": {
        if (isController) break;
        const target = compensate(lastEvent.currentTime, lastEvent.serverSentAt, !video.paused);
        video.currentTime = target;
        break;
      }
      case "emoji": {
        onEmoji(lastEvent.emoji, lastEvent.by);
        break;
      }
      default:
        break;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lastEvent]);

  // ── Presence-driven auto-pause + hard resync on reconnect ──
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    if (connectionStatus === "partner-away") {
      video.pause();
      showNote(`${partnerName ?? "Your partner"}'s connection dropped — waiting to resync`, 60000);
      wasBothConnectedRef.current = false;
      return;
    }

    if (connectionStatus === "both-connected" && !wasBothConnectedRef.current) {
      wasBothConnectedRef.current = true;
      setStatusNote(null);
      if (!isController) {
        // Rejoin: pull latest ground truth immediately rather than waiting
        // for the next heartbeat, then hard-sync and resume together.
        (async () => {
          const { data } = await supabase
            .from("rooms")
            .select("last_position_seconds, is_playing")
            .eq("id", room.id)
            .maybeSingle();
          if (!data || !videoRef.current) return;
          videoRef.current.currentTime = data.last_position_seconds;
          if (data.is_playing) videoRef.current.play().catch(() => {});
          showNote("Back in sync", 1800);
        })();
      }
    }
  }, [connectionStatus, isController, partnerName, room.id, showNote]);

  // ── Local element event handlers ──
  const onVideoPlay = () => setIsPlaying(true);
  const onVideoPause = () => setIsPlaying(false);
  const onTimeUpdate = () => {
    if (videoRef.current) setCurrent(videoRef.current.currentTime);
  };

  const handlePlayPauseClick = () => {
    const video = videoRef.current;
    if (!video) return;
    if (video.paused) {
      if (!isController) return; // followers can't start playback
      video.play().catch(() => {});
      broadcastPlay(video.currentTime);
    } else {
      // Universal pause — anyone can pause instantly, no permission needed.
      video.pause();
      broadcastPause(video.currentTime);
    }
  };

  const handleSeekCommit = (value: number) => {
    const video = videoRef.current;
    if (!video || !isController) return;
    video.currentTime = value;
    broadcastSeek(value);
  };

  const handleSkip = (delta: number) => {
    const video = videoRef.current;
    if (!video || !isController) return;
    const target = Math.max(0, Math.min(duration || Infinity, video.currentTime + delta));
    video.currentTime = target;
    broadcastSeek(target);
  };

  if (!movieUrl) {
    return (
      <div className="flex aspect-video w-full items-center justify-center rounded-xl border border-dashed border-reel-border bg-reel-surface text-reel-muted">
        No movie uploaded to this room yet.
      </div>
    );
  }

  return (
    <div className="w-full">
      <div className="relative overflow-hidden rounded-xl border border-reel-border bg-black shadow-2xl shadow-black/50">
        <video
          ref={videoRef}
          src={movieUrl}
          className="aspect-video w-full bg-black"
          onLoadedMetadata={handleLoadedMetadata}
          onPlay={onVideoPlay}
          onPause={onVideoPause}
          onTimeUpdate={onTimeUpdate}
          playsInline
        />

        {statusNote && (
          <div className="pointer-events-none absolute left-1/2 top-4 -translate-x-1/2 rounded-full bg-black/70 px-4 py-1.5 text-sm text-reel-text backdrop-blur">
            {statusNote}
          </div>
        )}

        {resyncing && (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-black/30">
            <div className="h-8 w-8 animate-spin rounded-full border-2 border-reel-amber border-t-transparent" />
          </div>
        )}

        {!isController && (
          <div className="absolute bottom-3 right-3 rounded-full bg-black/60 px-3 py-1 text-xs text-reel-muted backdrop-blur">
            {room.controller_name ?? "Your partner"} has the remote
          </div>
        )}
      </div>

      {/* Controls */}
      <div className="mt-3 flex items-center gap-3 rounded-xl border border-reel-border bg-reel-surface px-4 py-3">
        <button
          onClick={handlePlayPauseClick}
          disabled={!isPlaying && !isController}
          aria-label={isPlaying ? "Pause" : "Play"}
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-reel-amber text-reel-bg transition disabled:cursor-not-allowed disabled:bg-reel-border disabled:text-reel-muted"
        >
          {isPlaying ? "❚❚" : "▶"}
        </button>

        {isController && (
          <>
            <button
              onClick={() => handleSkip(-10)}
              aria-label="Back 10 seconds"
              className="text-xs text-reel-muted hover:text-reel-text"
            >
              −10s
            </button>
            <button
              onClick={() => handleSkip(10)}
              aria-label="Forward 10 seconds"
              className="text-xs text-reel-muted hover:text-reel-text"
            >
              +10s
            </button>
          </>
        )}

        <span className="font-mono text-xs text-reel-muted">{formatTime(current)}</span>
        <input
          type="range"
          className="seekbar flex-1"
          min={0}
          max={duration || 0}
          step={0.5}
          value={current}
          disabled={!isController}
          onChange={(e) => setCurrent(Number(e.target.value))}
          onMouseUp={(e) => handleSeekCommit(Number((e.target as HTMLInputElement).value))}
          onTouchEnd={(e) => handleSeekCommit(Number((e.target as HTMLInputElement).value))}
          aria-label="Seek"
        />
        <span className="font-mono text-xs text-reel-muted">{formatTime(duration)}</span>

        <button
          onClick={takeController}
          disabled={isController}
          className="ml-1 shrink-0 rounded-full border border-reel-border px-3 py-1.5 text-xs text-reel-muted transition hover:border-reel-amber hover:text-reel-amber disabled:cursor-default disabled:opacity-40"
        >
          {isController ? "You have the remote" : "Take the remote"}
        </button>
      </div>
    </div>
  );
}
