import { NextRequest, NextResponse } from "next/server";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

// Server-only env vars — never prefix these with NEXT_PUBLIC_. The R2
// secret key must not reach the browser; the browser only ever gets a
// short-lived presigned URL scoped to one object.
const r2 = new S3Client({
  region: "auto",
  endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID!,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY!,
  },
});

const BUCKET = process.env.R2_BUCKET_NAME!;

/**
 * Issues a presigned PUT URL for a single object. The browser uploads
 * straight to R2 with this URL — the file never passes through our own
 * server, so there's no Vercel body-size limit or extra bandwidth cost
 * on our side.
 */
export async function POST(req: NextRequest) {
  if (!process.env.R2_ACCOUNT_ID || !process.env.R2_ACCESS_KEY_ID || !process.env.R2_SECRET_ACCESS_KEY || !BUCKET) {
    return NextResponse.json(
      { error: "R2 isn't configured on the server — check R2_* env vars." },
      { status: 500 }
    );
  }

  let body: { path?: string; contentType?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const { path, contentType } = body;
  if (!path || typeof path !== "string") {
    return NextResponse.json({ error: "Missing 'path'." }, { status: 400 });
  }
  // Defense in depth: reject attempts to escape the intended room-scoped
  // prefix (e.g. "../../something") even though callers control this.
  if (path.includes("..") || path.startsWith("/")) {
    return NextResponse.json({ error: "Invalid path." }, { status: 400 });
  }

  try {
    const command = new PutObjectCommand({
      Bucket: BUCKET,
      Key: path,
      ContentType: contentType || "application/octet-stream",
    });
    const url = await getSignedUrl(r2, command, { expiresIn: 3600 });
    return NextResponse.json({ url });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to sign upload URL." },
      { status: 500 }
    );
  }
}
