"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { useRoomSync } from "@/hooks/useRoomSync";
import { useChat } from "@/hooks/useChat";
import { usePushToTalk } from "@/hooks/usePushToTalk";
import VideoPlayer from "@/components/VideoPlayer";
import YouTubePlayer from "@/components/YouTubePlayer";
import EmojiOverlay, { type FloatingBubble } from "@/components/EmojiOverlay";
import ChatDrawer from "@/components/ChatDrawer";
import ConnectionStatus from "@/components/ConnectionStatus";
import PushToTalkButton from "@/components/PushToTalkButton";

export default function PlayerScreen() {
  const params = useParams<{ code: string }>();
  const code = decodeURIComponent(params.code).toUpperCase();
  const router = useRouter();

  const [name, setName] = useState("");
  const [nameChecked, setNameChecked] = useState(false);
  
  const [chatOpen, setChatOpen] = useState(false);
  const [bubbles, setBubbles] = useState<FloatingBubble[]>([]);
  const [justLoadedNotice, setJustLoadedNotice] = useState(false);
  const hadMovieRef = useRef(false);
  const noticeTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    setName(sessionStorage.getItem("watchparty:name") ?? "");
    setNameChecked(true);
  }, []);

  const sync = useRoomSync({ roomCode: code, myName: name ?? "" });
  const { messages, sendMessage } = useChat(sync.room?.id ?? null);
  const ptt = usePushToTalk({
    roomCode: code,
    myName: name ?? "",
    partnerName: sync.partnerName,
    isHost: sync.isHost,
  });

  // Fires the "movie's ready" notice the moment the room transitions
  // from no-movie to a movie being loaded — mainly for the visitor, who
  // was sitting on the waiting screen below and just watched it turn
  // into a real player.
  useEffect(() => {
    const hasMovie = !!(sync.room?.movie_path || sync.room?.youtube_video_id);
    if (hasMovie && !hadMovieRef.current) {
      setJustLoadedNotice(true);
      if (noticeTimeoutRef.current) clearTimeout(noticeTimeoutRef.current);
      noticeTimeoutRef.current = setTimeout(() => setJustLoadedNotice(false), 4000);
    }
    hadMovieRef.current = hasMovie;
  }, [sync.room?.movie_path, sync.room?.youtube_video_id]);

  useEffect(() => {
    return () => {
      if (noticeTimeoutRef.current) clearTimeout(noticeTimeoutRef.current);
    };
  }, []);

  const addBubble = useCallback((emoji: string) => {
    const bubble: FloatingBubble = {
      id: crypto.randomUUID(),
      emoji,
      left: 10 + Math.random() * 80,
    };
    setBubbles((prev) => [...prev, bubble]);
  }, []);

  const removeBubble = useCallback((id: string) => {
    setBubbles((prev) => prev.filter((b) => b.id !== id));
  }, []);

  const handleTapEmoji = useCallback(
    (emoji: string) => {
      addBubble(emoji); // show locally right away
      sync.sendEmoji(emoji); // broadcast to partner
    },
    [addBubble, sync]
  );

  const handleRemoteEmoji = useCallback(
    (emoji: string, by: string) => {
      if (by === name) return; // avoid double-showing our own, in case of self-echo
      addBubble(emoji);
    },
    [addBubble, name]
  );

  const handleSendChat = useCallback(
    (body: string) => {
      if (!name) return;
      sendMessage(name, body);
    },
    [name, sendMessage]
  );

  if (!nameChecked) return null;

  if (!name) {
    router.replace(`/room/${code}`);
    return null;
  }

  if (sync.loading) {
    return (
      <main className="flex min-h-dvh items-center justify-center text-reel-muted">
        Loading the room…
      </main>
    );
  }

  if (!sync.room) {
    return (
      <main className="flex min-h-dvh flex-col items-center justify-center gap-3 text-center">
        <p className="font-display text-2xl italic text-reel-text">Room not found</p>
        <button
          onClick={() => router.push("/")}
          className="rounded-full border border-reel-border px-4 py-2 text-sm text-reel-muted hover:border-reel-amber hover:text-reel-amber"
        >
          Back home
        </button>
      </main>
    );
  }

  if (!sync.room.movie_path && !sync.room.youtube_video_id) {
    if (sync.isHost) {
      // The host manages the library from the lobby, not here — send
      // them back to pick something.
      router.replace(`/room/${code}`);
      return null;
    }

    // Visitor: stay right here and wait. The room-row subscription in
    // useRoomSync will flip sync.room.movie_path the moment the host
    // loads something, which re-renders this component straight into
    // the real player below — no navigation needed.
    return (
      <main className="flex min-h-dvh flex-col items-center justify-center gap-4 px-6 text-center">
        <p className="font-mono text-[10px] uppercase tracking-[0.3em] text-reel-amber">
          room {code}
        </p>
        <div className="h-10 w-10 animate-spin rounded-full border-2 border-reel-amber border-t-transparent" />
        <p className="font-display text-2xl italic text-reel-text">
          Waiting for {sync.room.host_name ?? "the host"} to pick a movie
        </p>
        <p className="max-w-xs text-sm text-reel-muted">
          You're in the room — this screen will switch to the player automatically the moment
          something's loaded.
        </p>
        <ConnectionStatus status={sync.connectionStatus} />
      </main>
    );
  }

  return (
    <main className="mx-auto flex min-h-dvh max-w-4xl flex-col gap-4 px-4 py-6 sm:px-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="font-mono text-[10px] uppercase tracking-[0.3em] text-reel-amber">
            room {code}
          </p>
          <h1 className="max-w-[60vw] truncate font-display text-lg italic text-reel-text sm:max-w-none sm:text-xl">
            {sync.room.movie_title}
          </h1>
        </div>
        <ConnectionStatus status={sync.connectionStatus} />
      </header>

      {justLoadedNotice && (
        <div className="rounded-xl border border-reel-amber/40 bg-reel-amber/10 px-4 py-2.5 text-sm text-reel-amber">
          🎬 {sync.room.movie_title} is loaded and ready.
        </div>
      )}

      <div className="relative">
        {sync.room.source_type === "youtube" ? (
          <YouTubePlayer
            room={sync.room}
            myName={name}
            isController={sync.isController}
            connectionStatus={sync.connectionStatus}
            partnerName={sync.partnerName}
            lastEvent={sync.lastEvent}
            heartbeatIntervalMs={sync.heartbeatIntervalMs}
            clockOffsetMs={sync.clockOffsetMs}
            broadcastPlay={sync.broadcastPlay}
            broadcastPause={sync.broadcastPause}
            broadcastSeek={sync.broadcastSeek}
            broadcastHeartbeat={sync.broadcastHeartbeat}
            onEmoji={handleRemoteEmoji}
          />
        ) : (
          <VideoPlayer
            room={sync.room}
            myName={name}
            isController={sync.isController}
            connectionStatus={sync.connectionStatus}
            partnerName={sync.partnerName}
            lastEvent={sync.lastEvent}
            heartbeatIntervalMs={sync.heartbeatIntervalMs}
            clockOffsetMs={sync.clockOffsetMs}
            broadcastPlay={sync.broadcastPlay}
            broadcastPause={sync.broadcastPause}
            broadcastSeek={sync.broadcastSeek}
            broadcastHeartbeat={sync.broadcastHeartbeat}
            onEmoji={handleRemoteEmoji}
            chatMessages={messages}
            onSendChat={handleSendChat}
            bubbles={bubbles}
            onTapEmoji={handleTapEmoji}
            onRemoveBubble={removeBubble}
            ptt={{
              status: ptt.status,
              isTalking: ptt.isTalking,
              partnerTalking: ptt.partnerTalking,
              error: ptt.error,
              onStart: ptt.startTalking,
              onStop: ptt.stopTalking,
            }}
          />
        )}
        <EmojiOverlay bubbles={bubbles} onRemove={removeBubble} onTap={handleTapEmoji} />
      </div>

      {/* Outside the fullscreen container by design — this is the normal,
          windowed-mode chat drawer. VideoPlayer renders its own transparent
          overlay (FullscreenChatOverlay) for while fullscreen is active,
          since the browser hides `fixed` elements like this one then. */}
      <ChatDrawer
        open={chatOpen}
        onToggle={() => setChatOpen((v) => !v)}
        messages={messages}
        myName={name}
        onSend={handleSendChat}
      />

      <PushToTalkButton
        status={ptt.status}
        isTalking={ptt.isTalking}
        partnerTalking={ptt.partnerTalking}
        error={ptt.error}
        partnerName={sync.partnerName}
        onStart={ptt.startTalking}
        onStop={ptt.stopTalking}
      />
    </main>
  );
}
