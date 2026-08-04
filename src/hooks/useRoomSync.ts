import { useCallback, useEffect, useRef, useState } from "react";
import type { RealtimeChannel } from "@supabase/supabase-js";
import { supabase } from "@/lib/supabase/client";
import type { PresenceState, Room, SyncEvent } from "@/lib/types";

const HEARTBEAT_INTERVAL_MS = 4000;
const DB_PERSIST_INTERVAL_MS = 10000;

export type ConnectionStatus = "connecting" | "both-connected" | "partner-away";

interface UseRoomSyncOptions {
  roomCode: string;
  myName: string;
}

/**
 * Owns the room's realtime channel: presence (who's here), the
 * broadcast stream for high-frequency sync events (heartbeat, play,
 * pause, seek, controller handoff, emoji), and light persistence of
 * playback position back to the `rooms` row.
 *
 * The actual <video> element lives in VideoPlayer — this hook just
 * hands it events to react to via `lastEvent`, and functions to
 * announce local actions.
 */
export function useRoomSync({ roomCode, myName }: UseRoomSyncOptions) {
  const [room, setRoom] = useState<Room | null>(null);
  const [loading, setLoading] = useState(true);
  const [lastEvent, setLastEvent] = useState<SyncEvent | null>(null);
  const [presentNames, setPresentNames] = useState<string[]>([]);
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>("connecting");

  const channelRef = useRef<RealtimeChannel | null>(null);
  const roomIdRef = useRef<string | null>(null);
  const lastPersistRef = useRef(0);

  const partnerName = presentNames.find((n) => n !== myName) ?? null;
  const isController = room?.controller_name === myName;

  // ── Initial load + row subscription (movie uploads, controller changes) ──
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
        // First person in becomes controller by default.
        if (!data.controller_name) {
          await supabase
            .from("rooms")
            .update({ controller_name: myName })
            .eq("id", data.id)
            .is("controller_name", null);
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
        await channel.track({ name: myName, onlineAt: Date.now() } satisfies PresenceState);
      }
    });

    return () => {
      supabase.removeChannel(channel);
    };
  }, [roomCode, myName]);

  // ── Connection status derived from presence ──
  useEffect(() => {
    if (presentNames.length >= 2) setConnectionStatus("both-connected");
    else if (presentNames.length === 1) setConnectionStatus("partner-away");
    else setConnectionStatus("connecting");
  }, [presentNames]);

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

  const takeController = useCallback(async () => {
    if (!roomIdRef.current) return;
    await supabase.from("rooms").update({ controller_name: myName }).eq("id", roomIdRef.current);
    broadcast({ type: "controller-change", controllerName: myName });
  }, [broadcast, myName]);

  return {
    room,
    loading,
    lastEvent,
    presentNames,
    partnerName,
    isController,
    connectionStatus,
    heartbeatIntervalMs: HEARTBEAT_INTERVAL_MS,
    broadcastPlay,
    broadcastPause,
    broadcastSeek,
    broadcastHeartbeat,
    sendEmoji,
    takeController,
    persistPlaybackState,
  };
}
