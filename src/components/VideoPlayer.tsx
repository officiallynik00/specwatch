"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { supabase } from "@/lib/supabase/client";
import type { ConnectionStatus } from "@/hooks/useRoomSync";
import type { ChatMessage, Room, SyncEvent, Subtitle } from "@/lib/types";
import FullscreenChatOverlay from "@/components/FullscreenChatOverlay";
import EmojiOverlay, { type FloatingBubble } from "@/components/EmojiOverlay";
import type { PttStatus } from "@/hooks/usePushToTalk";

const SMALL_DRIFT_THRESHOLD = 0.5; // seconds — corrected via a gentle playbackRate nudge
const LARGE_DRIFT_THRESHOLD = 1.5; // seconds — hard resync + visible status
const NUDGE_RATE_FAST = 1.06; // multiplier applied on top of the chosen speed
const NUDGE_RATE_SLOW = 0.94; // multiplier applied on top of the chosen speed

// audioTracks isn't in TS's lib.dom.d.ts (it's Chrome/Edge/Safari-only,
// not standardized) — this is the minimal shape we actually use.
interface AudioTrackLike {
  id: string;
  label: string;
  language: string;
  enabled: boolean;
}
interface AudioTrackListLike extends EventTarget {
  readonly length: number;
  [index: number]: AudioTrackLike;
}
interface MediaElementWithAudioTracks extends HTMLVideoElement {
  audioTracks?: AudioTrackListLike;
}

/** Selected subtitle: "off", `own:<subtitleId>` (an uploaded file), or
 *  `embedded:<index>` (an in-band track already in the source file). */
type SubtitleSelection = "off" | `own:${string}` | `embedded:${number}`;

// <track> only accepts WebVTT. SRT differs just enough (comma instead of
// a dot in timestamps, no "WEBVTT" header) that a straight cue-timing
// regex swap is enough — no real parsing needed.
function srtToVtt(srt: string): string {
  const body = srt
    .replace(/\r+/g, "")
    .replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, "$1.$2");
  return `WEBVTT\n\n${body}`;
}


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
  // Reactions — floating bubbles + quick-tap bar are owned by PlayerScreen
  // (shared with the non-fullscreen layout) and just rendered here too so
  // they're visible inside the Fullscreen API's element, same reasoning
  // as FullscreenChatOverlay above.
  bubbles: FloatingBubble[];
  onTapEmoji: (emoji: string) => void;
  onRemoveBubble: (id: string) => void;
  // Push-to-talk — optional so this component doesn't hard-require voice
  // wiring (e.g. if a future caller doesn't have it set up).
  ptt?: {
    status: PttStatus;
    isTalking: boolean;
    partnerTalking: boolean;
    error: string | null;
    onStart: () => void;
    onStop: () => void;
    onRetry: () => void;
  };
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
  bubbles,
  onTapEmoji,
  onRemoveBubble,
  ptt,
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
  // Volume: separate from ducking below. This is the user's *chosen*
  // level; ducking temporarily dips below it and returns to it, rather
  // than always jumping back to a hardcoded 1.0.
  const [volume, setVolume] = useState(1);
  const [muted, setMuted] = useState(false);
  const preMuteVolumeRef = useRef(1);
  // Playback speed. Kept in a ref too (baseRateRef) so the drift-
  // correction logic below can read the current value without needing
  // it in every effect's dependency array — those effects fire on sync
  // events, not on speed changes, and should just pick up whatever the
  // latest chosen speed is at the time.
  const [playbackSpeed, setPlaybackSpeed] = useState(1);
  const baseRateRef = useRef(1);
  const [speedMenuOpen, setSpeedMenuOpen] = useState(false);
  const [volumeMenuOpen, setVolumeMenuOpen] = useState(false);
  // Volume ducking while either side is on push-to-talk. Ducks to a
  // fraction of whatever the person chose with the volume slider (not a
  // fixed absolute level), so it dips proportionally whether they're
  // normally at 100% or already listening quietly.
  const DUCK_RATIO = 0.22;
  const DUCK_MS = 220;
  const duckRafRef = useRef<number | null>(null);
  // Guards the fullscreen mic button against a duplicate onStop firing
  // (pointerup + pointerleave both landing) — same pattern PushToTalkButton
  // uses for its windowed-mode button.
  const micHeldRef = useRef(false);
  const handleMicDown = useCallback(
    (e: React.PointerEvent) => {
      if (!ptt || ptt.status !== "connected" || micHeldRef.current) return;
      e.preventDefault();
      micHeldRef.current = true;
      try {
        e.currentTarget.setPointerCapture(e.pointerId);
      } catch {
        // Best-effort — see PushToTalkButton for why this matters on touch.
      }
      ptt.onStart();
    },
    [ptt]
  );
  const handleMicUp = useCallback(
    (e: React.PointerEvent) => {
      if (!ptt || !micHeldRef.current) return;
      e.preventDefault();
      micHeldRef.current = false;
      try {
        e.currentTarget.releasePointerCapture(e.pointerId);
      } catch {
        // Already released or never captured — fine either way.
      }
      ptt.onStop();
    },
    [ptt]
  );
  // The mic button only exists in the fullscreen subtree — if the person
  // exits fullscreen mid-press, it unmounts without a pointerup ever
  // firing, so onStop() would never run and the ref would stay stuck
  // "held" (silently blocking the next press, and possibly leaving the
  // mic open on the partner's end). Catch that transition explicitly.
  useEffect(() => {
    if (!isFullscreen && micHeldRef.current) {
      micHeldRef.current = false;
      ptt?.onStop();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isFullscreen]);

  // Duck the movie's volume while either person is on push-to-talk, so a
  // comment mid-scene doesn't mean shouting over the soundtrack. Ramps
  // smoothly rather than jumping, since an instant volume cut/restore
  // reads as jarring — same reasoning apps like Spotify use for
  // notification ducking.
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const chosenVolume = muted ? 0 : volume;
    const target = ptt?.isTalking || ptt?.partnerTalking ? chosenVolume * DUCK_RATIO : chosenVolume;
    if (duckRafRef.current !== null) cancelAnimationFrame(duckRafRef.current);

    const start = video.volume;
    if (Math.abs(start - target) < 0.001) {
      video.volume = target;
      return;
    }
    const startTime = performance.now();

    const step = (now: number) => {
      const video2 = videoRef.current;
      if (!video2) return;
      const t = Math.min(1, (now - startTime) / DUCK_MS);
      // Smoothstep easing — gentler at both ends than a linear ramp.
      const eased = t * t * (3 - 2 * t);
      video2.volume = start + (target - start) * eased;
      if (t < 1) {
        duckRafRef.current = requestAnimationFrame(step);
      } else {
        duckRafRef.current = null;
      }
    };
    duckRafRef.current = requestAnimationFrame(step);

    return () => {
      if (duckRafRef.current !== null) {
        cancelAnimationFrame(duckRafRef.current);
        duckRafRef.current = null;
      }
    };
  }, [ptt?.isTalking, ptt?.partnerTalking, volume, muted]);
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
  // True while the host has their finger/mouse down on the seek bar. The
  // video keeps firing onTimeUpdate in the background during this whole
  // time, and without this flag that kept snapping the slider's `current`
  // value back to the live playback position — fighting the drag and
  // making the handle jitter or spring back instead of following the
  // pointer to wherever the host is dragging it.
  const isSeekDraggingRef = useRef(false);
  const seekDragValueRef = useRef(0);
  // serverSentAt (host's Date.now()) of the last play/seek/pause we've
  // actually applied. A heartbeat — or any event — sent BEFORE this was
  // already in flight when a newer action happened and lost the race, so
  // it must not be allowed to override what we already applied (e.g. a
  // stale "I was at 0:40" heartbeat arriving just after a restart to 0:00).
  const lastAuthoritativeSentAtRef = useRef(0);

  const [movieUrl, setMovieUrl] = useState<string | null>(null);

  // ── Subtitles ──
  // Metadata for the current movie's uploaded subtitle files (from the
  // `movies` table), keyed to blob URLs holding VTT-converted text once
  // each one has been fetched. `own:<track>` elements ref map lets us
  // tell our own <track>s apart from any in-band tracks already baked
  // into the source file (embedded tracks show up in video.textTracks
  // automatically, with no <track> element of ours involved).
  const [subtitleMeta, setSubtitleMeta] = useState<Subtitle[]>([]);
  const [subtitleUrls, setSubtitleUrls] = useState<Record<string, string>>({});
  const [embeddedTracks, setEmbeddedTracks] = useState<TextTrack[]>([]);
  const [subtitleSelection, setSubtitleSelection] = useState<SubtitleSelection>("off");
  const [subsMenuOpen, setSubsMenuOpen] = useState(false);
  const ownTrackElsRef = useRef<Map<string, HTMLTrackElement>>(new Map());

  // ── Audio tracks (in-band, e.g. a dual-language MP4/MKV) ──
  const [audioTracks, setAudioTracks] = useState<AudioTrackLike[]>([]);
  const [selectedAudioId, setSelectedAudioId] = useState<string | null>(null);
  const [audioMenuOpen, setAudioMenuOpen] = useState(false);
  const avMenuWrapRef = useRef<HTMLDivElement>(null);

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

  // Look up the subtitles attached to whichever library movie is loaded.
  // room.movie_path is just a storage key, so we match it back to its
  // `movies` row here rather than threading the whole Movie object
  // through every screen between the lobby and the player.
  useEffect(() => {
    setSubtitleSelection("off");
    if (!room.movie_path) {
      setSubtitleMeta([]);
      return;
    }
    let cancelled = false;
    (async () => {
      const { data } = await supabase
        .from("movies")
        .select("subtitles")
        .eq("storage_path", room.movie_path)
        .maybeSingle();
      if (!cancelled) setSubtitleMeta((data?.subtitles as Subtitle[] | undefined) ?? []);
    })();
    return () => {
      cancelled = true;
    };
  }, [room.movie_path]);

  // Resolve each subtitle to a playable VTT blob URL: sign a GET URL for
  // the (private) storage object, fetch its text, convert SRT -> VTT if
  // needed, and wrap it in a blob URL <track src> can actually use.
  useEffect(() => {
    if (subtitleMeta.length === 0) {
      setSubtitleUrls({});
      return;
    }
    let cancelled = false;
    const createdUrls: string[] = [];
    (async () => {
      const entries: [string, string][] = [];
      for (const sub of subtitleMeta) {
        try {
          const res = await fetch("/api/r2-play-url", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ path: sub.storage_path }),
          });
          const data = await res.json();
          if (!res.ok || !data.url) continue;
          const text = await (await fetch(data.url)).text();
          const isSrt = sub.storage_path.toLowerCase().endsWith(".srt");
          const blobUrl = URL.createObjectURL(
            new Blob([isSrt ? srtToVtt(text) : text], { type: "text/vtt" })
          );
          createdUrls.push(blobUrl);
          entries.push([sub.id, blobUrl]);
        } catch {
          // Skip this one subtitle rather than failing the whole list.
        }
      }
      if (!cancelled) setSubtitleUrls(Object.fromEntries(entries));
    })();
    return () => {
      cancelled = true;
      createdUrls.forEach((u) => URL.revokeObjectURL(u));
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [subtitleMeta]);

  // Track in-band ("embedded") subtitle/caption tracks that came baked
  // into the source file itself — anything in video.textTracks that
  // isn't one of the <track> elements we rendered ourselves.
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const updateEmbedded = () => {
      const ownTracks = new Set(
        Array.from(ownTrackElsRef.current.values())
          .map((el) => el.track)
          .filter(Boolean)
      );
      const found: TextTrack[] = [];
      for (let i = 0; i < video.textTracks.length; i++) {
        const t = video.textTracks[i];
        if ((t.kind === "subtitles" || t.kind === "captions") && !ownTracks.has(t)) {
          found.push(t);
        }
      }
      setEmbeddedTracks(found);
    };
    updateEmbedded();
    video.textTracks.addEventListener("addtrack", updateEmbedded);
    video.textTracks.addEventListener("removetrack", updateEmbedded);
    return () => {
      video.textTracks.removeEventListener("addtrack", updateEmbedded);
      video.textTracks.removeEventListener("removetrack", updateEmbedded);
    };
  }, [movieUrl, subtitleUrls]);

  // Apply whichever subtitle the viewer picked. Purely local — everyone
  // in the room can pick a different subtitle (or audio track) for
  // themselves without affecting playback sync for the other person.
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    for (let i = 0; i < video.textTracks.length; i++) video.textTracks[i].mode = "disabled";
    if (subtitleSelection.startsWith("own:")) {
      const track = ownTrackElsRef.current.get(subtitleSelection.slice(4))?.track;
      if (track) track.mode = "showing";
    } else if (subtitleSelection.startsWith("embedded:")) {
      const track = embeddedTracks[Number(subtitleSelection.slice(9))];
      if (track) track.mode = "showing";
    }
  }, [subtitleSelection, embeddedTracks]);

  // Discover and manage in-band audio tracks (e.g. a dual-language file).
  // Only Chromium/Safari expose HTMLMediaElement.audioTracks — Firefox
  // doesn't, so the control simply won't appear there.
  useEffect(() => {
    const video = videoRef.current as MediaElementWithAudioTracks | null;
    const list = video?.audioTracks;
    if (!video || !list) {
      setAudioTracks([]);
      return;
    }
    const update = () => {
      const tracks: AudioTrackLike[] = [];
      let enabledId: string | null = null;
      for (let i = 0; i < list.length; i++) {
        const t = list[i];
        tracks.push(t);
        if (t.enabled) enabledId = t.id;
      }
      setAudioTracks(tracks);
      setSelectedAudioId(enabledId);
    };
    update();
    list.addEventListener("addtrack", update);
    list.addEventListener("removetrack", update);
    list.addEventListener("change", update);
    return () => {
      list.removeEventListener("addtrack", update);
      list.removeEventListener("removetrack", update);
      list.removeEventListener("change", update);
    };
  }, [movieUrl]);

  // Close the audio/subtitle dropdowns on any click outside them.
  useEffect(() => {
    if (!audioMenuOpen && !subsMenuOpen && !speedMenuOpen && !volumeMenuOpen) return;
    const onClick = (e: MouseEvent) => {
      if (avMenuWrapRef.current && !avMenuWrapRef.current.contains(e.target as Node)) {
        setAudioMenuOpen(false);
        setSubsMenuOpen(false);
        setSpeedMenuOpen(false);
        setVolumeMenuOpen(false);
      }
    };
    window.addEventListener("mousedown", onClick);
    return () => window.removeEventListener("mousedown", onClick);
  }, [audioMenuOpen, subsMenuOpen, speedMenuOpen, volumeMenuOpen]);

  const handleSelectAudioTrack = useCallback((id: string) => {
    const video = videoRef.current as MediaElementWithAudioTracks | null;
    const list = video?.audioTracks;
    if (!list) return;
    for (let i = 0; i < list.length; i++) list[i].enabled = list[i].id === id;
    setSelectedAudioId(id);
    setAudioMenuOpen(false);
  }, []);

  // Playback speed is a deliberate, immediate user choice — applied
  // directly rather than eased — but drift correction (above) needs to
  // keep nudging *around* whatever this is set to, not fight it back to
  // 1x. baseRateRef is what that code reads.
  const handleSelectSpeed = useCallback((speed: number) => {
    setPlaybackSpeed(speed);
    baseRateRef.current = speed;
    if (videoRef.current) videoRef.current.playbackRate = speed;
    setSpeedMenuOpen(false);
  }, []);

  const handleVolumeChange = useCallback((value: number) => {
    setVolume(value);
    if (value > 0 && muted) setMuted(false);
    if (value === 0 && !muted) setMuted(true);
  }, [muted]);

  const handleToggleMute = useCallback(() => {
    setMuted((m) => {
      if (!m) {
        preMuteVolumeRef.current = volume > 0 ? volume : 1;
      } else if (volume === 0) {
        setVolume(preMuteVolumeRef.current);
      }
      return !m;
    });
  }, [volume]);

  

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
          video.playbackRate = baseRateRef.current;
          setResyncing(true);
          video.currentTime = target;
          showNote("Resyncing…");
          setTimeout(() => setResyncing(false), 400);
        } else if (gap >= SMALL_DRIFT_THRESHOLD) {
          // Smooth catch-up: nudge playback speed slightly instead of
          // hard-jumping currentTime every heartbeat, which reads as a
          // visible stutter. The rate resets once the gap closes below
          // the threshold. Nudge is a multiplier on the chosen speed,
          // not an absolute rate, so catch-up still respects e.g. 1.5x.
          video.playbackRate =
            target > video.currentTime
              ? baseRateRef.current * NUDGE_RATE_FAST
              : baseRateRef.current * NUDGE_RATE_SLOW;
        } else if (Math.abs(video.playbackRate - baseRateRef.current) > 0.001) {
          video.playbackRate = baseRateRef.current;
        }
        break;
      }
      case "play": {
        if (isController) break;
        lastAuthoritativeSentAtRef.current = lastEvent.serverSentAt;
        const target = compensate(lastEvent.currentTime, lastEvent.serverSentAt, true);
        video.playbackRate = baseRateRef.current;
        video.currentTime = target;
        video.play().catch(() => setNeedsPlayGesture(true));
        break;
      }
      case "pause": {
        lastAuthoritativeSentAtRef.current = lastEvent.serverSentAt;
        video.playbackRate = baseRateRef.current;
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
        video.playbackRate = baseRateRef.current;
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
      video.playbackRate = baseRateRef.current;
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
    // Ignore the video's own playback-position updates while the host is
    // actively dragging the seek bar — otherwise this fires ~4x/sec and
    // keeps overwriting `current` with the live position, fighting the
    // drag in real time.
    if (isSeekDraggingRef.current) return;
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

  const handleSeekDragStart = () => {
    isSeekDraggingRef.current = true;
  };

  const handleSeekDragChange = (value: number) => {
    seekDragValueRef.current = value;
    setCurrent(value);
  };

  const handleSeekDragEnd = () => {
    if (!isSeekDraggingRef.current) return;
    isSeekDraggingRef.current = false;
    handleSeekCommit(seekDragValueRef.current);
  };

  // Fallback for a drag that ends outside the slider itself (pointer
  // dragged off the element before release) — the input's own onMouseUp/
  // onTouchEnd won't fire in that case, so this catches it at the window
  // level while a drag is in progress.
  useEffect(() => {
    const onWindowRelease = () => {
      if (isSeekDraggingRef.current) handleSeekDragEnd();
    };
    window.addEventListener("mouseup", onWindowRelease);
    window.addEventListener("touchend", onWindowRelease);
    return () => {
      window.removeEventListener("mouseup", onWindowRelease);
      window.removeEventListener("touchend", onWindowRelease);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isController]);

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

  // ── "Background audio" ──
  // Plain <video> playback on the web has no dedicated "keep the audio
  // going after backgrounding" permission — what actually keeps it alive
  // depends on the browser/OS. Picture-in-Picture is the one mechanism
  // that reliably works across both Android Chrome and iOS Safari (PiP
  // audio survives switching apps or locking the screen; a background
  // tab alone does not, especially on iOS). So: if playback is active
  // and the tab is hidden, auto-enter PiP rather than requiring the
  // person to have already tapped the PiP button themselves.
  useEffect(() => {
    const handleVisibility = () => {
      const video = videoRef.current;
      if (document.hidden && video && !video.paused && pipSupported && !document.pictureInPictureElement) {
        video.requestPictureInPicture().catch(() => {
          // Browser refused (needs a recent user gesture on some
          // browsers, or PiP is mid-transition already) — the person
          // can still enter it manually with the PiP button.
        });
      }
    };
    document.addEventListener("visibilitychange", handleVisibility);
    return () => document.removeEventListener("visibilitychange", handleVisibility);
  }, [pipSupported]);

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
        playbackRate: baseRateRef.current,
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
          ? `absolute inset-x-0 bottom-0 z-10 flex flex-wrap items-center gap-2 bg-gradient-to-t from-black/85 via-black/50 to-transparent px-3 pb-[calc(env(safe-area-inset-bottom)+0.75rem)] pt-10 transition-opacity duration-500 sm:gap-3 sm:px-5 sm:pb-[calc(env(safe-area-inset-bottom)+1rem)] ${
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
          onChange={(e) => handleSeekDragChange(Number(e.target.value))}
          onMouseDown={handleSeekDragStart}
          onTouchStart={handleSeekDragStart}
          onMouseUp={handleSeekDragEnd}
          onTouchEnd={handleSeekDragEnd}
          aria-label="Seek"
        />
        <span className="font-mono text-[10px] text-reel-muted sm:text-xs">
          {formatTime(duration)}
        </span>
      </div>

      {/* Volume, speed, audio track, and subtitle controls — purely local
          to each viewer, so all of these are available regardless of who's
          controlling playback. */}
      <div ref={avMenuWrapRef} className="flex shrink-0 items-center gap-1.5">
        {/* Volume */}
        <div className="relative flex items-center">
          <button
            onClick={handleToggleMute}
            onDoubleClick={() => setVolumeMenuOpen((v) => !v)}
            aria-label={muted || volume === 0 ? "Unmute" : "Mute"}
            title={muted || volume === 0 ? "Unmute" : "Mute"}
            className="flex h-7 w-7 items-center justify-center rounded-full text-reel-muted transition hover:text-reel-amber"
          >
            {muted || volume === 0 ? "🔇" : volume < 0.5 ? "🔉" : "🔊"}
          </button>
          <input
            type="range"
            aria-label="Volume"
            className="volumebar hidden w-16 sm:block"
            min={0}
            max={1}
            step={0.01}
            value={muted ? 0 : volume}
            onChange={(e) => handleVolumeChange(Number(e.target.value))}
          />
          {/* Narrow screens: same slider, but tucked into a popover behind
              the speaker icon instead of eating control-bar width. */}
          {volumeMenuOpen && (
            <div className="absolute bottom-full left-0 z-20 mb-2 rounded-lg border border-reel-border bg-reel-surface p-3 shadow-xl sm:hidden">
              <input
                type="range"
                aria-label="Volume"
                className="volumebar w-24"
                min={0}
                max={1}
                step={0.01}
                value={muted ? 0 : volume}
                onChange={(e) => handleVolumeChange(Number(e.target.value))}
              />
            </div>
          )}
        </div>

        {/* Playback speed */}
        <div className="relative">
          <button
            onClick={() => {
              setSpeedMenuOpen((v) => !v);
              setAudioMenuOpen(false);
              setSubsMenuOpen(false);
            }}
            aria-label="Playback speed"
            aria-expanded={speedMenuOpen}
            title="Playback speed"
            className={`flex h-7 items-center justify-center rounded-full border px-2 text-[11px] font-medium transition sm:text-xs ${
              speedMenuOpen || playbackSpeed !== 1
                ? "border-reel-amber text-reel-amber"
                : "border-reel-border text-reel-muted hover:border-reel-amber hover:text-reel-amber"
            }`}
          >
            {playbackSpeed}x
          </button>
          {speedMenuOpen && (
            <div className="absolute bottom-full right-0 z-20 mb-2 w-24 overflow-hidden rounded-lg border border-reel-border bg-reel-surface shadow-xl">
              <p className="border-b border-reel-border px-3 py-1.5 text-[10px] uppercase tracking-wide text-reel-muted">
                Speed
              </p>
              {[0.5, 0.75, 1, 1.25, 1.5, 1.75, 2].map((s) => (
                <button
                  key={s}
                  onClick={() => handleSelectSpeed(s)}
                  className={`block w-full px-3 py-2 text-left text-xs transition hover:bg-reel-surface2 ${
                    playbackSpeed === s ? "text-reel-amber" : "text-reel-text"
                  }`}
                >
                  {s}x{s === 1 ? " (normal)" : ""}
                </button>
              ))}
            </div>
          )}
        </div>

        {audioTracks.length > 1 && (
            <div className="relative">
              <button
                onClick={() => {
                  setAudioMenuOpen((v) => !v);
                  setSubsMenuOpen(false);
                }}
                aria-label="Audio track"
                aria-expanded={audioMenuOpen}
                title="Audio track"
                className={`flex h-7 items-center justify-center rounded-full border px-2.5 text-[11px] transition sm:text-xs ${
                  audioMenuOpen
                    ? "border-reel-amber text-reel-amber"
                    : "border-reel-border text-reel-muted hover:border-reel-amber hover:text-reel-amber"
                }`}
              >
                🔊
              </button>
              {audioMenuOpen && (
                <div className="absolute bottom-full right-0 z-20 mb-2 w-44 overflow-hidden rounded-lg border border-reel-border bg-reel-surface shadow-xl">
                  <p className="border-b border-reel-border px-3 py-1.5 text-[10px] uppercase tracking-wide text-reel-muted">
                    Audio
                  </p>
                  {audioTracks.map((t, i) => (
                    <button
                      key={t.id || i}
                      onClick={() => handleSelectAudioTrack(t.id)}
                      className={`block w-full px-3 py-2 text-left text-xs transition hover:bg-reel-surface2 ${
                        selectedAudioId === t.id ? "text-reel-amber" : "text-reel-text"
                      }`}
                    >
                      {t.label || t.language || `Track ${i + 1}`}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}

          {(subtitleMeta.length > 0 || embeddedTracks.length > 0) && (
            <div className="relative">
              <button
                onClick={() => {
                  setSubsMenuOpen((v) => !v);
                  setAudioMenuOpen(false);
                }}
                aria-label="Subtitles"
                aria-expanded={subsMenuOpen}
                title="Subtitles"
                className={`flex h-7 items-center justify-center rounded-full border px-2.5 text-[11px] font-medium transition sm:text-xs ${
                  subsMenuOpen || subtitleSelection !== "off"
                    ? "border-reel-amber text-reel-amber"
                    : "border-reel-border text-reel-muted hover:border-reel-amber hover:text-reel-amber"
                }`}
              >
                CC
              </button>
              {subsMenuOpen && (
                <div className="absolute bottom-full right-0 z-20 mb-2 w-48 overflow-hidden rounded-lg border border-reel-border bg-reel-surface shadow-xl">
                  <p className="border-b border-reel-border px-3 py-1.5 text-[10px] uppercase tracking-wide text-reel-muted">
                    Subtitles
                  </p>
                  <button
                    onClick={() => {
                      setSubtitleSelection("off");
                      setSubsMenuOpen(false);
                    }}
                    className={`block w-full px-3 py-2 text-left text-xs transition hover:bg-reel-surface2 ${
                      subtitleSelection === "off" ? "text-reel-amber" : "text-reel-text"
                    }`}
                  >
                    Off
                  </button>
                  {subtitleMeta.map((sub) => (
                    <button
                      key={sub.id}
                      onClick={() => {
                        setSubtitleSelection(`own:${sub.id}`);
                        setSubsMenuOpen(false);
                      }}
                      disabled={!subtitleUrls[sub.id]}
                      className={`block w-full px-3 py-2 text-left text-xs transition hover:bg-reel-surface2 disabled:cursor-wait disabled:opacity-40 ${
                        subtitleSelection === `own:${sub.id}` ? "text-reel-amber" : "text-reel-text"
                      }`}
                    >
                      {sub.label}
                      {!subtitleUrls[sub.id] ? " (loading…)" : ""}
                    </button>
                  ))}
                  {embeddedTracks.map((t, i) => (
                    <button
                      key={i}
                      onClick={() => {
                        setSubtitleSelection(`embedded:${i}`);
                        setSubsMenuOpen(false);
                      }}
                      className={`block w-full px-3 py-2 text-left text-xs transition hover:bg-reel-surface2 ${
                        subtitleSelection === `embedded:${i}` ? "text-reel-amber" : "text-reel-text"
                      }`}
                    >
                      {t.label || t.language || `Track ${i + 1}`}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
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
        >
          {subtitleMeta.map(
            (sub) =>
              subtitleUrls[sub.id] && (
                <track
                  key={sub.id}
                  ref={(el) => {
                    if (el) ownTrackElsRef.current.set(sub.id, el);
                    else ownTrackElsRef.current.delete(sub.id);
                  }}
                  kind="subtitles"
                  src={subtitleUrls[sub.id]}
                  label={sub.label}
                  srcLang={sub.lang || "en"}
                />
              )
          )}
        </video>

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

        {/* Fullscreen reactions: floating bubbles (decorative, pass-through)
            + a quick-tap bar, embedded in this element's subtree for the
            same reason as the chat overlay above.
            The tap bar is a vertical strip on the right edge rather than
            a bottom-center pill on purpose: bottom-center collides with
            both the control bar (bottom-0) and the chat input pill
            (also bottom-anchored) whenever either is visible. Anchoring
            to the vertical center of the right edge stays clear of both
            in portrait AND landscape, and doesn't need to track the
            control bar's show/hide state. */}
        {isFullscreen && (
          <div className="pointer-events-none absolute inset-0 z-10">
            <div className="pointer-events-none absolute inset-x-0 bottom-0 h-full overflow-hidden">
              {bubbles.map((b) => (
                <span
                  key={b.id}
                  onAnimationEnd={() => onRemoveBubble(b.id)}
                  className="absolute bottom-24 flex animate-floatUp items-end gap-0.5 text-4xl drop-shadow-lg"
                  style={{ left: `${b.left}%` }}
                >
                  {b.emoji}
                  {b.count && b.count > 1 && (
                    <span className="mb-1 rounded-full bg-black/60 px-1.5 py-0.5 text-xs font-bold text-reel-text">
                      ×{b.count}
                    </span>
                  )}
                </span>
              ))}
            </div>
            <div
              className="pointer-events-auto absolute right-2 top-1/2 flex -translate-y-1/2 flex-col items-center gap-2.5 rounded-full bg-black/30 px-1.5 py-2.5 backdrop-blur-sm sm:right-3 sm:gap-3 sm:px-2 sm:py-3"
              style={{ marginRight: "env(safe-area-inset-right)" }}
            >
              {["❤️", "😂", "😮", "🔥", "👏", "😢"].map((emoji) => (
                <button
                  key={emoji}
                  onClick={() => onTapEmoji(emoji)}
                  className="flex h-8 w-8 items-center justify-center rounded-full text-xl transition hover:scale-110 active:scale-95 sm:h-9 sm:w-9 sm:text-2xl"
                  aria-label={`React with ${emoji}`}
                >
                  {emoji}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Mic (push-to-talk) — small transparent icon, opposite corner
            from the chat toggle below, reachable in both fullscreen
            orientations since it's corner-anchored to this element, which
            fills the screen in both portrait and landscape. */}
        {isFullscreen && ptt && (
          <div
            className="absolute left-2 top-2 flex gap-2 sm:left-3 sm:top-3"
            style={{ marginLeft: "env(safe-area-inset-left)", marginTop: "env(safe-area-inset-top)" }}
          >
            <button
              onPointerDown={ptt.status === "failed" ? undefined : handleMicDown}
              onPointerUp={ptt.status === "failed" ? undefined : handleMicUp}
              onPointerCancel={ptt.status === "failed" ? undefined : handleMicUp}
              onClick={ptt.status === "failed" ? ptt.onRetry : undefined}
              onContextMenu={(e) => e.preventDefault()}
              disabled={ptt.status !== "connected" && ptt.status !== "failed"}
              aria-pressed={ptt.isTalking}
              aria-label={
                ptt.status === "failed"
                  ? "Retry voice connection"
                  : ptt.isTalking
                    ? "Release to stop talking"
                    : "Hold to talk"
              }
              title={
                ptt.status === "failed"
                  ? "Voice unavailable — tap to retry"
                  : (ptt.error ??
                    (ptt.status !== "connected" ? "Voice unavailable" : ptt.isTalking ? "Talking…" : "Hold to talk"))
              }
              className={`flex h-9 w-9 select-none items-center justify-center rounded-full backdrop-blur transition sm:h-8 sm:w-8 ${
                ptt.status === "failed"
                  ? "bg-reel-rose/20 text-reel-rose hover:bg-reel-rose/30"
                  : ptt.status !== "connected"
                    ? "cursor-not-allowed bg-black/30 text-reel-text/40"
                    : ptt.isTalking
                      ? "bg-reel-amber text-reel-bg animate-pulseGlow"
                      : ptt.partnerTalking
                        ? "bg-black/30 text-reel-amber"
                        : "bg-black/30 text-reel-text hover:bg-black/50"
              }`}
              style={{ touchAction: "none" }}
            >
              <span className="text-sm">{ptt.status === "failed" ? "↻" : ptt.isTalking ? "🔴" : "🎙️"}</span>
            </button>
          </div>
        )}

        {/* Fullscreen / PiP / chat-toggle controls float over the video
            itself so they're reachable even while the bottom control bar
            is off-screen in fullscreen mode. */}
        <div
          className="absolute right-2 top-2 flex gap-2 sm:right-3 sm:top-3"
          style={
            isFullscreen
              ? { marginRight: "env(safe-area-inset-right)", marginTop: "env(safe-area-inset-top)" }
              : undefined
          }
        >
          {isFullscreen && (
            <button
              onClick={() => setFullscreenChatEnabled((v) => !v)}
              aria-label={fullscreenChatEnabled ? "Disable chat" : "Enable chat"}
              aria-pressed={fullscreenChatEnabled}
              title={fullscreenChatEnabled ? "Disable chat" : "Enable chat"}
              className={`flex h-9 w-9 items-center justify-center rounded-full backdrop-blur transition sm:h-8 sm:w-8 ${
                fullscreenChatEnabled
                  ? "bg-reel-amber text-reel-bg"
                  : "bg-black/30 text-reel-text hover:bg-black/50"
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
              className="flex h-9 w-9 items-center justify-center rounded-full bg-black/60 text-reel-text backdrop-blur transition hover:bg-black/80 sm:h-8 sm:w-8"
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
            className="flex h-9 w-9 items-center justify-center rounded-full bg-black/60 text-reel-text backdrop-blur transition hover:bg-black/80 sm:h-8 sm:w-8"
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
