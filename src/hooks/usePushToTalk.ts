import { useCallback, useEffect, useRef, useState } from "react";
import type { RealtimeChannel } from "@supabase/supabase-js";
import { supabase } from "@/lib/supabase/client";

// Public STUN-only config. No TURN server, so this works on most home
// networks (same-NAT, typical router NAT) but can fail behind symmetric
// NATs / restrictive corporate networks, where a relay would be needed.
// See the README section this hook ships with for what to add if that
// turns out to matter for you.
const ICE_SERVERS: RTCIceServer[] = [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:stun1.l.google.com:19302" },
];

export type PttStatus =
  | "idle" // no partner in the room yet, nothing to connect to
  | "connecting" // partner present, ICE/SDP handshake in progress
  | "connected" // peer connection is up, ready to talk
  | "failed" // handshake or ICE failed (likely NAT traversal)
  | "unsupported"; // WebRTC/getUserMedia not available in this browser

interface UsePushToTalkOptions {
  roomCode: string;
  myName: string;
  partnerName: string | null;
  // Reuses the room's fixed host/controller role as the WebRTC offer
  // initiator, purely to avoid a second "who goes first" election —
  // it has nothing to do with playback control. The non-host is the
  // "polite" peer in perfect-negotiation terms below.
  isHost: boolean;
}

interface SignalPayload {
  from: string;
  sdp?: RTCSessionDescriptionInit;
  candidate?: RTCIceCandidateInit;
  talking?: boolean;
}

/**
 * Peer-to-peer voice between the two people in a room. WebRTC carries the
 * actual audio; a Supabase Realtime broadcast channel (same mechanism
 * useRoomSync uses for its heartbeat, just its own channel) carries only
 * the signaling: SDP offer/answer and ICE candidates. Nothing here touches
 * Postgres — no new tables, this is transient handshake traffic.
 *
 * The mic is only opened on the first `startTalking()` call. After that,
 * holding/releasing the button just flips `track.enabled` on the already-
 * granted stream, so there's one permission prompt per session, not one
 * per press. Trade-off: the browser's mic-in-use indicator stays on for
 * the rest of the session once you've talked at least once, even while
 * muted between holds, since the track is enabled/disabled rather than
 * stopped/restarted.
 */
export function usePushToTalk({ roomCode, myName, partnerName, isHost }: UsePushToTalkOptions) {
  const [status, setStatus] = useState<PttStatus>("idle");
  const [isTalking, setIsTalking] = useState(false);
  const [partnerTalking, setPartnerTalking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // How loud the *partner's voice* plays, independent of movie volume —
  // persisted since it's a personal comfort preference, same spirit as
  // remembering a chosen movie volume would be if that existed too.
  const [callVolume, setCallVolumeState] = useState(() => {
    if (typeof window === "undefined") return 1;
    const saved = window.localStorage.getItem("specwatch:call-volume");
    const parsed = saved ? Number(saved) : NaN;
    return Number.isFinite(parsed) && parsed >= 0 && parsed <= 1 ? parsed : 1;
  });
  const setCallVolume = useCallback((v: number) => {
    const clamped = Math.min(1, Math.max(0, v));
    setCallVolumeState(clamped);
    try {
      window.localStorage.setItem("specwatch:call-volume", String(clamped));
    } catch {
      // Not fatal — the slider still works for this session either way.
    }
  }, []);

  const channelRef = useRef<RealtimeChannel | null>(null);
  const pcRef = useRef<RTCPeerConnection | null>(null);
  const audioSenderRef = useRef<RTCRtpSender | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const remoteAudioElRef = useRef<HTMLAudioElement | null>(null);
  const pendingCandidatesRef = useRef<RTCIceCandidateInit[]>([]);
  const makingOfferRef = useRef(false);
  // Safety net for bug #4 below: if a "stopped talking" broadcast is ever
  // lost (tab crash, connection drop mid-press), this force-clears the
  // partner-talking indicator instead of leaving it stuck forever.
  const partnerTalkingTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const supported =
    typeof window !== "undefined" && !!window.RTCPeerConnection && !!navigator.mediaDevices?.getUserMedia;

  const attachRemoteStream = useCallback(
    (stream: MediaStream) => {
      if (!remoteAudioElRef.current) {
        const el = document.createElement("audio");
        el.autoplay = true;
        // Not in the DOM lib's HTMLAudioElement type, but harmless/ignored
        // on audio elements anyway — kept only for safety on browsers that
        // treat this element as video-like internally.
        el.setAttribute("playsinline", "true");
        el.style.display = "none";
        document.body.appendChild(el);
        remoteAudioElRef.current = el;
      }
      remoteAudioElRef.current.volume = callVolume;
      remoteAudioElRef.current.srcObject = stream;
      remoteAudioElRef.current.play().catch(() => {
        // Autoplay can be blocked without a prior user gesture on the page.
        // By the time a partner's track arrives, the person has already
        // clicked "join room", so this is a rare edge case — surfacing an
        // error here would just be noise.
      });
    },
    [callVolume]
  );

  const detachRemoteStream = useCallback(() => {
    if (remoteAudioElRef.current) {
      remoteAudioElRef.current.srcObject = null;
      remoteAudioElRef.current.remove();
      remoteAudioElRef.current = null;
    }
  }, []);

  // Applies live if the slider moves mid-call — attachRemoteStream only
  // sets .volume at the moment a track first arrives, so without this,
  // adjusting the slider while already connected would silently do
  // nothing until the next reconnect.
  useEffect(() => {
    if (remoteAudioElRef.current) remoteAudioElRef.current.volume = callVolume;
  }, [callVolume]);

  const flushPendingCandidates = useCallback(async (pc: RTCPeerConnection) => {
    const queued = pendingCandidatesRef.current;
    pendingCandidatesRef.current = [];
    for (const candidate of queued) {
      try {
        await pc.addIceCandidate(candidate);
      } catch {
        // Benign — a stale/duplicate candidate arriving after renegotiation.
      }
    }
  }, []);

  const teardownConnection = useCallback(() => {
    pcRef.current?.close();
    pcRef.current = null;
    audioSenderRef.current = null;
    pendingCandidatesRef.current = [];
    makingOfferRef.current = false;
    detachRemoteStream();
    if (partnerTalkingTimeoutRef.current) {
      clearTimeout(partnerTalkingTimeoutRef.current);
      partnerTalkingTimeoutRef.current = null;
    }
    setPartnerTalking(false);
    // The connection this was tied to is gone — a fresh one (if/when the
    // partner reconnects) will need a brand-new sender with the track
    // reattached via startTalking(). Leaving isTalking stuck true here
    // would show the mic as still "active" after a disconnect, and a
    // subsequent tap would try to *stop* a track that was never attached
    // to the new connection in the first place, instead of starting
    // cleanly. Also release the actual track, matching what stopTalking
    // does — no reason for it to stay enabled on hardware pointed at a
    // connection that no longer exists.
    localStreamRef.current?.getAudioTracks().forEach((t) => (t.enabled = false));
    setIsTalking(false);
  }, [detachRemoteStream]);

  const setupConnection = useCallback(() => {
    if (!supported || pcRef.current) return;
    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    pcRef.current = pc;
    setStatus("connecting");
    setError(null);

    // Reserves an audio m-line in the SDP up front so the offer/answer
    // handshake doesn't depend on the mic ever having been opened —
    // that's deferred to the first press of the button.
    const transceiver = pc.addTransceiver("audio", { direction: "sendrecv" });
    audioSenderRef.current = transceiver.sender;

    pc.onicecandidate = (e) => {
      if (e.candidate) {
        channelRef.current?.send({
          type: "broadcast",
          event: "ice",
          payload: { from: myName, candidate: e.candidate.toJSON() } satisfies SignalPayload,
        });
      }
    };

    pc.ontrack = (e) => {
      if (e.streams[0]) attachRemoteStream(e.streams[0]);
    };

    pc.onconnectionstatechange = () => {
      if (pc.connectionState === "connected") setStatus("connected");
      else if (pc.connectionState === "failed" || pc.connectionState === "closed") setStatus("failed");
      else if (pc.connectionState === "disconnected") {
        setStatus("connecting");
        // "disconnected" can self-recover on its own within a few
        // seconds (a brief WiFi blip), but often doesn't without an
        // explicit nudge — left alone, the browser eventually times out
        // to "failed" on its own clock (which can take 20-30+ seconds),
        // requiring a manual retry tap for what might've been a
        // recoverable hiccup. Only the host restarts ICE: per spec,
        // restartIce() only meaningfully does something on the side
        // that creates offers, which is only ever the host here — the
        // non-host just reacts normally to whatever offer results.
        if (isHost) {
          try {
            pc.restartIce();
          } catch {
            // Not fatal — worst case this behaves as it did before,
            // waiting for the browser's own failure timeout.
          }
        }
      }
    };

    // Only the fixed initiator (host) drives offers, so the two sides
    // never race to both send one.
    pc.onnegotiationneeded = async () => {
      if (!isHost) return;
      try {
        makingOfferRef.current = true;
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        channelRef.current?.send({
          type: "broadcast",
          event: "offer",
          payload: { from: myName, sdp: pc.localDescription! } satisfies SignalPayload,
        });
      } catch {
        setError("Couldn't set up the voice connection.");
        setStatus("failed");
      } finally {
        makingOfferRef.current = false;
      }
    };
  }, [supported, isHost, myName, attachRemoteStream]);

  const handleOffer = useCallback(
    async ({ from, sdp }: SignalPayload) => {
      if (from === myName || !sdp) return;
      if (!pcRef.current) setupConnection();
      const pc = pcRef.current;
      if (!pc) return;

      // Perfect-negotiation glare handling: the host is "impolite" (its
      // own in-flight offer wins), the non-host is "polite" (defers to
      // an incoming offer even if it was also about to send one).
      const offerCollision = makingOfferRef.current || pc.signalingState !== "stable";
      if (isHost && offerCollision) return;

      await pc.setRemoteDescription(sdp);
      await flushPendingCandidates(pc);
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      channelRef.current?.send({
        type: "broadcast",
        event: "answer",
        payload: { from: myName, sdp: pc.localDescription! } satisfies SignalPayload,
      });
    },
    [myName, isHost, setupConnection, flushPendingCandidates]
  );

  const handleAnswer = useCallback(
    async ({ from, sdp }: SignalPayload) => {
      if (from === myName || !sdp || !pcRef.current) return;
      await pcRef.current.setRemoteDescription(sdp);
      await flushPendingCandidates(pcRef.current);
    },
    [myName, flushPendingCandidates]
  );

  const handleIce = useCallback(
    async ({ from, candidate }: SignalPayload) => {
      if (from === myName || !candidate) return;
      const pc = pcRef.current;
      if (!pc) return;
      if (!pc.remoteDescription) {
        pendingCandidatesRef.current.push(candidate);
        return;
      }
      try {
        await pc.addIceCandidate(candidate);
      } catch {
        // Benign — see flushPendingCandidates.
      }
    },
    []
  );

  // ── Signaling channel: its own broadcast channel, same pattern as the
  // sync heartbeat, just carrying WebRTC handshake messages instead of
  // playback events. ──
  useEffect(() => {
    if (!roomCode || !myName || !supported) {
      if (!supported) setStatus("unsupported");
      return;
    }

    const channel = supabase.channel(`ptt-signal:${roomCode}`);
    channelRef.current = channel;
    let cancelled = false;

    channel.on("broadcast", { event: "offer" }, ({ payload }) => handleOffer(payload as SignalPayload));
    channel.on("broadcast", { event: "answer" }, ({ payload }) => handleAnswer(payload as SignalPayload));
    channel.on("broadcast", { event: "ice" }, ({ payload }) => handleIce(payload as SignalPayload));
    channel.on("broadcast", { event: "talk" }, ({ payload }) => {
      const p = payload as SignalPayload;
      if (p.from === myName) return;
      if (partnerTalkingTimeoutRef.current) {
        clearTimeout(partnerTalkingTimeoutRef.current);
        partnerTalkingTimeoutRef.current = null;
      }
      setPartnerTalking(!!p.talking);
      if (p.talking) {
        // If the matching "talk: false" never arrives (their tab closed,
        // connection dropped mid-press), don't leave the indicator stuck
        // on indefinitely — presence will eventually catch a real
        // disconnect, but this covers the gap before that happens.
        partnerTalkingTimeoutRef.current = setTimeout(() => setPartnerTalking(false), 15000);
      }
    });

    // Without this, a signaling-channel failure (Realtime disabled,
    // connection-limit hit, transient network issue at subscribe time)
    // looks identical to a normal slow handshake — status just sits on
    // whatever it already was, forever, since the RTCPeerConnection
    // itself has no way to know the offer/answer it's waiting on was
    // never actually deliverable. This gives that failure mode its own
    // visible "failed" state instead of silently stalling.
    channel.subscribe((subStatus) => {
      if (cancelled) return;
      if (subStatus === "CHANNEL_ERROR" || subStatus === "TIMED_OUT") {
        setStatus("failed");
        setError("Couldn't reach the voice signaling server. Try again.");
      }
    });

    return () => {
      cancelled = true;
      supabase.removeChannel(channel);
      channelRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roomCode, myName, supported]);

  // ── Peer connection lifecycle: set up once a partner is in the room,
  // tear down when they leave (they'll need a fresh handshake if/when
  // they come back — their old peer connection is gone too). ──
  useEffect(() => {
    if (!partnerName || !supported) {
      teardownConnection();
      setStatus(supported ? "idle" : "unsupported");
      return;
    }
    setupConnection();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [partnerName, supported]);

  // Full cleanup on unmount — release the mic hardware, not just mute it.
  useEffect(() => {
    return () => {
      localStreamRef.current?.getTracks().forEach((t) => t.stop());
      localStreamRef.current = null;
      teardownConnection();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const startTalking = useCallback(async () => {
    if (!pcRef.current || !audioSenderRef.current) return;
    setError(null);
    try {
      if (!localStreamRef.current) {
        // Explicit rather than relying on browser defaults — these are
        // usually on by default anyway, but "usually" isn't "always"
        // across every browser/device combination, and getting this
        // wrong specifically hurts a voice-chat feature (echo, background
        // hiss) more than it would most other getUserMedia uses.
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        });
        localStreamRef.current = stream;
      }
      const track = localStreamRef.current.getAudioTracks()[0];
      // Attach on every call, not just the first ever — a reconnect
      // (partner rejoining, ICE restart, etc.) creates a brand-new
      // RTCPeerConnection and RTCRtpSender, but the mic stream itself is
      // only requested once per session. Without re-attaching here, a
      // fresh sender would carry no track at all and the partner would
      // hear silence, even though everything looks "connected" locally.
      // replaceTrack is safe to call repeatedly; the `!==` check just
      // avoids a redundant call on the common case (same sender, same
      // track, held again).
      if (audioSenderRef.current.track !== track) {
        await audioSenderRef.current.replaceTrack(track);
      }
      track.enabled = true;
      setIsTalking(true);
      channelRef.current?.send({
        type: "broadcast",
        event: "talk",
        payload: { from: myName, talking: true } satisfies SignalPayload,
      });
    } catch (err) {
      // Distinguish the actual failure instead of always blaming the mic —
      // getUserMedia and replaceTrack fail for different reasons, and a
      // bare catch was previously showing a permissions message even when
      // the real problem was the WebRTC connection.
      const name = err instanceof DOMException ? err.name : undefined;
      if (name === "NotAllowedError" || name === "SecurityError") {
        setError("Microphone access was blocked — check your browser's site permissions.");
      } else if (name === "NotFoundError") {
        setError("No microphone was found on this device.");
      } else if (name === "NotReadableError") {
        setError("Your microphone is already in use by another app.");
      } else {
        setError("Couldn't start the voice connection. Try again.");
      }
    }
  }, [myName]);

  const stopTalking = useCallback(() => {
    localStreamRef.current?.getAudioTracks().forEach((t) => (t.enabled = false));
    setIsTalking(false);
    channelRef.current?.send({
      type: "broadcast",
      event: "talk",
      payload: { from: myName, talking: false } satisfies SignalPayload,
    });
  }, [myName]);

  const retry = useCallback(() => {
    teardownConnection();
    setupConnection();
  }, [teardownConnection, setupConnection]);

  return {
    status,
    isTalking,
    partnerTalking,
    error,
    startTalking,
    stopTalking,
    retry,
    callVolume,
    setCallVolume,
  };
}
