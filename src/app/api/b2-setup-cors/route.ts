import { NextResponse } from "next/server";

const BUCKET_ID = "4abfd2b107d4cbe99dff0b14";

export async function GET() {
  try {
    // Step 1: authenticate against the B2 Native API using Basic auth
    // (keyID:applicationKey), which is different from how the S3-compatible
    // client authenticates.
    const authRes = await fetch("https://api.backblazeb2.com/b2api/v3/b2_authorize_account", {
      headers: {
        Authorization:
          "Basic " +
          Buffer.from(`${process.env.B2_KEY_ID}:${process.env.B2_APPLICATION_KEY}`).toString("base64"),
      },
    });
    const auth = await authRes.json();
    if (!authRes.ok) {
      return NextResponse.json({ error: "Auth failed", detail: auth }, { status: 500 });
    }

    // Step 2: update the bucket's CORS rules via the Native API, using
    // s3_* operation names so the rule also covers S3-compatible requests
    // (this is documented B2 behavior — one native-format rule can list
    // both b2_* and s3_* operations).
    const updateRes = await fetch(`${auth.apiUrl}/b2api/v3/b2_update_bucket`, {
      method: "POST",
      headers: {
        Authorization: auth.authorizationToken,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        accountId: auth.accountId,
        bucketId: BUCKET_ID,
        corsRules: [
          {
            corsRuleName: "specwatchUploads",
            allowedOrigins: ["http://localhost:3000", "https://specwatch.vercel.app"],
            allowedOperations: ["s3_put", "s3_get", "s3_head", "s3_delete"],
            allowedHeaders: ["*"],
            exposeHeaders: ["etag"],
            maxAgeSeconds: 3600,
          },
        ],
      }),
    });
    const result = await updateRes.json();
    if (!updateRes.ok) {
      return NextResponse.json({ error: "Update failed", detail: result }, { status: 500 });
    }

    return NextResponse.json({ ok: true, corsRules: result.corsRules });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Unexpected error." },
      { status: 500 }
    );
  }
}
