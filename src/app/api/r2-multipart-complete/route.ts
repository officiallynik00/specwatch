import { NextRequest, NextResponse } from "next/server";
import { CompleteMultipartUploadCommand } from "@aws-sdk/client-s3";
import { b2, B2_BUCKET, b2Configured, isValidPath } from "@/lib/b2";

export async function POST(req: NextRequest) {
  if (!b2Configured()) {
    return NextResponse.json({ error: "B2 isn't configured on the server — check B2_* env vars." }, { status: 500 });
  }

  let body: { path?: string; uploadId?: string; parts?: { PartNumber: number; ETag: string }[] };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  if (!isValidPath(body.path) || !body.uploadId || !Array.isArray(body.parts) || body.parts.length === 0) {
    return NextResponse.json({ error: "Missing or invalid path/uploadId/parts." }, { status: 400 });
  }

  try {
    await b2.send(
      new CompleteMultipartUploadCommand({
        Bucket: B2_BUCKET,
        Key: body.path,
        UploadId: body.uploadId,
        // Parts must be ascending by PartNumber — sorted here rather
        // than trusting the caller to have kept them in order after
        // merging "already on B2" with "just uploaded this session".
        MultipartUpload: { Parts: [...body.parts].sort((a, b) => a.PartNumber - b.PartNumber) },
      })
    );
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to complete multipart upload." },
      { status: 500 }
    );
  }
}
