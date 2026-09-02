// DISPOSABLE one-off endpoint. Hard-deletes 8 specific AI-scraped rows that
// were already deactivated as confirmed URL-variant duplicates of an
// already-tracked row (2026-09-02). User asked for a real DELETE, not just
// active=false. Remove this file after invoking once.
import { Pool } from "pg";

const connectionString = process.env.NETLIFY_DATABASE_URL;
if (!connectionString) throw new Error("NETLIFY_DATABASE_URL is not set");
const pool = new Pool({ connectionString, ssl: { rejectUnauthorized: false } });

const TOKEN = "W1SeUgFkCUY-yHPzlbFBPhUdm4ZAgvIj";

const URLS = [
  "https://karrier.nisz.hu/tesztautomatizalo-mernok/",
  "https://karrier.nisz.hu/ip-halozatuzemelteto/",
  "https://www.secretsaucepartners.com/jobs/software-tester-qa?hsLang=en",
  "https://www.keler.hu/KELER/Root/Content/Sites/keler/KELER/Karrier/2026/2026_05_28_%C3%81ll%C3%A1shirdet%C3%A9s_IT%20rendszerm%C3%A9rn%C3%B6k.pdf",
  "https://www.keler.hu/KELER/Root/Content/Sites/keler/KELER/Karrier/2025/2026_01_14_All%C3%A1shirdetes_middleware%20rendszerszervezo.pdf",
  "https://www.icellmobilsoft.hu/karrier/devops-engineer",
  "https://www.icellmobilsoft.hu/karrier/it-business-analyst",
  "https://www.icellmobilsoft.hu/karrier/java-developer",
];

export default async (request) => {
  const auth = (request.headers.get("authorization") || "").replace(/^Bearer\s+/i, "").trim();
  if (auth !== TOKEN) return new Response("Unauthorized", { status: 401 });

  const client = await pool.connect();
  try {
    const res = await client.query(
      `DELETE FROM job_posts WHERE source = 'AI-scraped' AND url = ANY($1::text[]) RETURNING url`,
      [URLS]
    );
    return new Response(JSON.stringify({ deleted: res.rows.map((r) => r.url), requested: URLS.length }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } finally {
    client.release();
  }
};
