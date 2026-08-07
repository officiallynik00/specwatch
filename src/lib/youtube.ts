// Pulls a video ID out of the URL shapes people actually paste:
// youtube.com/watch?v=ID, youtu.be/ID, youtube.com/shorts/ID,
// youtube.com/live/ID, youtube.com/embed/ID — with or without extra
// query params (timestamps, playlist context, etc). Returns null for
// anything that isn't recognizably a YouTube video link.
export function extractYouTubeId(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;

  let url: URL;
  try {
    // Allow a bare ID to be pasted too, not just a full URL.
    url = new URL(trimmed.includes("://") ? trimmed : `https://${trimmed}`);
  } catch {
    return /^[\w-]{11}$/.test(trimmed) ? trimmed : null;
  }

  const host = url.hostname.replace(/^www\.|^m\./, "");

  if (host === "youtu.be") {
    const id = url.pathname.slice(1).split("/")[0];
    return /^[\w-]{11}$/.test(id) ? id : null;
  }

  if (host === "youtube.com" || host === "youtube-nocookie.com") {
    if (url.pathname === "/watch") {
      const id = url.searchParams.get("v");
      return id && /^[\w-]{11}$/.test(id) ? id : null;
    }
    const match = url.pathname.match(/^\/(shorts|live|embed)\/([\w-]{11})/);
    if (match) return match[2];
  }

  return null;
}
