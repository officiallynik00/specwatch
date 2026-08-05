import { NextResponse } from "next/server";

const BUCKET_ID = "4abfd2b107d4cbe99dff0b14";

export async function GET() {
  try {
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

    // v3 nests these under apiInfo.storageApi, not at the top level.
    const apiUrl = auth.apiInfo?.storageApi?.apiUrl;
    const authToken = auth.authorizationToken;
    const accountId = auth.accountId;

    if (!apiUrl || !authToken) {
      return NextResponse.json({ error: "Unexpected auth response shape", detail: auth }, { status: 500 });
    }

    const updateRes = await fetch(`${apiUrl}/b2api/v3/b2_update_bucket`, {
      method: "POST",
      headers: {
        Authorization: authToken,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        accountId,
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
