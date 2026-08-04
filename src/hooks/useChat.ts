import { useCallback, useEffect, useState } from "react";
import { supabase } from "@/lib/supabase/client";
import type { ChatMessage } from "@/lib/types";

/**
 * Persistent text chat, separate from the ephemeral emoji-reaction
 * broadcast. Backed by the `chat_messages` table so the log survives
 * across sessions (a running log of watch nights, per the spec).
 */
export function useChat(roomId: string | null) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!roomId) return;
    let cancelled = false;

    async function load() {
      const { data } = await supabase
        .from("chat_messages")
        .select("*")
        .eq("room_id", roomId)
        .order("created_at", { ascending: true });
      if (!cancelled && data) setMessages(data as ChatMessage[]);
      setLoading(false);
    }
    load();

    const sub = supabase
      .channel(`chat-${roomId}`)
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "chat_messages", filter: `room_id=eq.${roomId}` },
        (payload) => {
          setMessages((prev) => {
            const incoming = payload.new as ChatMessage;
            if (prev.some((m) => m.id === incoming.id)) return prev;
            return [...prev, incoming];
          });
        }
      )
      .subscribe();

    return () => {
      cancelled = true;
      supabase.removeChannel(sub);
    };
  }, [roomId]);

  const sendMessage = useCallback(
    async (senderName: string, body: string) => {
      if (!roomId || !body.trim()) return;
      await supabase.from("chat_messages").insert({
        room_id: roomId,
        sender_name: senderName,
        body: body.trim(),
      });
    },
    [roomId]
  );

  return { messages, loading, sendMessage };
}
