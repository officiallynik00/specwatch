-- Watch Party — Supabase schema
-- Run this in the Supabase SQL Editor (Project -> SQL Editor -> New query) once,
-- on a fresh project. Safe to re-run (uses IF NOT EXISTS / OR REPLACE).

-- ─────────────────────────────────────────────────────────────
-- Extensions
-- ─────────────────────────────────────────────────────────────
create extension if not exists "pgcrypto";

-- ─────────────────────────────────────────────────────────────
-- Rooms
-- One row per watch-party room. Holds movie reference + shared
-- playback state (the "ground truth" the sync logic reads/writes).
-- ─────────────────────────────────────────────────────────────
create table if not exists rooms (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,                 -- short shareable room code, e.g. "PLUM-4821"
  created_at timestamptz not null default now(),

  -- Movie
  movie_path text,                           -- path inside the storage bucket
  movie_title text,
  movie_uploaded_at timestamptz,

  -- Shared playback / control state
  controller_name text,                      -- name of the person who currently holds "the remote"
  is_playing boolean not null default false,
  last_position_seconds double precision not null default 0,
  last_heartbeat_at timestamptz not null default now(),

  -- Fun stat
  total_watch_seconds double precision not null default 0
);

create index if not exists rooms_code_idx on rooms (code);

-- ─────────────────────────────────────────────────────────────
-- Chat messages
-- Persistent log per room. Emoji reactions are NOT stored here —
-- they're ephemeral and travel only over the realtime broadcast
-- channel (see src/hooks/useRoomSync.ts), by design.
-- ─────────────────────────────────────────────────────────────
create table if not exists chat_messages (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null references rooms (id) on delete cascade,
  sender_name text not null,
  body text not null,
  created_at timestamptz not null default now()
);

create index if not exists chat_messages_room_id_idx on chat_messages (room_id, created_at);

-- ─────────────────────────────────────────────────────────────
-- Row Level Security
-- MVP note: rooms are protected only by an unguessable code, matching
-- the "no heavy auth" decision in the spec. Anyone with the anon key
-- can read/write — that's acceptable for a private 2-person link, but
-- revisit before opening this up to strangers (see spec's Future
-- Considerations section).
-- ─────────────────────────────────────────────────────────────
alter table rooms enable row level security;
alter table chat_messages enable row level security;

drop policy if exists "rooms are readable by anyone with the anon key" on rooms;
create policy "rooms are readable by anyone with the anon key"
  on rooms for select using (true);

drop policy if exists "rooms are insertable by anyone with the anon key" on rooms;
create policy "rooms are insertable by anyone with the anon key"
  on rooms for insert with check (true);

drop policy if exists "rooms are updatable by anyone with the anon key" on rooms;
create policy "rooms are updatable by anyone with the anon key"
  on rooms for update using (true);

drop policy if exists "chat is readable by anyone with the anon key" on chat_messages;
create policy "chat is readable by anyone with the anon key"
  on chat_messages for select using (true);

drop policy if exists "chat is insertable by anyone with the anon key" on chat_messages;
create policy "chat is insertable by anyone with the anon key"
  on chat_messages for insert with check (true);

-- ─────────────────────────────────────────────────────────────
-- Realtime
-- Broadcast changes to rooms + chat_messages so every client in
-- the room sees state changes without polling.
-- ─────────────────────────────────────────────────────────────
alter publication supabase_realtime add table rooms;
alter publication supabase_realtime add table chat_messages;

-- ─────────────────────────────────────────────────────────────
-- Storage bucket for movie files
-- 1GB free-tier ceiling per the spec's storage decisions.
-- ─────────────────────────────────────────────────────────────
insert into storage.buckets (id, name, public)
values ('movies', 'movies', true)
on conflict (id) do nothing;

drop policy if exists "movie files are readable by anyone with the anon key" on storage.objects;
create policy "movie files are readable by anyone with the anon key"
  on storage.objects for select
  using (bucket_id = 'movies');

drop policy if exists "movie files are uploadable by anyone with the anon key" on storage.objects;
create policy "movie files are uploadable by anyone with the anon key"
  on storage.objects for insert
  with check (bucket_id = 'movies');

drop policy if exists "movie files are replaceable by anyone with the anon key" on storage.objects;
create policy "movie files are replaceable by anyone with the anon key"
  on storage.objects for update
  using (bucket_id = 'movies');

drop policy if exists "movie files are deletable by anyone with the anon key" on storage.objects;
create policy "movie files are deletable by anyone with the anon key"
  on storage.objects for delete
  using (bucket_id = 'movies');
