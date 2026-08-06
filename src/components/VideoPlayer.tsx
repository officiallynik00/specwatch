"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { supabase } from "@/lib/supabase/client";
import type { ConnectionStatus } from "@/hooks/useRoomSync";
import type { ChatMessage, Room, SyncEvent } from "@/lib/types";
import FullscreenChatOverlay from "@/components/FullscreenChatOverlay";

const SMALL_DRIFT_THRESHOLD = 0.5; // seconds — corrected via a gentle playbackRate nudge
const LARGE_DRIFT_THRESHOLD = 1.5; // seconds — hard resync + visible status
const NUDGE_RATE_FAST = 1.06; // used when we're behind the controller
const NUDGE_RATE_SLOW = 0.94; // used when we're ahead of the controller


interface VideoPlayerProps {
  room: Room;
  myName: string;
  // True only for the room's host — see useRoomSync. Gates play/seek/skip.
  // Pause is universal (see handlePlayPauseClick) and works for anyone.
  isController: boolean;
  connectionStatus: ConnectionStatus;
  partnerName: string | null;
  lastEvent: SyncEvent | null;
  heartbeatIntervalMs: number;
  // Estimated (host's clock - my clock) in ms, from useRoomSync's
  // ping/pong. Folded into compensate() so ordinary clock disagreement
  // between two devices isn't mistaken for playback drift.
  clockOffsetMs: number;
  broadcastPlay: (t: number) => void;
  broadcastPause: (t: number) => void;
  broadcastSeek: (t: number, isPlaying: boolean) => void;
  broadcastHeartbeat: (t: number, playing: boolean) => void;
  onEmoji: (emoji: string, by: string) => void;
  chatMessages: ChatMessage[];
  onSendChat: (body: string) => void;
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
  clockOffsetMs,
  broadcastPlay,
  broadcastPause,
  broadcastSeek,
  broadcastHeartbeat,
  onEmoji,
  chatMessages,
  onSendChat,
}: VideoPlayerProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [current, setCurrent] = useState(room.last_position_seconds);
  const [duration, setDuration] = useState(0);
  const [statusNote, setStatusNote] = useState<string | null>(null);
  const [resyncing, setResyncing] = useState(false);
  const [isBuffering, setIsBuffering] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [isPiP, setIsPiP] = useState(false);
  const [pipSupported, setPipSupported] = useState(false);
  const [fullscreenChatEnabled, setFullscreenChatEnabled] = useState(true);
  const [fsControlsVisible, setFsControlsVisible] = useState(true);
  // True when a programmatic video.play() (triggered by a sync event, not a
  // click) got rejected by the browser's autoplay policy. This happens to
  // followers fairly often — the host's Play click is a real user gesture,
  // but the follower's play() call is fired from a realtime event, which
  // most browsers refuse to autoplay with sound. When this is true we show
  // the play/pause button as tappable so the follower can supply the
  // missing gesture themselves, without granting them real host controls.
  const [needsPlayGesture, setNeedsPlayGesture] = useState(false);
  const wasBothConnectedRef = useRef(false);
  const initializedRef = useRef(false);
  const noteTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const bufferAutoPausedRef = useRef(false);
  const fsControlsTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // serverSentAt (host's Date.now()) of the last play/seek/pause we've
  // actually applied. A heartbeat — or any event — sent BEFORE this was
  // already in flight when a newer action happened and lost the race, so
  // it must not be allowed to override what we already applied (e.g. a
  // stale "I was at 0:40" heartbeat arriving just after a restart to 0:00).
  const lastAuthoritativeSentAtRef = useRef(0);

  const [movieUrl, setMovieUrl] = useState<string | null>(null);
  
  const showNote = useCallback((text: string, ms = 2500) => {
    setStatusNote(text);
    if (noteTimeoutRef.current) clearTimeout(noteTimeoutRef.current);
    noteTimeoutRef.current = setTimeout(() => setStatusNote(null), ms);
  }, []);

useEffect(() => {
  if (!room.movie_path) {
    setMovieUrl(null);
    return;
  }
  let cancelled = false;
  (async () => {
    try {
      const res = await fetch("/api/r2-play-url", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: room.movie_path }),
      });
      const data = await res.json();
      if (!cancelled) {
        if (res.ok && data.url) setMovieUrl(data.url);
        else {
          setMovieUrl(null);
          showNote("Couldn't load this movie — try re-uploading.");
        }
      }
    } catch {
      if (!cancelled) setMovieUrl(null);
    }
  })();
  return () => {
    cancelled = true;
  };
}, [room.movie_path, showNote]);

  

  const wakeFsControls = useCallback(() => {
    setFsControlsVisible(true);
    if (fsControlsTimerRef.current) clearTimeout(fsControlsTimerRef.current);
    fsControlsTimerRef.current = setTimeout(() => setFsControlsVisible(false), 3000);
  }, []);

  // ── Resume from last saved position once metadata is ready ──
  const handleLoadedMetadata = useCallback(() => {
    const video = videoRef.current;
    if (!video || initializedRef.current) return;
    initializedRef.current = true;
    video.currentTime = room.last_position_seconds || 0;
    setDuration(video.duration || 0);
  }, [room.last_position_seconds]);

  // Re-arm the "seek to saved position" logic whenever the room switches
  // to a different file — otherwise initializedRef stays true forever and
  // duration/seek state goes stale after the host picks a new movie.
  useEffect(() => {
    initializedRef.current = false;
  }, [room.movie_path]);

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

    // Corrects for both network latency AND ordinary clock disagreement
    // between the two devices (clockOffsetMs, measured via ping/pong in
    // useRoomSync). Without the offset term, two devices whose clocks
    // simply don't agree would read as permanent playback drift.
    const compensate = (t: number, sentAt: number, assumePlaying: boolean) =>
      assumePlaying ? t + (Date.now() - sentAt + clockOffsetMs) / 1000 : t;

    switch (lastEvent.type) {
      case "heartbeat": {
        if (isController) return; // controller is ground truth, ignore stray echoes
        // Reject a heartbeat that predates the newest play/seek/pause we've
        // already applied — it was already in flight when that newer,
        // more authoritative action happened and lost the race. Without
        // this check a stale "I was at 0:40" heartbeat can arrive right
        // after a restart-to-0:00 and yank the follower back.
        if (lastEvent.serverSentAt < lastAuthoritativeSentAtRef.current) return;
        const target = compensate(lastEvent.currentTime, lastEvent.serverSentAt, lastEvent.isPlaying);
        const gap = Math.abs(video.currentTime - target);
        if (lastEvent.isPlaying && video.paused) {
          video.play().catch(() => setNeedsPlayGesture(true));
        }
        if (!lastEvent.isPlaying && !video.paused) {
          video.pause();
          setNeedsPlayGesture(false);
        }

        if (gap >= LARGE_DRIFT_THRESHOLD) {
          video.playbackRate = 1;
          setResyncing(true);
          video.currentTime = target;
          showNote("Resyncing…");
          setTimeout(() => setResyncing(false), 400);
        } else if (gap >= SMALL_DRIFT_THRESHOLD) {
          // Smooth catch-up: nudge playback speed slightly instead of
          // hard-jumping currentTime every heartbeat, which reads as a
          // visible stutter. The rate resets once the gap closes below
          // the threshold.
          video.playbackRate = target > video.currentTime ? NUDGE_RATE_FAST : NUDGE_RATE_SLOW;
        } else if (video.playbackRate !== 1) {
          video.playbackRate = 1;
        }
        break;
      }
      case "play": {
        if (isController) break;
        lastAuthoritativeSentAtRef.current = lastEvent.serverSentAt;
        const target = compensate(lastEvent.currentTime, lastEvent.serverSentAt, true);
        video.playbackRate = 1;
        video.currentTime = target;
        video.play().catch(() => setNeedsPlayGesture(true));
        break;
      }
      case "pause": {
        lastAuthoritativeSentAtRef.current = lastEvent.serverSentAt;
        video.playbackRate = 1;
        video.pause();
        video.currentTime = lastEvent.currentTime;
        setNeedsPlayGesture(false);
        if (lastEvent.by !== myName) showNote(`${lastEvent.by} paused`);
        break;
      }
      case "seek": {
        if (isController) break;
        lastAuthoritativeSentAtRef.current = lastEvent.serverSentAt;
        // Use the host's REAL play state at the moment of the seek,
        // instead of guessing from our own (possibly stale) local state.
        const target = compensate(lastEvent.currentTime, lastEvent.serverSentAt, lastEvent.isPlaying);
        video.playbackRate = 1;
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

    if (connectionStatus === "partner-away" || connectionStatus === "reconnecting") {
      video.pause();
      video.playbackRate = 1;
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
        // Rejoin: pull latest ground truth immediately rather than waiting
        // for the next heartbeat, then hard-sync and resume together.
        (async () => {
          const { data } = await supabase
            .from("rooms")
            .select("last_position_seconds, is_playing")
            .eq("id", room.id)
            .maybeSingle();
          if (!data || !videoRef.current) return;
          lastAuthoritativeSentAtRef.current = Date.now();
          videoRef.current.currentTime = data.last_position_seconds;
          if (data.is_playing) videoRef.current.play().catch(() => {});
          showNote("Back in sync", 1800);
        })();
      }
    }
  }, [connectionStatus, isController, partnerName, room.id, showNote]);

  // Reset the playback rate on unmount so a lingering nudge never leaks
  // into a fresh mount (e.g. navigating away mid-catch-up).
  useEffect(() => {
    return () => {
      if (videoRef.current) videoRef.current.playbackRate = 1;
    };
  }, []);

  // Reveal controls on fullscreen entry; clear timer + force visible on exit
  useEffect(() => {
    if (isFullscreen) {
      wakeFsControls();
    } else if (fsControlsTimerRef.current) {
      clearTimeout(fsControlsTimerRef.current);
      setFsControlsVisible(true);
    }
  }, [isFullscreen, wakeFsControls]);

  // ── Local element event handlers ──
  const onVideoPlay = () => {
    setIsPlaying(true);
    setNeedsPlayGesture(false);
  };
  const onVideoPause = () => setIsPlaying(false);
  const onTimeUpdate = () => {
    if (videoRef.current) setCurrent(videoRef.current.currentTime);
  };

  // ── Buffering awareness ──
  // If the controller stalls, tell the follower to pause too instead of
  // letting them run ahead while we're stuck loading — then resume both
  // together once playback actually recovers.
  const onVideoWaiting = () => {
    setIsBuffering(true);
    const video = videoRef.current;
    if (isController && video && !video.paused) {
      bufferAutoPausedRef.current = true;
      broadcastPause(video.currentTime);
    }
  };
  const onVideoPlaying = () => {
    setIsBuffering(false);
    const video = videoRef.current;
    if (isController && bufferAutoPausedRef.current && video) {
      bufferAutoPausedRef.current = false;
      broadcastPlay(video.currentTime);
    }
  };

  const handlePlayPauseClick = () => {
    const video = videoRef.current;
    if (!video) return;
    if (video.paused) {
      if (isController) {
        video.play().catch(() => {});
        broadcastPlay(video.currentTime);
        return;
      }
      if (needsPlayGesture) {
        // The browser blocked our earlier programmatic play() because it
        // wasn't tied to a real click. This tap IS a real click, so it
        // satisfies the browser — resume locally only. We're not taking
        // control, just supplying the gesture the host's playback state
        // already called for.
        video.play().then(() => setNeedsPlayGesture(false)).catch(() => {});
        return;
      }
      return; // only the host can start playback from a paused state
    }
    // Universal pause — anyone can pause instantly, no permission needed.
    video.pause();
    broadcastPause(video.currentTime);
  };

  const handleSeekCommit = (value: number) => {
    const video = videoRef.current;
    if (!video || !isController) return;
    video.currentTime = value;
    broadcastSeek(value, !video.paused);
  };

  const handleSkip = (delta: number) => {
    const video = videoRef.current;
    if (!video || !isController) return;
    const target = Math.max(0, Math.min(duration || Infinity, video.currentTime + delta));
    video.currentTime = target;
    broadcastSeek(target, !video.paused);
  };

  // ── Fullscreen ──
  useEffect(() => {
    const handleChange = () => setIsFullscreen(document.fullscreenElement === containerRef.current);
    document.addEventListener("fullscreenchange", handleChange);
    return () => document.removeEventListener("fullscreenchange", handleChange);
  }, []);

  const toggleFullscreen = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    if (document.fullscreenElement) {
      document.exitFullscreen().catch(() => {});
    } else {
      el.requestFullscreen?.().catch(() => {});
    }
  }, []);

  // ── Picture-in-Picture (mini-player) ──
  useEffect(() => {
    setPipSupported(typeof document !== "undefined" && document.pictureInPictureEnabled);
  }, []);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const onEnter = () => setIsPiP(true);
    const onLeave = () => setIsPiP(false);
    video.addEventListener("enterpictureinpicture", onEnter);
    video.addEventListener("leavepictureinpicture", onLeave);
    return () => {
      video.removeEventListener("enterpictureinpicture", onEnter);
      video.removeEventListener("leavepictureinpicture", onLeave);
    };
  }, []);

  const togglePiP = useCallback(async () => {
    const video = videoRef.current;
    if (!video) return;
    try {
      if (document.pictureInPictureElement) {
        await document.exitPictureInPicture();
      } else {
        await video.requestPictureInPicture();
      }
    } catch {
      // Browser refused (e.g. no video track loaded yet) — fail silently.
    }
  }, []);

  // ── Media Session — lock-screen / notification-tray controls so playback
  // stays controllable (and shows correct now-playing info) when the tab is
  // backgrounded or the phone screen is off. ──
  useEffect(() => {
    if (typeof navigator === "undefined" || !("mediaSession" in navigator)) return;
    navigator.mediaSession.metadata = new MediaMetadata({
      title: room.movie_title ?? "Watch Party",
      artist: partnerName ? `Watching with ${partnerName}` : "Watch Party",
    });
  }, [room.movie_title, partnerName]);

  useEffect(() => {
    if (typeof navigator === "undefined" || !("mediaSession" in navigator)) return;
    navigator.mediaSession.playbackState = isPlaying ? "playing" : "paused";
  }, [isPlaying]);

  useEffect(() => {
    if (typeof navigator === "undefined" || !("mediaSession" in navigator)) return;
    const ms = navigator.mediaSession;

    // Anyone can pause from the lock screen (universal pause). Resuming,
    // seeking, and skipping are host-only, same as the on-screen controls.
    ms.setActionHandler(
      "play",
      isController || needsPlayGesture ? () => handlePlayPauseClick() : null
    );
    ms.setActionHandler("pause", () => handlePlayPauseClick());
    ms.setActionHandler("seekbackward", isController ? () => handleSkip(-10) : null);
    ms.setActionHandler("seekforward", isController ? () => handleSkip(10) : null);
    ms.setActionHandler(
      "seekto",
      isController
        ? (details) => {
            if (details.seekTime != null) handleSeekCommit(details.seekTime);
          }
        : null
    );

    return () => {
      ms.setActionHandler("play", null);
      ms.setActionHandler("pause", null);
      ms.setActionHandler("seekbackward", null);
      ms.setActionHandler("seekforward", null);
      ms.setActionHandler("seekto", null);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isController, duration, needsPlayGesture]);

  useEffect(() => {
    if (typeof navigator === "undefined" || !("mediaSession" in navigator) || !duration) return;
    try {
      navigator.mediaSession.setPositionState({
        duration,
        playbackRate: 1,
        position: Math.min(current, duration),
      });
    } catch {
      // Some browsers throw if position > duration mid-seek — ignore.
    }
  }, [current, duration]);

  const renderControlBar = (overlay: boolean) => (
    <div
      className={
        overlay
          ? `absolute inset-x-0 bottom-0 z-10 flex flex-wrap items-center gap-2 bg-gradient-to-t from-black/85 via-black/50 to-transparent px-3 pb-3 pt-10 transition-opacity duration-500 sm:gap-3 sm:px-5 sm:pb-4 ${
              fsControlsVisible ? "opacity-100" : "pointer-events-none opacity-0"
            }`
          : "mt-3 flex flex-wrap items-center gap-2 rounded-xl border border-reel-border bg-reel-surface px-3 py-2.5 sm:gap-3 sm:px-4 sm:py-3"
      }
    >
      <div className="flex shrink-0 items-center gap-2">
        <button
          onClick={handlePlayPauseClick}
          disabled={!isPlaying && !isController && !needsPlayGesture}
          aria-label={isPlaying ? "Pause" : needsPlayGesture ? "Tap to resume" : "Play"}
          title={
            !isController
              ? isPlaying
                ? "Pause (anyone can pause)"
                : needsPlayGesture
                ? "Your browser paused this — tap to resume"
                : `Only ${room.host_name ?? "the host"} can start playback`
              : undefined
          }
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-reel-amber text-reel-bg transition disabled:cursor-not-allowed disabled:bg-reel-border disabled:text-reel-muted sm:h-9 sm:w-9"
        >
          {isPlaying ? "❚❚" : "▶"}
        </button>

        {isController && (
          <>
            <button
              onClick={() => handleSkip(-10)}
              aria-label="Back 10 seconds"
              className="text-[11px] text-reel-muted hover:text-reel-text sm:text-xs"
            >
              −10s
            </button>
            <button
              onClick={() => handleSkip(10)}
              aria-label="Forward 10 seconds"
              className="text-[11px] text-reel-muted hover:text-reel-text sm:text-xs"
            >
              +10s
            </button>
          </>
        )}
      </div>

      <div className="flex min-w-0 flex-1 basis-full items-center gap-2 sm:basis-auto">
        <span className="font-mono text-[10px] text-reel-muted sm:text-xs">
          {formatTime(current)}
        </span>
        <input
          type="range"
          className="seekbar min-w-0 flex-1"
          min={0}
          max={duration || 0}
          step={0.5}
          value={current}
          disabled={!isController}
          onChange={(e) => setCurrent(Number(e.target.value))}
          onMouseUp={(e) =>
            handleSeekCommit(Number((e.target as HTMLInputElement).value))
          }
          onTouchEnd={(e) =>
            handleSeekCommit(Number((e.target as HTMLInputElement).value))
          }
          aria-label="Seek"
        />
        <span className="font-mono text-[10px] text-reel-muted sm:text-xs">
          {formatTime(duration)}
        </span>
      </div>

      {!isController && (
        <span className="shrink-0 rounded-full border border-reel-border bg-black/30 px-2.5 py-1 text-[10px] text-reel-muted backdrop-blur-sm sm:px-3 sm:py-1.5 sm:text-xs">
          {room.host_name ?? "Host"} controls playback
        </span>
      )}
    </div>
  );

  if (!movieUrl) {
    return (
      <div className="flex aspect-video w-full items-center justify-center rounded-xl border border-dashed border-reel-border bg-reel-surface text-reel-muted">
        No movie uploaded to this room yet.
      </div>
    );
  }

  return (
    <div className="w-full">
      <div
        ref={containerRef}
        onMouseMove={() => isFullscreen && wakeFsControls()}
        onTouchStart={() => isFullscreen && wakeFsControls()}
        className={`relative overflow-hidden border border-reel-border bg-black shadow-2xl shadow-black/50 ${
          isFullscreen
            ? "flex h-full w-full items-center justify-center rounded-none"
            : "rounded-xl"
        }`}
      >
        <video
          ref={videoRef}
          src={movieUrl}
          className={
            isFullscreen
              ? "h-full max-h-screen w-full object-contain bg-black"
              : "aspect-video w-full bg-black"
          }
          onLoadedMetadata={handleLoadedMetadata}
          onPlay={onVideoPlay}
          onPause={onVideoPause}
          onTimeUpdate={onTimeUpdate}
          onWaiting={onVideoWaiting}
          onPlaying={onVideoPlaying}
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

        {!resyncing && isBuffering && (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-black/20">
            <div className="flex items-center gap-2 rounded-full bg-black/70 px-3 py-1.5 text-xs text-reel-text backdrop-blur">
              <div className="h-3 w-3 animate-spin rounded-full border-2 border-reel-amber border-t-transparent" />
              Buffering…
            </div>
          </div>
        )}

        {!isController && (
          <div className="absolute bottom-3 right-3 rounded-full bg-black/60 px-3 py-1 text-xs text-reel-muted backdrop-blur">
            {room.host_name ?? "Your host"} has the remote
          </div>
        )}

        {/* Fullscreen chat: only exists inside this element's subtree, so
            it's actually visible while the Fullscreen API is active —
            unlike the page-level ChatDrawer, which the browser hides. */}
        {isFullscreen && fullscreenChatEnabled && (
          <FullscreenChatOverlay
            messages={chatMessages}
            myName={myName}
            onSend={onSendChat}
            onDisable={() => setFullscreenChatEnabled(false)}
          />
        )}

        {/* Fullscreen / PiP / chat-toggle controls float over the video
            itself so they're reachable even while the bottom control bar
            is off-screen in fullscreen mode. */}
        <div className="absolute right-3 top-3 flex gap-2">
          {isFullscreen && (
            <button
              onClick={() => setFullscreenChatEnabled((v) => !v)}
              aria-label={fullscreenChatEnabled ? "Disable chat" : "Enable chat"}
              aria-pressed={fullscreenChatEnabled}
              title={fullscreenChatEnabled ? "Disable chat" : "Enable chat"}
              className={`flex h-8 w-8 items-center justify-center rounded-full backdrop-blur transition ${
                fullscreenChatEnabled
                  ? "bg-reel-amber text-reel-bg"
                  : "bg-black/60 text-reel-text hover:bg-black/80"
              }`}
            >
              <svg
                viewBox="0 0 24 24"
                className="h-4 w-4"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
              >
                <path d="M4 5.5a1.5 1.5 0 0 1 1.5-1.5h13A1.5 1.5 0 0 1 20 5.5v9a1.5 1.5 0 0 1-1.5 1.5H9l-4 3.5V16H5.5A1.5 1.5 0 0 1 4 14.5v-9Z" />
              </svg>
            </button>
          )}
          {pipSupported && (
            <button
              onClick={togglePiP}
              aria-label={isPiP ? "Exit mini-player" : "Open mini-player"}
              title={isPiP ? "Exit mini-player" : "Mini-player"}
              className="flex h-8 w-8 items-center justify-center rounded-full bg-black/60 text-reel-text backdrop-blur transition hover:bg-black/80"
            >
              <svg
                viewBox="0 0 24 24"
                className="h-4 w-4"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
              >
                <rect x="3" y="4" width="18" height="14" rx="1.5" />
                <rect x="12" y="11" width="7" height="5" rx="1" fill="currentColor" stroke="none" />
              </svg>
            </button>
          )}
          <button
            onClick={toggleFullscreen}
            aria-label={isFullscreen ? "Exit fullscreen" : "Enter fullscreen"}
            title={isFullscreen ? "Exit fullscreen" : "Fullscreen"}
            className="flex h-8 w-8 items-center justify-center rounded-full bg-black/60 text-reel-text backdrop-blur transition hover:bg-black/80"
          >
            {isFullscreen ? (
              <svg
                viewBox="0 0 24 24"
                className="h-4 w-4"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
              >
                <path d="M9 4v4a1 1 0 0 1-1 1H4M15 4v4a1 1 0 0 0 1 1h4M9 20v-4a1 1 0 0 0-1-1H4M15 20v-4a1 1 0 0 1 1-1h4" />
              </svg>
            ) : (
              <svg
                viewBox="0 0 24 24"
                className="h-4 w-4"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
              >
                <path d="M4 9V5a1 1 0 0 1 1-1h4M15 4h4a1 1 0 0 1 1 1v4M20 15v4a1 1 0 0 1-1 1h-4M9 20H5a1 1 0 0 1-1-1v-4" />
              </svg>
            )}
          </button>
        </div>

        {/* Fullscreen overlay control bar — fades after 3 s idle */}
        {isFullscreen && renderControlBar(true)}
      </div>

      {/* Docked control bar (non-fullscreen) */}
      {!isFullscreen && renderControlBar(false)}
    </div>
  );
}
