"use client";

import { useCallback, useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { useRoomSync } from "@/hooks/useRoomSync";
import { useChat } from "@/hooks/useChat";
import VideoPlayer from "@/components/VideoPlayer";
import EmojiOverlay, { type FloatingBubble } from "@/components/EmojiOverlay";
import ChatDrawer from "@/components/ChatDrawer";
import ConnectionStatus from "@/components/ConnectionStatus";

export default function PlayerPage() {
  const params = useParams<{ code: string }>();
  const code = decodeURIComponent(params.code).toUpperCase();
  const router = useRouter();

  const [name, setName] = useState<string | null>(null);
  const [chatOpen, setChatOpen] = useState(false);
  const [bubbles, setBubbles] = useState<FloatingBubble[]>([]);

  useEffect(() => {
    setName(sessionStorage.getItem("watchparty:name"));
  }, []);

  const sync = useRoomSync({ roomCode: code, myName: name ?? "" });
  const { messages, sendMessage } = useChat(sync.room?.id ?? null);

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

  if (name === null) return null;

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

  if (!sync.room.movie_path) {
    router.replace(`/room/${code}`);
    return null;
  }

  return (
    <main className="mx-auto flex min-h-dvh max-w-4xl flex-col gap-4 px-4 py-6 sm:px-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="font-mono text-[10px] uppercase tracking-[0.3em] text-reel-amber">
            room {code}
          </p>
          <h1 className="font-display text-xl italic text-reel-text">{sync.room.movie_title}</h1>
        </div>
        <ConnectionStatus status={sync.connectionStatus} />
      </header>

      <div className="relative">
        <VideoPlayer
          room={sync.room}
          myName={name}
          isController={sync.isController}
          connectionStatus={sync.connectionStatus}
          partnerName={sync.partnerName}
          lastEvent={sync.lastEvent}
          heartbeatIntervalMs={sync.heartbeatIntervalMs}
          broadcastPlay={sync.broadcastPlay}
          broadcastPause={sync.broadcastPause}
          broadcastSeek={sync.broadcastSeek}
          broadcastHeartbeat={sync.broadcastHeartbeat}
          takeController={sync.takeController}
          onEmoji={handleRemoteEmoji}
        />
        <EmojiOverlay bubbles={bubbles} onRemove={removeBubble} onTap={handleTapEmoji} />
      </div>

      <ChatDrawer
        open={chatOpen}
        onToggle={() => setChatOpen((v) => !v)}
        messages={messages}
        myName={name}
        onSend={(body) => sendMessage(name, body)}
      />
    </main>
  );
}
