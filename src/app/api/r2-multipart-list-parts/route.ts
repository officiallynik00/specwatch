import { NextRequest, NextResponse } from "next/server";
import { ListPartsCommand } from "@aws-sdk/client-s3";
import { b2, B2_BUCKET, b2Configured, isValidPath } from "@/lib/b2";

/**
 * Returns which parts B2 actually has for this uploadId, with their
 * ETags and sizes. This is deliberately the source of truth for resuming
 * an upload — not whatever a browser's localStorage remembers, which
 * could be stale (cleared cache, a different device, an upload that was
 * aborted server-side after the browser recorded it as in-progress).
 * The browser diffs this against what the file needs and only re-uploads
 * whatever's actually missing.
 */
export async function POST(req: NextRequest) {
  if (!b2Configured()) {
    return NextResponse.json({ error: "B2 isn't configured on the server — check B2_* env vars." }, { status: 500 });
  }

  let body: { path?: string; uploadId?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  if (!isValidPath(body.path) || !body.uploadId) {
    return NextResponse.json({ error: "Missing or invalid path/uploadId." }, { status: 400 });
  }

  try {
    const parts: { PartNumber: number; ETag: string; Size: number }[] = [];
    let marker: string | undefined;
    // Paginate — a max-size (5GB / 10MB-part) upload has ~500 parts,
    // under the 1000-per-page default, but this stays correct regardless.
    for (;;) {
      const page = await b2.send(
        new ListPartsCommand({
          Bucket: B2_BUCKET,
          Key: body.path,
          UploadId: body.uploadId,
          PartNumberMarker: marker,
        })
      );
      for (const p of page.Parts ?? []) {
        if (p.PartNumber != null && p.ETag && p.Size != null) {
          parts.push({ PartNumber: p.PartNumber, ETag: p.ETag, Size: p.Size });
        }
      }
      if (!page.IsTruncated) break;
      marker = page.NextPartNumberMarker;
    }
    return NextResponse.json({ parts });
  } catch (err) {
    // A common, expected case here: the uploadId is gone (expired,
    // already completed, or never existed on this bucket) — the caller
    // treats a failure here as "no resumable session" and starts fresh
    // rather than surfacing this as a hard error.
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to list parts.", notFound: true },
      { status: 404 }
    );
  }
}
