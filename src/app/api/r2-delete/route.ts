import { NextRequest, NextResponse } from "next/server";
import { S3Client, DeleteObjectCommand } from "@aws-sdk/client-s3";

const b2 = new S3Client({
  region: "us-east-005",
  endpoint: "https://s3.us-east-005.backblazeb2.com",
  credentials: {
    accessKeyId: process.env.B2_KEY_ID!,
    secretAccessKey: process.env.B2_APPLICATION_KEY!,
  },
});

const BUCKET = process.env.B2_BUCKET_NAME!;

export async function POST(req: NextRequest) {
  if (!process.env.B2_KEY_ID || !process.env.B2_APPLICATION_KEY || !BUCKET) {
    return NextResponse.json({ error: "B2 isn't configured on the server." }, { status: 500 });
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
    await b2.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: path }));
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to delete object." },
      { status: 500 }
    );
  }
}
