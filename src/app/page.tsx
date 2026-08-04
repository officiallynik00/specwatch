"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { supabase } from "@/lib/supabase/client";
import { generateRoomCode, normalizeRoomCode } from "@/lib/roomCode";

export default function HomePage() {
  const router = useRouter();
  const [mode, setMode] = useState<"create" | "join">("create");
  const [name, setName] = useState("");
  const [joinCode, setJoinCode] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return setError("Enter your name first.");
    setLoading(true);
    setError(null);

    // Retry on the rare unique-code collision.
    for (let attempt = 0; attempt < 5; attempt++) {
      const code = generateRoomCode();
      const { error: insertError } = await supabase
        .from("rooms")
        .insert({ code })
        .select()
        .single();

      if (!insertError) {
        sessionStorage.setItem("watchparty:name", name.trim());
        router.push(`/room/${code}`);
        return;
      }
      if (insertError.code !== "23505") {
        setError("Couldn't create the room. Try again.");
        setLoading(false);
        return;
      }
    }
    setError("Couldn't find an open room code. Try again.");
    setLoading(false);
  }

  async function handleJoin(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return setError("Enter your name first.");
    if (!joinCode.trim()) return setError("Enter the room code your partner sent you.");
    setLoading(true);
    setError(null);

    const code = normalizeRoomCode(joinCode);
    const { data, error: fetchError } = await supabase
      .from("rooms")
      .select("code")
      .eq("code", code)
      .maybeSingle();

    if (fetchError || !data) {
      setError("Couldn't find a room with that code. Double-check it and try again.");
      setLoading(false);
      return;
    }

    sessionStorage.setItem("watchparty:name", name.trim());
    router.push(`/room/${code}`);
  }

  return (
    <main className="relative z-10 flex min-h-dvh flex-col items-center justify-center px-6 py-16">
      <div className="pointer-events-none absolute inset-0 bg-grain" aria-hidden />

      <div className="relative w-full max-w-md">
        <div className="mb-10 text-center">
          <p className="mb-3 font-mono text-xs uppercase tracking-[0.3em] text-reel-amber">
            now showing
          </p>
          <h1 className="font-display text-5xl italic text-reel-text">
            Watch Party
          </h1>
          <p className="mt-3 text-sm text-reel-muted">
            One room. Two screens. Perfectly in sync — even from different
            couches, different cities, different networks.
          </p>
        </div>

        <div className="rounded-2xl border border-reel-border bg-reel-surface/80 p-6 shadow-2xl shadow-black/40 backdrop-blur">
          <div className="mb-6 flex rounded-full border border-reel-border bg-reel-bg p-1">
            <button
              type="button"
              onClick={() => setMode("create")}
              className={`flex-1 rounded-full py-2 text-sm font-medium transition ${
                mode === "create"
                  ? "bg-reel-amber text-reel-bg"
                  : "text-reel-muted hover:text-reel-text"
              }`}
            >
              Start a room
            </button>
            <button
              type="button"
              onClick={() => setMode("join")}
              className={`flex-1 rounded-full py-2 text-sm font-medium transition ${
                mode === "join"
                  ? "bg-reel-amber text-reel-bg"
                  : "text-reel-muted hover:text-reel-text"
              }`}
            >
              Join a room
            </button>
          </div>

          <form onSubmit={mode === "create" ? handleCreate : handleJoin} className="space-y-4">
            <div>
              <label htmlFor="name" className="mb-1.5 block text-xs font-medium uppercase tracking-wide text-reel-muted">
                Your name
              </label>
              <input
                id="name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. Sangita"
                className="w-full rounded-lg border border-reel-border bg-reel-bg px-4 py-3 text-reel-text placeholder:text-reel-muted/50 focus:border-reel-amber focus:outline-none focus:ring-1 focus:ring-reel-amber"
                autoComplete="off"
              />
            </div>

            {mode === "join" && (
              <div>
                <label htmlFor="code" className="mb-1.5 block text-xs font-medium uppercase tracking-wide text-reel-muted">
                  Room code
                </label>
                <input
                  id="code"
                  value={joinCode}
                  onChange={(e) => setJoinCode(e.target.value)}
                  placeholder="e.g. MAPLE-4821"
                  className="w-full rounded-lg border border-reel-border bg-reel-bg px-4 py-3 font-mono text-reel-text placeholder:text-reel-muted/50 focus:border-reel-amber focus:outline-none focus:ring-1 focus:ring-reel-amber"
                  autoComplete="off"
                />
              </div>
            )}

            {error && <p className="text-sm text-reel-rose">{error}</p>}

            <button
              type="submit"
              disabled={loading}
              className="w-full rounded-lg bg-reel-amber py-3 font-medium text-reel-bg transition hover:bg-reel-amberDim disabled:opacity-60"
            >
              {loading
                ? "One moment…"
                : mode === "create"
                ? "Create room"
                : "Join room"}
            </button>
          </form>
        </div>

        <p className="mt-6 text-center text-xs text-reel-muted">
          No account needed. Rooms are just for the two of you.
        </p>
      </div>
    </main>
  );
}
