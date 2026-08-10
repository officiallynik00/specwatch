import { NextRequest, NextResponse } from "next/server";
import { CreateMultipartUploadCommand } from "@aws-sdk/client-s3";
import { b2, B2_BUCKET, b2Configured, isValidPath } from "@/lib/b2";

export async function POST(req: NextRequest) {
  if (!b2Configured()) {
    return NextResponse.json({ error: "B2 isn't configured on the server — check B2_* env vars." }, { status: 500 });
  }

  let body: { path?: string; contentType?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  if (!isValidPath(body.path)) {
    return NextResponse.json({ error: "Invalid path." }, { status: 400 });
  }

  try {
    const result = await b2.send(
      new CreateMultipartUploadCommand({
        Bucket: B2_BUCKET,
        Key: body.path,
        ContentType: body.contentType || "application/octet-stream",
      })
    );
    return NextResponse.json({ uploadId: result.UploadId });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to start multipart upload." },
      { status: 500 }
    );
  }
}
