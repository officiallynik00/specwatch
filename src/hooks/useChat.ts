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
      const trimmed = body.trim();

      // Optimistic bubble — appears instantly instead of waiting on the
      // round trip to Postgres. Swapped for the real row (or rolled back)
      // once the insert resolves.
      const tempId = `temp-${crypto.randomUUID()}`;
      const optimisticMessage: ChatMessage = {
        id: tempId,
        room_id: roomId,
        sender_name: senderName,
        body: trimmed,
        created_at: new Date().toISOString(),
      };
      setMessages((prev) => [...prev, optimisticMessage]);

      const { data, error } = await supabase
        .from("chat_messages")
        .insert({ room_id: roomId, sender_name: senderName, body: trimmed })
        .select()
        .single();

      if (error || !data) {
        setMessages((prev) => prev.filter((m) => m.id !== tempId));
        return;
      }

      // Swap in the server row (real id) so the realtime INSERT handler's
      // existing dedupe check works when that event arrives moments later,
      // instead of producing a duplicate bubble.
      setMessages((prev) => prev.map((m) => (m.id === tempId ? (data as ChatMessage) : m)));
    },
    [roomId]
  );

  return { messages, loading, sendMessage };
}
