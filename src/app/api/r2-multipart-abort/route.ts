import { NextRequest, NextResponse } from "next/server";
import { AbortMultipartUploadCommand } from "@aws-sdk/client-s3";
import { b2, B2_BUCKET, b2Configured, isValidPath } from "@/lib/b2";

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
    await b2.send(new AbortMultipartUploadCommand({ Bucket: B2_BUCKET, Key: body.path, UploadId: body.uploadId }));
    return NextResponse.json({ ok: true });
  } catch (err) {
    // Non-fatal from the caller's perspective either way — an already-
    // gone uploadId is fine to treat as "already cleaned up".
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to abort multipart upload." },
      { status: 500 }
    );
  }
}
