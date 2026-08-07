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

  const channelRef = useRef<RealtimeChannel | null>(null);
  const pcRef = useRef<RTCPeerConnection | null>(null);
  const audioSenderRef = useRef<RTCRtpSender | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const remoteAudioElRef = useRef<HTMLAudioElement | null>(null);
  const pendingCandidatesRef = useRef<RTCIceCandidateInit[]>([]);
  const makingOfferRef = useRef(false);

  const supported =
    typeof window !== "undefined" && !!window.RTCPeerConnection && !!navigator.mediaDevices?.getUserMedia;

  const attachRemoteStream = useCallback((stream: MediaStream) => {
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
    remoteAudioElRef.current.srcObject = stream;
    remoteAudioElRef.current.play().catch(() => {
      // Autoplay can be blocked without a prior user gesture on the page.
      // By the time a partner's track arrives, the person has already
      // clicked "join room", so this is a rare edge case — surfacing an
      // error here would just be noise.
    });
  }, []);

  const detachRemoteStream = useCallback(() => {
    if (remoteAudioElRef.current) {
      remoteAudioElRef.current.srcObject = null;
      remoteAudioElRef.current.remove();
      remoteAudioElRef.current = null;
    }
  }, []);

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
    setPartnerTalking(false);
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
      else if (pc.connectionState === "disconnected") setStatus("connecting");
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

    channel.on("broadcast", { event: "offer" }, ({ payload }) => handleOffer(payload as SignalPayload));
    channel.on("broadcast", { event: "answer" }, ({ payload }) => handleAnswer(payload as SignalPayload));
    channel.on("broadcast", { event: "ice" }, ({ payload }) => handleIce(payload as SignalPayload));
    channel.on("broadcast", { event: "talk" }, ({ payload }) => {
      const p = payload as SignalPayload;
      if (p.from !== myName) setPartnerTalking(!!p.talking);
    });

    channel.subscribe();

    return () => {
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
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        localStreamRef.current = stream;
        const track = stream.getAudioTracks()[0];
        await audioSenderRef.current.replaceTrack(track);
      }
      localStreamRef.current.getAudioTracks().forEach((t) => (t.enabled = true));
      setIsTalking(true);
      channelRef.current?.send({
        type: "broadcast",
        event: "talk",
        payload: { from: myName, talking: true } satisfies SignalPayload,
      });
    } catch {
      setError("Couldn't access your microphone — check your browser's site permissions.");
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

  return { status, isTalking, partnerTalking, error, startTalking, stopTalking };
}
