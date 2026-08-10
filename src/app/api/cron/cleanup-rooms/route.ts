import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/supabase/client";

/**
 * Deletes rooms older than 7 days (by created_at). Triggered on a
 * schedule by Vercel Cron — see vercel.json.
 *
 * Scope, deliberately: this only touches the `rooms` table.
 *  - `chat_messages` has `on delete cascade` on room_id, so a room's
 *    chat history is cleaned up automatically as a side effect.
 *  - `movies` has `on delete set null` on room_id (not cascade) — a
 *    deleted room's movie metadata row survives, just detached from any
 *    room. The actual video files live in Backblaze B2, entirely
 *    outside Supabase, and this route never touches B2 — by design,
 *    per instruction not to touch movie files.
 *
 * Uses the same anon-key client the browser uses. That's not usually
 * how you'd want a privileged cleanup job authenticated, but it's
 * consistent with this project's current RLS policies, which already
 * permit any anon-key holder to delete any row in `rooms` — so this
 * route isn't granting itself any access the browser doesn't already
 * have. It's protected by CRON_SECRET below so randoms can't trigger
 * it on a schedule of their own choosing, not because it has elevated
 * database rights.
 */
export async function GET(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const auth = req.headers.get("authorization");
    if (auth !== `Bearer ${secret}`) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
  }

  const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

  const { data, error } = await supabase.from("rooms").delete().lt("created_at", cutoff).select("id, code");

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({
    deleted: data?.length ?? 0,
    codes: data?.map((r) => r.code) ?? [],
    cutoff,
  });
}
