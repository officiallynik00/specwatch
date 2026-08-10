import { NextRequest, NextResponse } from "next/server";
import { UploadPartCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { b2, B2_BUCKET, b2Configured, isValidPath } from "@/lib/b2";

export async function POST(req: NextRequest) {
  if (!b2Configured()) {
    return NextResponse.json({ error: "B2 isn't configured on the server — check B2_* env vars." }, { status: 500 });
  }

  let body: { path?: string; uploadId?: string; partNumber?: number };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  if (!isValidPath(body.path) || !body.uploadId || !body.partNumber || body.partNumber < 1) {
    return NextResponse.json({ error: "Missing or invalid path/uploadId/partNumber." }, { status: 400 });
  }

  try {
    const command = new UploadPartCommand({
      Bucket: B2_BUCKET,
      Key: body.path,
      UploadId: body.uploadId,
      PartNumber: body.partNumber,
    });
    const url = await getSignedUrl(b2, command, { expiresIn: 3600 });
    return NextResponse.json({ url });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to sign part upload URL." },
      { status: 500 }
    );
  }
}
