# Watch Party

A private, two-person watch-party app: one of you uploads a movie (or pastes
a YouTube link), you both join a room from wherever you are, and playback
stays in sync — play, pause, and seek mirrored between both screens, with
text chat, floating emoji reactions, and push-to-talk voice on top.

Built on Next.js (App Router) + Supabase (Postgres, Realtime) for
signaling/state, and Backblaze B2 (S3-compatible) for the actual video files.

## Features

- **Synced playback** — host-controlled remote, drift correction, auto-pause
  on disconnect, resume position. See "How the sync actually works" below.
- **Movie library** — a shared shelf across every room, not one file per
  room. Upload once, play from any room. Uploads are resumable: re-selecting
  the same file after a stall or a paused upload continues from wherever B2
  confirms it actually got to, instead of restarting from zero.
- **YouTube links** — paste a link instead of uploading a file; resolved via
  YouTube's public oEmbed endpoint (no API key needed).
- **Voice** — tap-to-toggle push-to-talk over WebRTC, with the movie's
  volume automatically (and smoothly) ducking while either person is
  talking.
- **Chat & reactions** — a docked drawer in windowed mode, a transparent
  overlay in fullscreen; floating emoji bubbles either way.
- **Fullscreen, mobile-first** — every control (mic, chat, reactions,
  volume, speed, subtitles, audio tracks) works in both portrait and
  landscape, respects safe-area insets, and auto-hides/reveals with a tap.
- **Subtitles & alternate audio tracks**, playback speed (0.5x–2x), a real
  volume slider, and Picture-in-Picture that auto-engages when you background
  the tab so audio keeps playing.
- **Automatic housekeeping** — a daily cron job deletes rooms older than 7
  days (chat cascades with them; movie files are untouched), which as a
  side effect also keeps Supabase's free tier from auto-pausing the project
  for inactivity.

## How the sync actually works

- **One source of truth.** Whoever holds "the remote" (the controller) drives
  playback. The other screen (the follower) continuously corrects itself
  against the controller's timestamp rather than guessing independently.
- **Heartbeat.** The controller broadcasts its current time every ~4s over a
  Supabase Realtime broadcast channel (not the database — that's reserved for
  persistence, not the hot path).
- **Drift correction.** Gaps under ~0.5s are corrected with a gentle
  playback-rate nudge (relative to whatever speed you've chosen — 1x, 1.5x,
  etc.). Gaps of ~1.5s+ trigger a visible "Resyncing…" moment and a hard
  seek.
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
implementation — that's where nearly all of the interesting sync logic
lives.

## Movie storage & resumable uploads

Video files live in Backblaze B2, not Supabase — the browser uploads
directly to B2 via short-lived presigned URLs that our API routes generate,
so files never pass through our own server.

Movies are uploaded in 10MB chunks via B2's multipart upload API
(`src/app/api/r2-multipart-*`), rather than as one giant request. This
means:

- A network stall only costs re-sending the one chunk that was in flight,
  not the whole file.
- Re-selecting the exact same file (matched by name, size, and last-modified
  time) after a stall, hitting "Cancel" (which pauses, not discards), or
  even closing the tab picks up from wherever B2 itself confirms it already
  has data — verified via `r2-multipart-list-parts`, not trusted from local
  browser state alone.

See `src/hooks/useMovieLibrary.ts` for the full resumable-upload flow.

**Required B2 bucket setting:** the bucket's CORS rules must expose the
`ETag` header, or the browser can't read it after each chunk uploads (a
well-known S3/B2 quirk — non-"simple" response headers are hidden
cross-origin unless the bucket explicitly allows it). Using the
[B2 CLI](https://pypi.org/project/b2/):

```bash
b2 bucket update --cors-rules '[{"corsRuleName":"specwatchUpload","allowedOrigins":["*"],"allowedHeaders":["*"],"allowedOperations":["s3_head","s3_get","s3_put","s3_post","s3_delete"],"exposeHeaders":["ETag"],"maxAgeSeconds":3600}]' YOUR-BUCKET-NAME allPrivate
```

Without this, uploads fail immediately on the first chunk — not just resume,
the whole feature.

## Project structure

```
src/
  app/
    page.tsx                       Home — create or join a room
    room/[code]/page.tsx            Lobby — name entry, invite link, movie library
    room/[code]/player/page.tsx     Player screen — video, chat, reactions, voice
    api/
      r2-upload-url/                Presigned single-PUT URL (subtitles)
      r2-multipart-init/            Start a resumable movie upload
      r2-multipart-part-url/        Presigned URL for one chunk
      r2-multipart-list-parts/      What B2 already has — the resume source of truth
      r2-multipart-complete/        Finalize a multipart upload
      r2-multipart-abort/           Discard an in-progress multipart upload
      r2-play-url/                  Presigned GET URL for playback
      r2-delete/                    Remove a file from B2
      youtube-oembed/               Resolve a pasted YouTube link
      cron/cleanup-rooms/           Daily job — deletes rooms older than 7 days
  components/
    VideoPlayer.tsx          <video> element + all sync/control/fullscreen logic
    YouTubePlayer.tsx        YouTube-link playback path
    YouTubeLinkInput.tsx     Paste-a-link UI
    MovieLibrary.tsx         Shared movie shelf + resumable upload UI
    ChatDrawer.tsx           Windowed-mode chat drawer
    FullscreenChatOverlay.tsx  Transparent chat overlay for fullscreen
    EmojiOverlay.tsx         Floating reactions + quick-tap bar (windowed)
    PushToTalkButton.tsx     Windowed-mode voice button
    ConnectionStatus.tsx
  hooks/
    useRoomSync.ts       Presence, broadcast channel, controller state, persistence
    useChat.ts           Chat message history + realtime inserts
    useMovieLibrary.ts   Movie library CRUD + resumable multipart upload
    usePushToTalk.ts     WebRTC voice: signaling, connection, reconnect/retry
  lib/
    b2.ts               Shared B2 (S3-compatible) client
    supabase/client.ts
    types.ts
    roomCode.ts
    youtube.ts
supabase/
  schema.sql   Run this once in your Supabase project's SQL editor
vercel.json    Schedules the daily room-cleanup cron
```

## Setup

### 1. Create a Supabase project

Free tier is enough to start. In your new project:

1. Go to **SQL Editor → New query**, paste in the contents of
   `supabase/schema.sql`, and run it. This creates the `rooms`,
   `chat_messages`, and `movies` tables and enables Realtime on them.
   (The file also still creates a legacy public Supabase Storage bucket
   from an earlier version of this project — movie files no longer use it
   now that B2 handles storage; harmless to leave, safe to remove if you'd
   rather keep things tidy.)
2. Go to **Project Settings → API** and copy your **Project URL** and
   **anon public key**.

### 2. Create a Backblaze B2 bucket

1. Create a **private** bucket.
2. Create an **Application Key** scoped to that bucket (Account →
   Application Keys).
3. Set the bucket's CORS rules to expose `ETag` — see the command in
   "Movie storage & resumable uploads" above. Required for uploads to work
   at all, not just to resume them.

### 3. Configure the app

```bash
cp .env.local.example .env.local
```

Fill in the Supabase and B2 values from steps 1–2. `CRON_SECRET` is
optional locally — it only matters once deployed (see step 5).

### 4. Install and run

```bash
npm install
npm run dev
```

Open two browser windows (or your phone + a laptop) at
`http://localhost:3000` to test as both people.

### 5. Deploy

Push to GitHub, import into [Vercel](https://vercel.com), and add all the
env vars from `.env.local` in the Vercel project settings — including
`CRON_SECRET` this time, so the room-cleanup cron (`vercel.json`) is locked
to Vercel's own scheduler rather than being a publicly-triggerable endpoint.

## Known limitations (by design, for a two-person app)

- **No real auth** — a room is only as private as its code, and the
  database's row-level security is currently wide open (`using (true)`
  everywhere). Fine for a link shared between two people; revisit before
  opening this to strangers.
- **Two people per room** — presence logic assumes exactly one partner.
- **5GB per-file cap**, comfortably under B2's 10GB free-tier storage
  ceiling. Raise `MAX_BYTES` in `useMovieLibrary.ts` if you upgrade your B2
  plan.
- Latency-compensated seeking (accounting for network delay when a play/seek
  event arrives) is implemented in `VideoPlayer.tsx`'s `compensate()` helper,
  but hasn't been extensively tuned against real-world connections — treat
  it as a starting point.
- The YouTube-link playback path (`YouTubePlayer.tsx`) doesn't yet have
  chat, reactions, or voice wired in — those currently only work on the
  uploaded-movie player.
