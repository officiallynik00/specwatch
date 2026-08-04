export interface Room {
  id: string;
  code: string;
  created_at: string;
  movie_path: string | null;
  movie_title: string | null;
  movie_uploaded_at: string | null;
  controller_name: string | null;
  is_playing: boolean;
  last_position_seconds: number;
  last_heartbeat_at: string;
  total_watch_seconds: number;
}

// A single uploaded file in a room's persistent movie library. Distinct
// from `Room.movie_path`, which just points at whichever library item is
// currently loaded into the shared player.
export interface Movie {
  id: string;
  room_id: string;
  storage_path: string;
  title: string;
  file_size_bytes: number | null;
  uploaded_at: string;
}

export interface ChatMessage {
  id: string;
  room_id: string;
  sender_name: string;
  body: string;
  created_at: string;
}

// ── Realtime broadcast event payloads ──────────────────────────
// These travel over the room's realtime channel (not the DB) for
// low-latency, high-frequency events: heartbeats, seeks, emoji.

export type SyncEvent =
  | {
      type: "heartbeat";
      currentTime: number;
      isPlaying: boolean;
      controllerName: string;
      serverSentAt: number; // Date.now() at send time, for latency compensation
    }
  | {
      type: "play";
      currentTime: number;
      controllerName: string;
      serverSentAt: number;
    }
  | {
      type: "pause";
      currentTime: number;
      by: string;
      serverSentAt: number;
    }
  | {
      type: "seek";
      currentTime: number;
      controllerName: string;
      serverSentAt: number;
    }
  | {
      type: "controller-change";
      controllerName: string;
    }
  | {
      type: "emoji";
      emoji: string;
      by: string;
      id: string;
    };

export interface PresenceState {
  name: string;
  onlineAt: number;
}

export const QUICK_EMOJIS = ["❤️", "😂", "😱", "😭", "🔥"] as const;
