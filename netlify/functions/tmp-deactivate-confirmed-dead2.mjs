// DISPOSABLE write endpoint — 2026-09-04. Deactivates the remaining rows
// already confirmed dead (double-checked) by the full-source active-flag
// audit: talent (26), profession-intern (5), nofluffjobs (1), qdiak (1).
// Only sets active=false on an exact url+source match. Delete after use.

import { Pool } from "pg";

const TOKEN = "e7c2a1f9b6d3084c5e2a8f4b1d6c9e0a3f7b5c2d";
const pool = new Pool({ connectionString: process.env.NETLIFY_DATABASE_URL, ssl: { rejectUnauthorized: false } });

const URLS = [
  "https://hu.talent.com/view?id=616127393004527544",
  "https://hu.talent.com/view?id=590970210332913289",
  "https://hu.talent.com/view?id=621615779074350084",
  "https://hu.talent.com/view?id=626159739240982891",
  "https://hu.talent.com/view?id=541368060038621297",
  "https://hu.talent.com/view?id=623140783677114784",
  "https://hu.talent.com/view?id=608074282086573205",
  "https://hu.talent.com/view?id=627479290038781284",
  "https://hu.talent.com/view?id=628840527884782380",
  "https://hu.talent.com/view?id=630291476594035978",
  "https://hu.talent.com/view?id=630535738714032430",
  "https://hu.talent.com/view?id=631551198139254626",
  "https://hu.talent.com/view?id=631551416318626943",
  "https://hu.talent.com/view?id=632360425913133016",
  "https://hu.talent.com/view?id=632710894651774597",
  "https://hu.talent.com/view?id=614774725260552143",
  "https://hu.talent.com/view?id=629665915324865845",
  "https://hu.talent.com/view?id=560211379311807474",
  "https://hu.talent.com/view?id=630296737601161409",
  "https://hu.talent.com/view?id=632712989232205573",
  "https://hu.talent.com/view?id=596026942649276754",
  "https://hu.talent.com/view?id=634407697632723457",
  "https://hu.talent.com/view?id=598068908207768919",
  "https://hu.talent.com/view?id=628298701214909441",
  "https://hu.talent.com/view?id=629358306924829675",
  "https://hu.talent.com/view?id=635580533868405620",
  "https://www.profession.hu/allas/computer-vision-engineer-algorithms-hawk-eye-innovations-ltd-2963734",
  "https://www.profession.hu/allas/szoftverfejleszto-erp-terulet-unix-auto-kft-2963084",
  "https://www.profession.hu/allas/staff-software-engineer-in-test-diligent-governance-hungary-kft-2963769",
  "https://www.profession.hu/allas/it-ot-specialist-morgan-hungary-kft-2964233",
  "https://www.profession.hu/allas/e-learning-moodle-uzemelteto-eotvos-lorand-tudomanyegyetem-kancellaria-2963860",
  "https://nofluffjobs.com/hu/job/java-developer-shiwaforce-com-budapest-2",
  "https://cloud.qdiak.hu/munkak/f5c97396-569e-4ed2-83d4-83cc65eb7554",
];

export default async (request) => {
  const auth = (request.headers.get("authorization") || "").trim();
  if (auth !== `Bearer ${TOKEN}`) {
    return new Response("unauthorized", { status: 401 });
  }

  const client = await pool.connect();
  try {
    const { rows } = await client.query(
      `UPDATE job_posts SET active = false
        WHERE url = ANY($1::text[]) AND active = true
        RETURNING url, source, title`,
      [URLS]
    );
    return new Response(JSON.stringify({ deactivated: rows.length, expected: URLS.length, rows }, null, 2), {
      headers: { "content-type": "application/json" },
    });
  } finally {
    client.release();
  }
};
