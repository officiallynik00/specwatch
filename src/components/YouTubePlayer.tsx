"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { supabase } from "@/lib/supabase/client";
import type { ConnectionStatus } from "@/hooks/useRoomSync";
import type { Room, SyncEvent } from "@/lib/types";

// YouTube corrections are always a hard seekTo() jump rather than the
// file player's smooth playbackRate nudge (the IFrame API only exposes
// a handful of discrete rates — 0.25/0.5/0.75/1/1.25/1.5/1.75/2 — not
// the continuous range a subtle catch-up needs). Tolerance is widened
// versus the file player's 1.5s specifically to trade a little precision
// for noticeably fewer visible jumps, per the earlier discussion.
const DRIFT_THRESHOLD = 2;
const POLL_INTERVAL_MS = 250;
// If a programmatic playVideo() hasn't actually started playback by
// this point, assume the browser's autoplay policy blocked it (this
// happens to followers, whose play() call comes from a realtime event
// rather than a real click) and ask for a tap instead of waiting forever.
const PLAY_GESTURE_CHECK_MS = 700;

// Minimal shape of what we actually use from the IFrame Player API —
// deliberately not the full @types/youtube surface, to avoid adding a
// dependency for a handful of methods.
interface YTPlayer {
  getCurrentTime(): number;
  getDuration(): number;
  getPlayerState(): number;
  playVideo(): void;
  pauseVideo(): void;
  seekTo(seconds: number, allowSeekAhead: boolean): void;
  mute(): void;
  unMute(): void;
  destroy(): void;
}
interface YTPlayerEvent {
  target: YTPlayer;
  data?: number;
}
declare global {
  interface Window {
    YT?: {
      Player: new (
        el: HTMLElement | string,
        opts: {
          videoId: string;
          playerVars?: Record<string, number | string>;
          events?: {
            onReady?: (e: YTPlayerEvent) => void;
            onStateChange?: (e: YTPlayerEvent) => void;
            onError?: (e: YTPlayerEvent) => void;
          };
        }
      ) => YTPlayer;
      PlayerState: { UNSTARTED: number; ENDED: number; PLAYING: number; PAUSED: number; BUFFERING: number; CUED: number };
    };
    onYouTubeIframeAPIReady?: () => void;
  }
}

// The IFrame API script + its ready callback are global by nature (the
// script itself calls a single window-level function once, regardless
// of how many players are on the page) — this loader just makes sure we
// only ever inject the <script> tag once, no matter how many times a
// YouTubePlayer mounts across the app's lifetime.
let apiLoadPromise: Promise<void> | null = null;
function loadYouTubeIframeAPI(): Promise<void> {
  if (window.YT?.Player) return Promise.resolve();
  if (apiLoadPromise) return apiLoadPromise;
  apiLoadPromise = new Promise((resolve) => {
    const prev = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => {
      prev?.();
      resolve();
    };
    const tag = document.createElement("script");
    tag.src = "https://www.youtube.com/iframe_api";
    document.head.appendChild(tag);
  });
  return apiLoadPromise;
}

interface YouTubePlayerProps {
  room: Room;
  myName: string;
  isController: boolean;
  connectionStatus: ConnectionStatus;
  partnerName: string | null;
  lastEvent: SyncEvent | null;
  heartbeatIntervalMs: number;
  clockOffsetMs: number;
  broadcastPlay: (t: number) => void;
  broadcastPause: (t: number) => void;
  broadcastSeek: (t: number, isPlaying: boolean) => void;
  broadcastHeartbeat: (t: number, playing: boolean) => void;
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

export default function YouTubePlayer({
  room,
  myName,
  isController,
  connectionStatus,
  partnerName,
  lastEvent,
  heartbeatIntervalMs,
  clockOffsetMs,
  broadcastPlay,
  broadcastPause,
  broadcastSeek,
  broadcastHeartbeat,
  onEmoji,
}: YouTubePlayerProps) {
  const mountRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const playerRef = useRef<YTPlayer | null>(null);
  const [ready, setReady] = useState(false);
  const [isPlaying, setIsPlaying] = useState(false);
  const [current, setCurrent] = useState(room.last_position_seconds);
  const [duration, setDuration] = useState(0);
  const [isBuffering, setIsBuffering] = useState(false);
  const [statusNote, setStatusNote] = useState<string | null>(null);
  const [resyncing, setResyncing] = useState(false);
  const [needsPlayGesture, setNeedsPlayGesture] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);

  const isSeekDraggingRef = useRef(false);
  const seekDragValueRef = useRef(0);
  const lastAuthoritativeSentAtRef = useRef(0);
  const wasBothConnectedRef = useRef(false);
  const bufferAutoPausedRef = useRef(false);
  const noteTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const gestureCheckRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const expectingBufferRef = useRef(false);
  const expectingBufferTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Call right before any controller-initiated seekTo()/resume. The
  // IFrame API almost always drops into BUFFERING right after a
  // deliberate seek — this marks that upcoming buffer as "expected" so
  // the stall-detector below doesn't mistake a normal skip/scrub/resume
  // for a dropped connection and needlessly pause the follower.
  const markExpectedBuffer = useCallback(() => {
    expectingBufferRef.current = true;
    if (expectingBufferTimeoutRef.current) clearTimeout(expectingBufferTimeoutRef.current);
    expectingBufferTimeoutRef.current = setTimeout(() => {
      expectingBufferRef.current = false;
    }, 4000);
  }, []);

  const showNote = useCallback((text: string, ms = 2500) => {
    setStatusNote(text);
    if (noteTimeoutRef.current) clearTimeout(noteTimeoutRef.current);
    noteTimeoutRef.current = setTimeout(() => setStatusNote(null), ms);
  }, []);

  // ── Create the player once we have a videoId ──
  useEffect(() => {
    if (!room.youtube_video_id || !mountRef.current) return;
    let cancelled = false;

    loadYouTubeIframeAPI().then(() => {
      if (cancelled || !mountRef.current || !window.YT) return;
      const player = new window.YT.Player(mountRef.current, {
        videoId: room.youtube_video_id!,
        playerVars: { autoplay: 0, controls: 0, rel: 0, playsinline: 1, modestbranding: 1 },
        events: {
          onReady: (e) => {
            playerRef.current = e.target;
            setDuration(e.target.getDuration());
            e.target.seekTo(room.last_position_seconds, true);
            setReady(true);
          },
          onStateChange: (e) => {
            const YT = window.YT!;
            const state = e.data;
            setIsPlaying(state === YT.PlayerState.PLAYING);
            const buffering = state === YT.PlayerState.BUFFERING;
            setIsBuffering(buffering);

            // Mirror the file player's "controller stalls -> tell the
            // follower to pause too" behavior. Buffering triggered by our
            // own deliberate seek/resume (markExpectedBuffer) is not a
            // stall and must not trigger this — otherwise every skip,
            // scrub, or resume spuriously pauses the follower.
            if (isController) {
              if (buffering && !bufferAutoPausedRef.current && !expectingBufferRef.current) {
                bufferAutoPausedRef.current = true;
                broadcastPause(playerRef.current?.getCurrentTime() ?? current);
              } else if (state === YT.PlayerState.PLAYING && bufferAutoPausedRef.current) {
                bufferAutoPausedRef.current = false;
                broadcastPlay(playerRef.current?.getCurrentTime() ?? current);
              }
              if (state === YT.PlayerState.PLAYING) expectingBufferRef.current = false;
            }
            if (state === YT.PlayerState.PLAYING) setNeedsPlayGesture(false);
          },
          onError: () => {
            // Common causes: embedding disabled by the uploader, video
            // deleted/private since the link was pasted, or invalid ID.
            setLoadError("This video can't play here — the link may be invalid or embedding may be disabled.");
          },
        },
      });
    });

    return () => {
      cancelled = true;
      playerRef.current?.destroy();
      playerRef.current = null;
      setReady(false);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [room.youtube_video_id]);

  // ── Poll current time for the UI (IFrame API has no timeupdate event) ──
  useEffect(() => {
    if (!ready) return;
    const id = setInterval(() => {
      if (!isSeekDraggingRef.current && playerRef.current) {
        setCurrent(playerRef.current.getCurrentTime());
      }
    }, POLL_INTERVAL_MS);
    return () => clearInterval(id);
  }, [ready]);

  // ── Controller heartbeat ──
  useEffect(() => {
    if (!isController || !ready) return;
    const id = setInterval(() => {
      const player = playerRef.current;
      if (!player) return;
      broadcastHeartbeat(player.getCurrentTime(), player.getPlayerState() === window.YT?.PlayerState.PLAYING);
    }, heartbeatIntervalMs);
    return () => clearInterval(id);
  }, [isController, ready, heartbeatIntervalMs, broadcastHeartbeat]);

  const attemptPlay = useCallback((player: YTPlayer) => {
    player.playVideo();
    if (gestureCheckRef.current) clearTimeout(gestureCheckRef.current);
    gestureCheckRef.current = setTimeout(() => {
      const YT = window.YT;
      if (!YT) return;
      const state = player.getPlayerState();
      // Still buffering (e.g. right after a resync/skip seekTo) is not a
      // blocked autoplay — it's just loading, and will resolve on its
      // own. Only surface the "Tap to play" overlay for a state that
      // looks genuinely stuck (paused/cued/unstarted), not mid-buffer.
      if (state === YT.PlayerState.BUFFERING) return;
      if (state !== YT.PlayerState.PLAYING) {
        setNeedsPlayGesture(true);
      }
    }, PLAY_GESTURE_CHECK_MS);
  }, []);

  // ── React to sync events from the partner (same shape as VideoPlayer) ──
  useEffect(() => {
    if (!lastEvent || !ready || !playerRef.current) return;
    const player = playerRef.current;
    const YT = window.YT!;

    const compensate = (t: number, sentAt: number, assumePlaying: boolean) =>
      assumePlaying ? t + (Date.now() - sentAt + clockOffsetMs) / 1000 : t;

    switch (lastEvent.type) {
      case "heartbeat": {
        if (isController) return;
        if (lastEvent.serverSentAt < lastAuthoritativeSentAtRef.current) return;
        // Already mid-buffer from a previous correction — stacking
        // another seekTo() on top just extends the stall instead of
        // resolving it. Let the in-flight one finish first.
        if (player.getPlayerState() === YT.PlayerState.BUFFERING) return;
        const target = compensate(lastEvent.currentTime, lastEvent.serverSentAt, lastEvent.isPlaying);
        const gap = Math.abs(player.getCurrentTime() - target);
        const playerIsPaused = player.getPlayerState() !== YT.PlayerState.PLAYING;

        if (lastEvent.isPlaying && playerIsPaused) attemptPlay(player);
        if (!lastEvent.isPlaying && !playerIsPaused) {
          player.pauseVideo();
          setNeedsPlayGesture(false);
        }
        if (gap >= DRIFT_THRESHOLD) {
          setResyncing(true);
          player.seekTo(target, true);
          showNote("Resyncing…");
          setTimeout(() => setResyncing(false), 400);
        }
        break;
      }
      case "play": {
        if (isController) break;
        lastAuthoritativeSentAtRef.current = lastEvent.serverSentAt;
        const target = compensate(lastEvent.currentTime, lastEvent.serverSentAt, true);
        player.seekTo(target, true);
        attemptPlay(player);
        break;
      }
      case "pause": {
        lastAuthoritativeSentAtRef.current = lastEvent.serverSentAt;
        player.pauseVideo();
        player.seekTo(lastEvent.currentTime, true);
        setNeedsPlayGesture(false);
        if (lastEvent.by !== myName) showNote(`${lastEvent.by} paused`);
        break;
      }
      case "seek": {
        if (isController) break;
        lastAuthoritativeSentAtRef.current = lastEvent.serverSentAt;
        const target = compensate(lastEvent.currentTime, lastEvent.serverSentAt, lastEvent.isPlaying);
        player.seekTo(target, true);
        if (lastEvent.isPlaying) attemptPlay(player);
        else player.pauseVideo();
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
    const player = playerRef.current;
    if (!ready || !player) return;

    if (connectionStatus === "partner-away" || connectionStatus === "reconnecting") {
      player.pauseVideo();
      showNote(
        connectionStatus === "reconnecting"
          ? "Connection interrupted — reconnecting…"
          : `${partnerName ?? "Your partner"}'s connection dropped — waiting to resync`,
        60000
      );
      wasBothConnectedRef.current = false;
      return;
    }

    if (connectionStatus === "both-connected" && !wasBothConnectedRef.current) {
      wasBothConnectedRef.current = true;
      setStatusNote(null);
      if (!isController) {
        (async () => {
          const { data } = await supabase
            .from("rooms")
            .select("last_position_seconds, is_playing")
            .eq("id", room.id)
            .maybeSingle();
          if (!data || !playerRef.current) return;
          lastAuthoritativeSentAtRef.current = Date.now();
          playerRef.current.seekTo(data.last_position_seconds, true);
          if (data.is_playing) attemptPlay(playerRef.current);
          showNote("Back in sync", 1800);
        })();
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connectionStatus, ready, isController, partnerName, room.id, showNote]);

  // ── Fullscreen ──
  useEffect(() => {
    const handleChange = () => setIsFullscreen(document.fullscreenElement === containerRef.current);
    document.addEventListener("fullscreenchange", handleChange);
    return () => document.removeEventListener("fullscreenchange", handleChange);
  }, []);

  function toggleFullscreen() {
    if (document.fullscreenElement) document.exitFullscreen();
    else containerRef.current?.requestFullscreen().catch(() => {});
  }

  const handlePlayPauseClick = () => {
    const player = playerRef.current;
    if (!player) return;
    const paused = player.getPlayerState() !== window.YT?.PlayerState.PLAYING;
    if (paused) {
      if (isController) {
        markExpectedBuffer();
        attemptPlay(player);
        broadcastPlay(player.getCurrentTime());
        return;
      }
      if (needsPlayGesture) {
        attemptPlay(player);
        return;
      }
      return; // only the host can start playback from a paused state
    }
    player.pauseVideo(); // universal pause
    broadcastPause(player.getCurrentTime());
  };

  const handleSkip = (delta: number) => {
    const player = playerRef.current;
    if (!player || !isController) return;
    const target = Math.max(0, Math.min(duration || Infinity, player.getCurrentTime() + delta));
    markExpectedBuffer();
    player.seekTo(target, true);
    broadcastSeek(target, player.getPlayerState() === window.YT?.PlayerState.PLAYING);
  };

  const handleSeekCommit = (value: number) => {
    const player = playerRef.current;
    if (!player || !isController) return;
    markExpectedBuffer();
    player.seekTo(value, true);
    broadcastSeek(value, player.getPlayerState() === window.YT?.PlayerState.PLAYING);
  };

  if (loadError) {
    return (
      <div className="flex aspect-video w-full flex-col items-center justify-center gap-1 rounded-xl border border-dashed border-reel-rose/50 bg-reel-surface p-6 text-center">
        <p className="text-sm text-reel-rose">{loadError}</p>
        {isController && (
          <p className="text-xs text-reel-muted">Head back to the lobby to try a different link.</p>
        )}
      </div>
    );
  }

  return (
    <div className="w-full">
      <div
        ref={containerRef}
        className={`relative overflow-hidden border border-reel-border bg-black shadow-2xl shadow-black/50 ${
          isFullscreen ? "flex h-full w-full items-center justify-center rounded-none" : "rounded-xl"
        }`}
      >
        <div className={isFullscreen ? "h-full w-full" : "aspect-video w-full"}>
          <div ref={mountRef} className="h-full w-full" />
        </div>

        {!ready && (
          <div className="absolute inset-0 flex items-center justify-center bg-black text-sm text-reel-muted">
            Loading video…
          </div>
        )}

        {statusNote && (
          <div className="pointer-events-none absolute left-1/2 top-4 -translate-x-1/2 rounded-full bg-black/70 px-4 py-1.5 text-sm text-reel-text backdrop-blur">
            {statusNote}
          </div>
        )}

        {isBuffering && (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
            <div className="h-8 w-8 animate-spin rounded-full border-2 border-reel-amber border-t-transparent" />
          </div>
        )}

        {needsPlayGesture && (
          <button
            onClick={handlePlayPauseClick}
            className="absolute inset-0 flex items-center justify-center bg-black/40 text-reel-text transition hover:bg-black/50"
          >
            <span className="rounded-full bg-reel-amber px-5 py-2.5 text-sm font-medium text-reel-bg">
              Tap to play
            </span>
          </button>
        )}

        {/* Controls bar */}
        <div className="absolute inset-x-0 bottom-0 flex flex-col gap-2 bg-gradient-to-t from-black/80 to-transparent p-3">
          <input
            type="range"
            min={0}
            max={duration || 0}
            step={0.5}
            value={isSeekDraggingRef.current ? seekDragValueRef.current : current}
            disabled={!isController}
            onMouseDown={() => (isSeekDraggingRef.current = true)}
            onTouchStart={() => (isSeekDraggingRef.current = true)}
            onChange={(e) => {
              const value = Number(e.target.value);
              seekDragValueRef.current = value;
              setCurrent(value);
            }}
            onMouseUp={(e) => {
              isSeekDraggingRef.current = false;
              handleSeekCommit(Number((e.target as HTMLInputElement).value));
            }}
            onTouchEnd={(e) => {
              isSeekDraggingRef.current = false;
              handleSeekCommit(Number((e.target as HTMLInputElement).value));
            }}
            className="h-1 w-full cursor-pointer accent-reel-amber disabled:cursor-default"
          />
          <div className="flex items-center gap-3">
            <button
              onClick={handlePlayPauseClick}
              className="shrink-0 rounded-full bg-reel-amber px-3 py-1.5 text-xs font-medium text-reel-bg transition hover:bg-reel-amberDim"
            >
              {isPlaying ? "Pause" : "Play"}
            </button>
            {isController && (
              <>
                <button onClick={() => handleSkip(-10)} className="text-xs text-reel-muted hover:text-reel-amber">
                  −10s
                </button>
                <button onClick={() => handleSkip(10)} className="text-xs text-reel-muted hover:text-reel-amber">
                  +10s
                </button>
              </>
            )}
            <span className="font-mono text-[11px] text-reel-muted">
              {formatTime(current)} / {formatTime(duration)}
            </span>
            <div className="flex-1" />
            {!isController && (
              <span className="shrink-0 rounded-full border border-reel-border bg-black/30 px-2.5 py-1 text-[10px] text-reel-muted backdrop-blur-sm">
                {room.host_name ?? "Host"} controls playback
              </span>
            )}
            <button
              onClick={toggleFullscreen}
              className="shrink-0 text-xs text-reel-muted hover:text-reel-amber"
            >
              {isFullscreen ? "Exit" : "Fullscreen"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
