import { NextRequest, NextResponse } from "next/server";
import { extractYouTubeId } from "@/lib/youtube";

/**
 * Resolves a pasted YouTube link to { videoId, title, thumbnailUrl,
 * authorName } via YouTube's public oEmbed endpoint. No API key
 * required — this is the same free, unauthenticated endpoint YouTube
 * itself uses for link-preview embeds elsewhere on the web.
 *
 * Done server-side (rather than fetched directly from the browser)
 * just to keep this consistent with the app's other external-fetch
 * routes and sidestep any CORS surprises, not because it needs a
 * secret — there's no credential involved at all.
 */
export async function POST(req: NextRequest) {
  let body: { url?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const videoId = extractYouTubeId(body.url ?? "");
  if (!videoId) {
    return NextResponse.json(
      { error: "That doesn't look like a YouTube video link." },
      { status: 400 }
    );
  }

  const watchUrl = `https://www.youtube.com/watch?v=${videoId}`;
  const oembedUrl = `https://www.youtube.com/oembed?url=${encodeURIComponent(watchUrl)}&format=json`;

  try {
    const res = await fetch(oembedUrl);
    if (!res.ok) {
      // 401/404 from oEmbed here almost always means the video is
      // private, deleted, or has embedding disabled by the uploader.
      return NextResponse.json(
        { error: "Couldn't load that video — it may be private or have embedding disabled." },
        { status: 422 }
      );
    }
    const data = await res.json();
    return NextResponse.json({
      videoId,
      title: data.title as string,
      thumbnailUrl: data.thumbnail_url as string,
      authorName: data.author_name as string,
    });
  } catch {
    return NextResponse.json({ error: "Couldn't reach YouTube — try again." }, { status: 502 });
  }
}
