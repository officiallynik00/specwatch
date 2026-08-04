# Watch Party

A private, two-person watch-party app: one of you uploads a movie, you both
join a room from wherever you are, and playback stays in sync — play, pause,
and seek mirrored between both screens, with a chat drawer and floating
emoji reactions on top.

Built from the project spec: Next.js (App Router) + Supabase (Postgres,
Realtime, Storage).

## How the sync actually works

- **One source of truth.** Whoever holds "the remote" (the controller) drives
  playback. The other screen (the follower) continuously corrects itself
  against the controller's timestamp rather than guessing independently.
- **Heartbeat.** The controller broadcasts its current time every ~4s over a
  Supabase Realtime broadcast channel (not the database — that's reserved for
  persistence, not the hot path).
- **Drift correction.** Gaps under ~0.5s are corrected silently. Gaps of
  ~1.5s+ trigger a visible "Resyncing…" moment and a hard seek.
- **Universal pause.** Either person can pause instantly — no permission
  needed. Only the controller can press play or seek; the "Take the remote"
  button hands control over instantly.
- **Presence.** Supabase Realtime presence tracks who's actually in the room
  right now. If either connection drops, both players auto-pause with a
  status message, and the rejoining client pulls fresh room state immediately
  on reconnect instead of waiting for the next heartbeat.
- **Persistence.** `last_position_seconds` is saved to the room row
  periodically and on every pause, so reopening the room later resumes where
  you left off.

See `src/hooks/useRoomSync.ts` and `src/components/VideoPlayer.tsx` for the
implementation — that's where nearly all of the interesting logic lives.

## Project structure

```
src/
  app/
    page.tsx                    Home — create or join a room
    room/[code]/page.tsx         Lobby — name entry, invite link, movie upload
    room/[code]/player/page.tsx  Player screen — video, chat, reactions
  components/
    VideoPlayer.tsx    <video> element + all sync/control logic
    ChatDrawer.tsx      Persistent slide-up text chat
    EmojiOverlay.tsx    Floating reactions + quick-tap bar
    ConnectionStatus.tsx
    MovieUploader.tsx
  hooks/
    useRoomSync.ts   Presence, broadcast channel, controller state, persistence
    useChat.ts       Chat message history + realtime inserts
  lib/
    supabase/client.ts
    types.ts
    roomCode.ts
supabase/
  schema.sql   Run this once in your Supabase project's SQL editor
```

## Setup

### 1. Create a Supabase project

Free tier is enough to start. In your new project:

1. Go to **SQL Editor → New query**, paste in the contents of
   `supabase/schema.sql`, and run it. This creates the `rooms` and
   `chat_messages` tables, enables Realtime on both, and creates a public
   `movies` Storage bucket with permissive policies (see the note at the top
   of that file about the MVP's auth model).
2. Go to **Project Settings → API** and copy your **Project URL** and
   **anon public key**.

### 2. Configure the app

```bash
cp .env.local.example .env.local
```

Fill in `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_ANON_KEY` from
step 1.

### 3. Install and run

```bash
npm install
npm run dev
```

Open two browser windows (or your phone + a laptop) at
`http://localhost:3000` to test as both people.

### 4. Deploy

Push to GitHub, import into [Vercel](https://vercel.com), and add the same
two env vars in the Vercel project settings. Free tier covers hosting at
this scale.

## Known MVP limitations (by design, per the spec)

- **No real auth** — a room is only as private as its code. Fine for a link
  shared between two people; revisit before opening this to strangers.
- **One movie per room**, replaced (not accumulated) on re-upload.
- **Two people per room** — presence logic assumes exactly one partner.
- **480p target** — comfortably fits the 1GB free-tier storage ceiling for a
  feature-length movie. Upgrading to Supabase Pro ($25/mo) raises that to
  100GB with no code changes.
- Latency-compensated seeking (accounting for network delay when a play/seek
  event arrives) is implemented in `VideoPlayer.tsx`'s `compensate()` helper,
  but hasn't been tuned against real-world connections — treat it as a
  starting point.
