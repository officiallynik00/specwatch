// Client-side extraction of extra embedded audio streams from a movie
// file at upload time — e.g. a file with English + Hindi audio muxed
// together gets English kept in the main uploaded file (as always) and
// Hindi pulled out as its own small standalone track, stored and
// selectable independent of the browser's native HTMLMediaElement
// audioTracks API. That API is what the in-player selector originally
// relied on, but as of 2026 it's disabled by default in every browser
// except Safari — this sidesteps that entirely by doing the split
// ourselves instead of depending on browser-native track switching.
//
// Runs entirely in the browser via ffmpeg.wasm — no server-side
// transcoding, which matters because Vercel's serverless functions
// aren't built for multi-minute/multi-GB ffmpeg jobs (execution time
// and ephemeral disk limits). The tradeoff: ffmpeg.wasm needs the whole
// input file resident in the browser's memory (there's no streaming
// mode in this build), so this is skipped above MAX_EXTRACT_BYTES
// rather than risking a crashed tab on a phone with a multi-GB file.
//
// This has been written carefully against the documented ffmpeg.wasm
// API but not runtime-tested against a real multi-audio-track file —
// there's no browser available in the environment this was built in to
// actually execute WASM. Worth a real test upload before relying on it.

import type { FFmpeg } from "@ffmpeg/ffmpeg";

const MAX_EXTRACT_BYTES = 1.5 * 1024 * 1024 * 1024; // 1.5GB

export interface ProbedAudioStream {
  audioIndex: number; // 0-based, among audio streams only — what `-map 0:a:N` expects
  language?: string; // 3-letter code as ffmpeg reports it, e.g. "hin"
}

let ffmpegPromise: Promise<FFmpeg> | null = null;

async function getFFmpeg(): Promise<FFmpeg> {
  if (!ffmpegPromise) {
    ffmpegPromise = (async () => {
      const { FFmpeg } = await import("@ffmpeg/ffmpeg");
      const { toBlobURL } = await import("@ffmpeg/util");
      const ffmpeg = new FFmpeg();
      // Single-threaded core — needs no COOP/COEP headers, unlike the
      // -mt (multi-threaded) build. We're doing stream copies, not
      // re-encoding, so the single-thread performance cost is minor.
      const baseURL = "https://unpkg.com/@ffmpeg/core@0.12.10/dist/umd";
      await ffmpeg.load({
        coreURL: await toBlobURL(`${baseURL}/ffmpeg-core.js`, "text/javascript"),
        wasmURL: await toBlobURL(`${baseURL}/ffmpeg-core.wasm`, "application/wasm"),
      });
      return ffmpeg;
    })();
  }
  return ffmpegPromise;
}

export function canAttemptExtraction(file: File): boolean {
  return file.size > 0 && file.size <= MAX_EXTRACT_BYTES;
}

function extOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot === -1 ? "" : name.slice(dot);
}

/**
 * Probes a movie file for embedded audio streams, then extracts every
 * stream after the first (index 0 stays baked into the main uploaded
 * file, exactly as before) as a standalone AAC-in-MP4 blob via stream
 * copy — no re-encoding, so this is fast regardless of the movie's
 * length.
 *
 * The whole file is written into ffmpeg's virtual filesystem once and
 * reused for both the probe and every extraction, rather than reloading
 * it per operation — reloading a multi-GB file repeatedly would be
 * both slow and memory-wasteful.
 */
export async function extractAlternateAudioTracks(
  file: File,
  onProgress?: (label: string) => void
): Promise<{ blob: Blob; language?: string; audioIndex: number }[]> {
  const ffmpeg = await getFFmpeg();
  const { fetchFile } = await import("@ffmpeg/util");
  const inputName = "input" + extOf(file.name);

  onProgress?.("Loading file for audio scan…");
  await ffmpeg.writeFile(inputName, await fetchFile(file));

  try {
    // 1) Probe. There's no separate ffprobe binary bundled here — running
    // `-i` with no output is the standard ffmpeg.wasm trick: it prints
    // stream info to its log and then errors out for lack of an output,
    // which we deliberately ignore.
    onProgress?.("Scanning for audio tracks…");
    const streams: ProbedAudioStream[] = [];
    const onLog = ({ message }: { message: string }) => {
      const m = message.match(/Stream #0:\d+(?:\((\w+)\))?:\s*Audio/);
      if (m) streams.push({ audioIndex: streams.length, language: m[1] });
    };
    ffmpeg.on("log", onLog);
    try {
      await ffmpeg.exec(["-i", inputName]);
    } catch {
      // Expected — see above.
    } finally {
      ffmpeg.off("log", onLog);
    }

    if (streams.length <= 1) return [];

    // 2) Extract every stream past the first.
    const results: { blob: Blob; language?: string; audioIndex: number }[] = [];
    for (const stream of streams.slice(1)) {
      onProgress?.(`Extracting audio track ${stream.audioIndex + 1} of ${streams.length}…`);
      const outputName = `track-${stream.audioIndex}.m4a`;
      try {
        await ffmpeg.exec(["-i", inputName, "-map", `0:a:${stream.audioIndex}`, "-c", "copy", outputName]);
        const data = await ffmpeg.readFile(outputName);
        // readFile's return type is backed by ArrayBufferLike (which
        // includes SharedArrayBuffer), narrower than what Blob's
        // constructor accepts — copy into a plain Uint8Array to satisfy
        // that, not just to appease TypeScript.
        const bytes = data instanceof Uint8Array ? new Uint8Array(data) : new Uint8Array();
        results.push({
          blob: new Blob([bytes], { type: "audio/mp4" }),
          language: stream.language,
          audioIndex: stream.audioIndex,
        });
      } catch {
        // Skip a stream we couldn't extract (e.g. an unusual codec that
        // can't be stream-copied into this container) rather than
        // failing the whole upload over one bad track.
      } finally {
        try {
          await ffmpeg.deleteFile(outputName);
        } catch {
          // Nothing to clean up if the extraction itself failed.
        }
      }
    }
    return results;
  } finally {
    try {
      await ffmpeg.deleteFile(inputName);
    } catch {
      // Nothing to clean up if writeFile itself failed.
    }
  }
}
