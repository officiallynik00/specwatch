"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { useRoomSync } from "@/hooks/useRoomSync";
import { useMovieLibrary } from "@/hooks/useMovieLibrary";
import MovieLibrary from "@/components/MovieLibrary";
import ConnectionStatus from "@/components/ConnectionStatus";
import { supabase } from "@/lib/supabase/client";
import type { Movie } from "@/lib/types";

export default function RoomLobbyScreen() {
  const params = useParams<{ code: string }>();
  const code = decodeURIComponent(params.code).toUpperCase();
  const router = useRouter();

  const [name, setName] = useState<string | null>(null);
  const [nameInput, setNameInput] = useState("");
  const [copied, setCopied] = useState(false);
  const [entering, setEntering] = useState(false);

  useEffect(() => {
    setName(sessionStorage.getItem("watchparty:name"));
  }, []);

  // claimHostIfUnset: true — this is the lobby, so if we somehow land
  // here on a room row with no host set yet (legacy row, or a link
  // opened before the create-room insert included host_name), we grab
  // it. Normal rooms already have host_name set at creation and this is
  // a no-op for them.
  const { room, loading, connectionStatus, isHost } = useRoomSync({
    roomCode: code,
    myName: name ?? "",
    claimHostIfUnset: true,
  });
  const library = useMovieLibrary({ roomId: room?.id ?? null, roomCode: code });

  // This screen (code, invite link, movie library) is host-only. A
  // visitor doesn't manage the library — they just watch — so as soon as
  // we know they're not the host, send them straight to the player,
  // which handles the "no movie loaded yet" waiting state on its own.
  useEffect(() => {
    if (!name || loading || !room) return;
    if (!isHost) {
      router.replace(`/room/${code}/player`);
    }
  }, [name, loading, room, isHost, router, code]);

  function confirmName(e: React.FormEvent) {
    e.preventDefault();
    if (!nameInput.trim()) return;
    sessionStorage.setItem("watchparty:name", nameInput.trim());
    setName(nameInput.trim());
  }

  function copyLink() {
    const url = `${window.location.origin}/room/${code}`;
    navigator.clipboard.writeText(url).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    });
  }

  // Loads a library item into the room's shared playback state — the
  // pointer both VideoPlayer instances read — then heads into the
  // player. The visitor, already sitting on their own player screen,
  // picks up the change via the room row's postgres_changes subscription
  // in useRoomSync and transitions out of the "waiting for host" state
  // automatically.
  async function playMovie(movie: Movie) {
    if (!room || entering) return;
    setEntering(true);
    const { error } = await supabase
      .from("rooms")
      .update({
        movie_path: movie.storage_path,
        movie_title: movie.title,
        movie_uploaded_at: movie.uploaded_at,
        last_position_seconds: 0,
        is_playing: false,
      })
      .eq("id", room.id);
    setEntering(false);
    if (!error) router.push(`/room/${code}/player`);
  }

  if (name === null) {
    // Waiting on the sessionStorage check on mount.
    return null;
  }

  if (!name) {
    return (
      <main className="flex min-h-dvh items-center justify-center px-6">
        <form
          onSubmit={confirmName}
          className="w-full max-w-sm rounded-2xl border border-reel-border bg-reel-surface p-6"
        >
          <p className="mb-1 font-mono text-xs uppercase tracking-[0.3em] text-reel-amber">
            room {code}
          </p>
          <h1 className="mb-4 font-display text-2xl italic text-reel-text">What's your name?</h1>
          <input
            autoFocus
            value={nameInput}
            onChange={(e) => setNameInput(e.target.value)}
            placeholder="e.g. Sangita"
            className="mb-4 w-full rounded-lg border border-reel-border bg-reel-bg px-4 py-3 text-reel-text placeholder:text-reel-muted/50 focus:border-reel-amber focus:outline-none"
          />
          <button
            type="submit"
            className="w-full rounded-lg bg-reel-amber py-3 font-medium text-reel-bg hover:bg-reel-amberDim"
          >
            Join room
          </button>
        </form>
      </main>
    );
  }

  if (loading) {
    return (
      <main className="flex min-h-dvh items-center justify-center text-reel-muted">
        Finding your room…
      </main>
    );
  }

  if (!room) {
    return (
      <main className="flex min-h-dvh flex-col items-center justify-center gap-3 px-6 text-center">
        <p className="font-display text-2xl italic text-reel-text">Couldn't find room {code}</p>
        <p className="text-sm text-reel-muted">The link might be wrong, or the room may have been reset.</p>
        <button
          onClick={() => router.push("/")}
          className="mt-2 rounded-full border border-reel-border px-4 py-2 text-sm text-reel-muted hover:border-reel-amber hover:text-reel-amber"
        >
          Back home
        </button>
      </main>
    );
  }

  if (!isHost) {
    // Redirecting to the player — see the effect above.
    return (
      <main className="flex min-h-dvh items-center justify-center text-reel-muted">
        Joining the room…
      </main>
    );
  }

  return (
    <main className="flex min-h-dvh flex-col items-center gap-6 px-6 py-16">
      <div className="w-full max-w-md text-center">
        <p className="mb-2 font-mono text-xs uppercase tracking-[0.3em] text-reel-amber">
          room ready · you're the host
        </p>
        <h1 className="mb-1 font-display text-3xl italic text-reel-text">{code}</h1>
        <p className="mb-4 text-sm text-reel-muted">Hi {name} — send this code or link to your partner.</p>

        <div className="mb-6 flex items-center justify-center gap-3">
          <ConnectionStatus status={connectionStatus} />
          <button
            onClick={copyLink}
            className="rounded-full border border-reel-border px-3 py-1.5 text-xs text-reel-muted hover:border-reel-amber hover:text-reel-amber"
          >
            {copied ? "Copied!" : "Copy invite link"}
          </button>
        </div>

        <div className="sprocket-rule mb-6" />

        {room.movie_path && (
          <div className="mb-6 rounded-xl border border-reel-border bg-reel-surface p-6">
            <p className="mb-1 text-xs uppercase tracking-wide text-reel-muted">Now loaded</p>
            <p className="mb-5 font-display text-xl italic text-reel-text">{room.movie_title}</p>
            <button
              onClick={() => router.push(`/room/${code}/player`)}
              className="w-full rounded-lg bg-reel-amber py-3 font-medium text-reel-bg hover:bg-reel-amberDim"
            >
              Enter the room
            </button>
          </div>
        )}
      </div>

      <div className="w-full max-w-md text-left">
        <MovieLibrary
          movies={library.movies}
          loading={library.loading}
          uploading={library.uploading}
          progress={library.progress}
          error={library.error}
          currentMoviePath={room.movie_path}
          onAdd={library.addMovie}
          onRemove={library.removeMovie}
          onPlay={playMovie}
        />
      </div>
    </main>
  );
}
