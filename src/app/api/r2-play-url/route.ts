import { NextRequest, NextResponse } from "next/server";
import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

const b2 = new S3Client({
  region: "us-east-005",
  endpoint: "https://s3.us-east-005.backblazeb2.com",
  credentials: {
    accessKeyId: process.env.B2_KEY_ID!,
    secretAccessKey: process.env.B2_APPLICATION_KEY!,
  },
});

const BUCKET = process.env.B2_BUCKET_NAME!;

/**
 * Issues a short-lived presigned GET URL so the <video> element can stream
 * the file straight from B2. The bucket is private, so without this the
 * browser has no way to reach the object at all.
 */
export async function POST(req: NextRequest) {
  if (!process.env.B2_KEY_ID || !process.env.B2_APPLICATION_KEY || !BUCKET) {
    return NextResponse.json(
      { error: "B2 isn't configured on the server — check B2_* env vars." },
      { status: 500 }
    );
  }

  let body: { path?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const { path } = body;
  if (!path || typeof path !== "string" || path.includes("..") || path.startsWith("/")) {
    return NextResponse.json({ error: "Invalid path." }, { status: 400 });
  }

  try {
    const command = new GetObjectCommand({ Bucket: BUCKET, Key: path });
    // Longer expiry than the upload URL is fine here — playback sessions
    // can run long, and a leaked GET URL only exposes one video file, not
    // write access to the bucket.
    const url = await getSignedUrl(b2, command, { expiresIn: 3600 * 4 });
    return NextResponse.json({ url });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to sign playback URL." },
      { status: 500 }
    );
  }
}