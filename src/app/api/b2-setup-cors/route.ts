import { NextResponse } from "next/server";
import { S3Client, PutBucketCorsCommand, GetBucketCorsCommand } from "@aws-sdk/client-s3";

const b2 = new S3Client({
  region: "us-east-005",
  endpoint: "https://s3.us-east-005.backblazeb2.com",
  credentials: {
    accessKeyId: process.env.B2_KEY_ID!,
    secretAccessKey: process.env.B2_APPLICATION_KEY!,
  },
});

export async function GET() {
  try {
    await b2.send(
      new PutBucketCorsCommand({
        Bucket: process.env.B2_BUCKET_NAME!,
        CORSConfiguration: {
          CORSRules: [
            {
              AllowedOrigins: [
                "http://localhost:3000",
                "https://specwatch.vercel.app",
              ],
              AllowedMethods: ["PUT", "GET", "HEAD"],
              AllowedHeaders: ["*"],
              ExposeHeaders: ["ETag"],
              MaxAgeSeconds: 3600,
            },
          ],
        },
      })
    );

    // Read it straight back so we can confirm in the response what's
    // actually stored on the bucket, not just that the call succeeded.
    const check = await b2.send(
      new GetBucketCorsCommand({ Bucket: process.env.B2_BUCKET_NAME! })
    );

    return NextResponse.json({ ok: true, appliedRules: check.CORSRules });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to set CORS." },
      { status: 500 }
    );
  }
}