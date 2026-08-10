import { S3Client } from "@aws-sdk/client-s3";

// Server-only — never prefix these env vars with NEXT_PUBLIC_. The B2
// application key must not reach the browser; every route that uses
// this only ever hands the browser a short-lived presigned URL scoped
// to one object (or, for multipart, one part of one object).
export const b2 = new S3Client({
  region: "us-east-005",
  endpoint: "https://s3.us-east-005.backblazeb2.com",
  credentials: {
    accessKeyId: process.env.B2_KEY_ID!,
    secretAccessKey: process.env.B2_APPLICATION_KEY!,
  },
});

export const B2_BUCKET = process.env.B2_BUCKET_NAME!;

export function b2Configured(): boolean {
  return Boolean(process.env.B2_KEY_ID && process.env.B2_APPLICATION_KEY && B2_BUCKET);
}

/** Same "no path traversal, no absolute paths" check every route needs. */
export function isValidPath(path: unknown): path is string {
  return typeof path === "string" && path.length > 0 && !path.includes("..") && !path.startsWith("/");
}
