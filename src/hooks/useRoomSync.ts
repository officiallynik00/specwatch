import { useCallback, useEffect, useRef, useState } from "react";
import type { RealtimeChannel } from "@supabase/supabase-js";
import { supabase } from "@/lib/supabase/client";
import type { PresenceState, Room, SyncEvent } from "@/lib/types";

const HEARTBEAT_INTERVAL_MS = 4000;
const DB_PERSIST_INTERVAL_MS = 10000;

export type ConnectionStatus =
  | "connecting" // initial channel subscribe hasn't resolved yet
  | "both-connected"
  | "waiting-for-partner" // nobody but you has ever joined this session
  | "partner-away" // partner joined earlier, then their connection dropped
  | "reconnecting"; // our own realtime socket dropped and is retrying

interface UseRoomSyncOptions {
  roomCode: string;
  myName: string;
  // Only the lobby screen passes true. Handles the rare case of a room
  // row created before `host_name` existed (or created some other way)
  // by letting the first person who lands in the lobby claim the host
  // seat. Ordinary rooms already have host_name set at creation time, so
  // this is just a safety net, not the primary way hosts get assigned.
  claimHostIfUnset?: boolean;
}

/**
 * Owns the room's realtime channel: presence (who's here), the
 * broadcast stream for high-frequency sync events (heartbeat, play,
 * pause, seek, emoji), and light persistence of playback position back
 * to the `rooms` row.
 *
 * Control is fixed: whoever created the room is `host_name` on the row,
 * and that never changes hands mid-session. `isController` (and its
 * alias `isHost`) both just mean "myName === room.host_name".
 *
 * The actual <video> element lives in VideoPlayer — this hook just
 * hands it events to react to via `lastEvent`, and functions to
 * announce local actions.
 */
export function useRoomSync({ roomCode, myName, claimHostIfUnset = false }: UseRoomSyncOptions) {
  const [room, setRoom] = useState<Room | null>(null);
  const [loading, setLoading] = useState(true);
  const [lastEvent, setLastEvent] = useState<SyncEvent | null>(null);
  const [presentNames, setPresentNames] = useState<string[]>([]);
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>("connecting");
  const [reconnectAttempts, setReconnectAttempts] = useState(0);
  const [isChannelReconnecting, setIsChannelReconnecting] = useState(false);

  const channelRef = useRef<RealtimeChannel | null>(null);
  const roomIdRef = useRef<string | null>(null);
  const lastPersistRef = useRef(0);
  const partnerEverJoinedRef = useRef(false);
  const hasSubscribedOnceRef = useRef(false);

  const partnerName = presentNames.find((n) => n !== myName) ?? null;
  const isHost = !!myName && room?.host_name === myName;
  // Kept as `isController` too — it's the name VideoPlayer/PlayerScreen
  // use, and "controller" is still an accurate word for what the host is
  // doing; there's just no longer a way to become one other than being
  // the host.
  const isController = isHost;

  // ── Initial load + row subscription (movie uploads, host claim) ──
  useEffect(() => {
    let cancelled = false;

    async function load() {
      const { data } = await supabase
        .from("rooms")
        .select("*")
        .eq("code", roomCode)
        .maybeSingle();

      if (cancelled) return;
      if (data) {
        setRoom(data as Room);
        roomIdRef.current = data.id;
        if (claimHostIfUnset && !data.host_name && myName) {
          await supabase
            .from("rooms")
            .update({ host_name: myName })
            .eq("id", data.id)
            .is("host_name", null);
        }
      }
      setLoading(false);
    }
    load();

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roomCode]);

  useEffect(() => {
    if (!room?.id) return;
    const sub = supabase
      .channel(`room-row-${room.id}`)
      .on(
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: "rooms", filter: `id=eq.${room.id}` },
        (payload) => setRoom(payload.new as Room)
      )
      .subscribe();

    return () => {
      supabase.removeChannel(sub);
    };
  }, [room?.id]);

  // ── Realtime channel: presence + broadcast ──
  useEffect(() => {
    if (!roomCode || !myName) return;

    const channel = supabase.channel(`room:${roomCode}`, {
      config: { presence: { key: myName } },
    });
    channelRef.current = channel;

    channel.on("presence", { event: "sync" }, () => {
      const state = channel.presenceState<PresenceState>();
      const names = Object.values(state)
        .flat()
        .map((p) => p.name);
      setPresentNames(Array.from(new Set(names)));
    });

    channel.on("broadcast", { event: "sync" }, ({ payload }) => {
      setLastEvent(payload as SyncEvent);
    });

    channel.subscribe(async (status) => {
      if (status === "SUBSCRIBED") {
        hasSubscribedOnceRef.current = true;
        setReconnectAttempts(0);
        setIsChannelReconnecting(false);
        await channel.track({ name: myName, onlineAt: Date.now() } satisfies PresenceState);
      } else if (hasSubscribedOnceRef.current) {
        // We were connected before and the socket dropped (CLOSED,
        // CHANNEL_ERROR, TIMED_OUT). Supabase's realtime client retries
        // the underlying socket on its own — we just reflect that state
        // in the UI instead of silently leaving people on a stale
        // "both here" badge.
        setIsChannelReconnecting(true);
        setReconnectAttempts((n) => n + 1);
      }
    });

    return () => {
      supabase.removeChannel(channel);
    };
  }, [roomCode, myName]);

  // ── Connection status derived from presence + channel health ──
  useEffect(() => {
    if (isChannelReconnecting) {
      setConnectionStatus("reconnecting");
      return;
    }
    if (presentNames.length >= 2) {
      partnerEverJoinedRef.current = true;
      setConnectionStatus("both-connected");
    } else if (presentNames.length === 1) {
      setConnectionStatus(partnerEverJoinedRef.current ? "partner-away" : "waiting-for-partner");
    } else {
      setConnectionStatus("connecting");
    }
  }, [presentNames, isChannelReconnecting]);

  const broadcast = useCallback((event: SyncEvent) => {
    channelRef.current?.send({ type: "broadcast", event: "sync", payload: event });
  }, []);

  const persistPlaybackState = useCallback(
    async (currentTime: number, isPlaying: boolean, force = false) => {
      const now = Date.now();
      if (!force && now - lastPersistRef.current < DB_PERSIST_INTERVAL_MS) return;
      lastPersistRef.current = now;
      if (!roomIdRef.current) return;
      await supabase
        .from("rooms")
        .update({
          last_position_seconds: currentTime,
          is_playing: isPlaying,
          last_heartbeat_at: new Date().toISOString(),
        })
        .eq("id", roomIdRef.current);
    },
    []
  );

  const broadcastPlay = useCallback(
    (currentTime: number) => {
      broadcast({ type: "play", currentTime, controllerName: myName, serverSentAt: Date.now() });
      persistPlaybackState(currentTime, true, true);
    },
    [broadcast, myName, persistPlaybackState]
  );

  const broadcastPause = useCallback(
    (currentTime: number) => {
      broadcast({ type: "pause", currentTime, by: myName, serverSentAt: Date.now() });
      persistPlaybackState(currentTime, false, true);
    },
    [broadcast, myName, persistPlaybackState]
  );

  const broadcastSeek = useCallback(
    (currentTime: number) => {
      broadcast({ type: "seek", currentTime, controllerName: myName, serverSentAt: Date.now() });
      persistPlaybackState(currentTime, room?.is_playing ?? false, true);
    },
    [broadcast, myName, persistPlaybackState, room?.is_playing]
  );

  const broadcastHeartbeat = useCallback(
    (currentTime: number, isPlaying: boolean) => {
      broadcast({
        type: "heartbeat",
        currentTime,
        isPlaying,
        controllerName: myName,
        serverSentAt: Date.now(),
      });
      persistPlaybackState(currentTime, isPlaying);
    },
    [broadcast, myName, persistPlaybackState]
  );

  const sendEmoji = useCallback(
    (emoji: string) => {
      broadcast({ type: "emoji", emoji, by: myName, id: crypto.randomUUID() });
    },
    [broadcast, myName]
  );

  return {
    room,
    loading,
    lastEvent,
    presentNames,
    partnerName,
    isHost,
    isController,
    connectionStatus,
    reconnectAttempts,
    heartbeatIntervalMs: HEARTBEAT_INTERVAL_MS,
    broadcastPlay,
    broadcastPause,
    broadcastSeek,
    broadcastHeartbeat,
    sendEmoji,
    persistPlaybackState,
  };
}
