/*
  EGYSZERI, user által kért visszamenőleges company-backfill (2026-07-12) —
  futtatás után ez a fájl TÖRLENDŐ a repóból.

  A kereső-listákról már leesett, de még AKTÍV talent/nofluffjobs sorok
  cégnevét a detail-oldal JSON-LD-jéből (hiringOrganization) tölti ki.
  CSAK company IS NULL sorokat ír; meglévő értéket sosem írna felül.
  A kinyerési logika dry-runban validálva 42/42 sorra (lokális
  backfill_company_oneoff.mjs, 2026-07-12).

  Trigger: POST + Authorization: Bearer $CRON_SECRET (dispatcher-minta).
*/

import { Pool } from "pg";
import { withTimeout } from "./_error-logger.mjs";
import { purgeBlockedCompanies } from "./_company_blocklist.mjs";

const connectionString = process.env.NETLIFY_DATABASE_URL;
if (!connectionString) throw new Error("NETLIFY_DATABASE_URL is not set");

const pool = new Pool({
  connectionString,
  ssl: { rejectUnauthorized: false },
});

const UA = { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function extractCompany(html) {
  // JSON-LD JobPosting → hiringOrganization.name; a talent @graph-ba, az nfj
  // tömbbe csomagolja a JobPostingot
  for (const m of html.matchAll(/<script[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const raw = JSON.parse(m[1].trim());
      const items = Array.isArray(raw) ? raw : raw["@graph"] ? raw["@graph"] : [raw];
      for (const j of items) {
        const t = j["@type"];
        if (t === "JobPosting" || (Array.isArray(t) && t.includes("JobPosting"))) {
          const name = j.hiringOrganization?.name ?? j.hiringOrganization?.legalName;
          if (name && String(name).trim()) return String(name).trim().slice(0, 200);
        }
      }
    } catch { /* következő blokk */ }
  }
  const m2 = html.match(/"hiringOrganization"[\s\S]{0,200}?"name"\s*:\s*"([^"]{2,200})"/);
  if (m2) return m2[1].trim();
  // talent fallback: <title>Pozíció – Cégnév – Munka Város</title>
  const m3 = html.match(/<title>[^<]*?–\s*([^–<]{2,120}?)\s*–\s*Munka/);
  if (m3) return m3[1].trim();
  return null;
}

const _runJob = withTimeout("oneoff_company_backfill", async () => {
  const client = await pool.connect();
  try {
    const { rows: work } = await client.query(
      `SELECT source, url, title FROM job_posts
        WHERE source = ANY($1::text[]) AND active = true AND company IS NULL`,
      [["talent", "nofluffjobs"]]
    );
    console.log(`[oneoff_company_backfill] worklist: ${work.length} sor`);

    let updated = 0, noSignal = 0, failed = 0;
    for (const r of work) {
      await sleep(1500);
      let company = null;
      // az nfj SSR nem determinisztikus, a talentnél meg gyanítható egy
      // Netlify-egress rate-limit (helyi fetch mindig sikerült ugyanarra az
      // url-re) → hosszabb, növekvő backoff, több próba
      for (let attempt = 0; attempt < 4 && !company; attempt++) {
        if (attempt) await sleep(3000 * attempt);
        try {
          const resp = await fetch(r.url, { headers: UA, redirect: "follow" });
          if (!resp.ok) { console.log(`  -- ${resp.status} ${r.url}`); break; }
          company = extractCompany(await resp.text());
        } catch (e) {
          failed++;
          console.log(`  ERR ${e.message} ${r.url}`);
          break;
        }
      }
      if (!company) { noSignal++; continue; }
      const res = await client.query(
        `UPDATE job_posts SET company = $1
          WHERE source = $2 AND url = $3 AND company IS NULL`,
        [company, r.source, r.url]
      );
      updated += res.rowCount;
      console.log(`  OK [${r.source}] ${company} <- ${(r.title || "").slice(0, 50)}`);
    }

    // A most kitöltött cégnevek közt blocklistás is van (DT/Telekom/Bosch a
    // talentnél) — a standing szabály szerinti purge-öt azonnal lefuttatjuk,
    // ne várjon a következő óránkénti runig.
    const purged = await purgeBlockedCompanies(client, "talent");

    console.log(`[oneoff_company_backfill] kész: updated=${updated} no-signal=${noSignal} fetch-fail=${failed} purged=${purged} / ${work.length}`);
  } finally {
    client.release();
  }
  return new Response("OK");
});

export default async (request) => {
  const auth = (request.headers.get("authorization") || "").trim();
  const token = auth.replace(/^Bearer\s+/i, "").trim();
  const expected = process.env.CRON_SECRET;
  if (!expected || token !== expected) {
    return new Response("Unauthorized", { status: 401 });
  }
  return _runJob(request);
};
