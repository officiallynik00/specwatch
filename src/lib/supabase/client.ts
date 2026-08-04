import { createClient } from "@supabase/supabase-js";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

if (!url || !anonKey) {
  // Warn rather than throw: createClient() would otherwise crash Next.js's
  // static prerendering of client pages when env vars aren't set yet (e.g.
  // a first `next build` before .env.local is configured). A placeholder
  // URL lets the build finish; real requests will just fail until the env
  // vars are set, same as any other missing-config case.
  // eslint-disable-next-line no-console
  console.warn(
    "Missing NEXT_PUBLIC_SUPABASE_URL or NEXT_PUBLIC_SUPABASE_ANON_KEY. " +
      "Copy .env.local.example to .env.local and fill in your project values."
  );
}

// Single shared client for the browser. Realtime channels, storage uploads,
// and table reads/writes all go through this instance.
export const supabase = createClient(url || "https://placeholder.supabase.co", anonKey || "placeholder-anon-key", {
  realtime: {
    params: {
      eventsPerSecond: 10,
    },
  },
});
