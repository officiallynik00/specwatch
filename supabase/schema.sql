-- Watch Party — idempotent fix-up migration
-- Safe to run on a brand-new project, or one that already ran the old
-- schema.sql (with controller_name and no movies table). Re-runnable.

create extension if not exists "pgcrypto";

-- ── rooms: create if missing, using host_name from the start ──
create table if not exists rooms (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  created_at timestamptz not null default now(),
  movie_path text,
  movie_title text,
  movie_uploaded_at timestamptz,
  host_name text,
  is_playing boolean not null default false,
  last_position_seconds double precision not null default 0,
  last_heartbeat_at timestamptz not null default now(),
  total_watch_seconds double precision not null default 0
);

-- ── YouTube support ──
-- source_type distinguishes an uploaded-file room from a YouTube-link
-- room. movie_path/movie_title stay the source of truth for file rooms;
-- youtube_video_id is used instead when source_type = 'youtube'.
-- Defaulting existing rows to 'file' is exactly right — every room that
-- exists today got here by uploading a movie.
alter table rooms add column if not exists source_type text not null default 'file';
alter table rooms add column if not exists youtube_video_id text;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'rooms_source_type_check'
  ) then
    alter table rooms add constraint rooms_source_type_check
      check (source_type in ('file', 'youtube'));
  end if;
end $$;

-- If rooms already existed with the old column name, rename it in place.
do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_name = 'rooms' and column_name = 'controller_name'
  ) and not exists (
    select 1 from information_schema.columns
    where table_name = 'rooms' and column_name = 'host_name'
  ) then
    alter table rooms rename column controller_name to host_name;
  end if;
end $$;

-- In case some earlier partial run created host_name as NOT NULL or the
-- column simply doesn't exist yet under either name.
alter table rooms add column if not exists host_name text;

create index if not exists rooms_code_idx on rooms (code);

-- ── chat_messages ──
create table if not exists chat_messages (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null references rooms (id) on delete cascade,
  sender_name text not null,
  body text not null,
  created_at timestamptz not null default now()
);

create index if not exists chat_messages_room_id_idx on chat_messages (room_id, created_at);

-- ── movies (new table — the persistent per-room library) ──
create table if not exists movies (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null references rooms (id) on delete cascade,
  storage_path text not null,
  title text not null,
  file_size_bytes bigint,
  uploaded_at timestamptz not null default now()
);

create index if not exists movies_room_id_idx on movies (room_id, uploaded_at desc);

-- ── RLS ──
alter table rooms enable row level security;
alter table chat_messages enable row level security;
alter table movies enable row level security;

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

drop policy if exists "movies are readable by anyone with the anon key" on movies;
create policy "movies are readable by anyone with the anon key"
  on movies for select using (true);

drop policy if exists "movies are insertable by anyone with the anon key" on movies;
create policy "movies are insertable by anyone with the anon key"
  on movies for insert with check (true);

drop policy if exists "movies are deletable by anyone with the anon key" on movies;
create policy "movies are deletable by anyone with the anon key"
  on movies for delete using (true);

-- ── Realtime — guard against "table is already a member" errors ──
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and tablename = 'rooms'
  ) then
    alter publication supabase_realtime add table rooms;
  end if;

  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and tablename = 'chat_messages'
  ) then
    alter publication supabase_realtime add table chat_messages;
  end if;

  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and tablename = 'movies'
  ) then
    alter publication supabase_realtime add table movies;
  end if;
end $$;

-- ── Storage bucket ──
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

alter table movies alter column room_id drop not null;
alter table movies drop constraint if exists movies_room_id_fkey;
alter table movies add constraint movies_room_id_fkey
  foreign key (room_id) references rooms (id) on delete set null;

drop index if exists movies_room_id_idx;
create index if not exists movies_uploaded_at_idx on movies (uploaded_at desc);

-- ── subtitles ──
-- Each entry: { id, storage_path, label, lang }. Uploaded via the same
-- presigned-URL B2 routes as the movie file itself (see
-- /api/r2-upload-url, /api/r2-play-url) — only the DB row is different.
alter table movies add column if not exists subtitles jsonb not null default '[]'::jsonb;

-- ── extracted audio tracks ──
-- Each entry: { id, storage_path, label, language }. When an uploaded
-- movie file has more than one embedded audio stream (e.g. English +
-- Hindi muxed into one file), every stream past the first is pulled out
-- client-side (ffmpeg.wasm, at upload time — see useMovieLibrary.ts) into
-- its own small standalone file and stored here, so it can be selected
-- in the player without depending on the browser's native audioTracks
-- API, which as of 2026 only Safari actually supports.
alter table movies add column if not exists audio_tracks jsonb not null default '[]'::jsonb;
