// Most encoders/muxers leave a track's `label` empty and only set a raw
// BCP-47/ISO-639 code ("hin", "en", "und" for "undefined"). This
// resolves a code to a readable name using the browser's own locale
// data — no hardcoded table to maintain, and it's already correct in
// whatever language the browser itself is set to. ffmpeg (used at
// upload time to extract alternate audio tracks — see audioExtract.ts)
// reports 3-letter ISO 639-2 codes like "hin"/"eng"; Intl.DisplayNames
// resolves those in every modern browser, not just 2-letter BCP-47.
export function languageDisplayName(code: string | undefined | null): string | null {
  if (!code || code.toLowerCase() === "und") return null;
  try {
    const displayNames = new Intl.DisplayNames(["en"], { type: "language" });
    const name = displayNames.of(code);
    // Intl.DisplayNames falls back to echoing the input code unchanged
    // for a tag it can't resolve, rather than throwing — catch that so
    // callers fall through to their own default instead of showing the
    // same unhelpful code back to the person.
    return name && name.toLowerCase() !== code.toLowerCase() ? name : null;
  } catch {
    // Malformed/unrecognized subtag (RangeError) — same fallback.
    return null;
  }
}
