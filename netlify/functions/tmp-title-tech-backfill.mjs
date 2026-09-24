// DISPOSABLE — 2026-09-24. One-time backfill for withTitleTechnologies()
// (_experience_core.mjs): every scraper now merges the TECH_KEYWORDS found in
// a posting's title into `technologies` at INSERT time, but rows inserted
// before that never got them (e.g. "AI Text Validation Specialist (Hungarian
// language)" without "Hungarian"). The title is already stored, so this is a
// pure SQL pass over ALL job_posts rows (active and inactive), no re-fetch.
// Delete after use.
//
//   GET  ?action=backfill&dryRun=1  → how many rows would change + samples
//   POST ?action=backfill           → apply
//   POST ?action=rebuild            → full-history rebuildStats() so
//                                     dailyLanguages/dailyTechnologies pick
//                                     it up (archive rows get the title merge
//                                     at read time in _stats_rebuild_core)
//
// Auth: Authorization: Bearer $ADMIN_SECRET (falls back to CRON_SECRET).

import { Pool } from "pg";
import { withTitleTechnologies } from "./_experience_core.mjs";
import { loadCategories } from "./load_categories.mjs";
import { rebuildStats } from "./_stats_rebuild_core.mjs";

const pool = new Pool({
  connectionString: process.env.NETLIFY_DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

const json = (body, status = 200) =>
  new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });

export default async (request) => {
  const secret = process.env.ADMIN_SECRET || process.env.CRON_SECRET;
  const auth = (request.headers.get("authorization") || "").trim();
  if (!secret || auth !== `Bearer ${secret}`) return json({ error: "unauthorized" }, 401);

  const url = new URL(request.url);
  const action = url.searchParams.get("action");
  const dryRun = request.method === "GET" || url.searchParams.get("dryRun") === "1";

  const client = await pool.connect();
  try {
    if (action === "backfill") {
      const { rows } = await client.query(`SELECT id, title, technologies FROM job_posts`);
      const changes = [];
      for (const r of rows) {
        const merged = withTitleTechnologies(r.technologies, r.title);
        if (merged !== (r.technologies || null)) {
          changes.push({ id: r.id, title: r.title, before: r.technologies, after: merged });
        }
      }
      if (!dryRun && changes.length) {
        await client.query("BEGIN");
        try {
          await client.query(
            `UPDATE job_posts AS j SET technologies = c.tech
               FROM UNNEST($1::bigint[], $2::text[]) AS c(id, tech)
              WHERE j.id = c.id`,
            [changes.map((c) => c.id), changes.map((c) => c.after)]
          );
          await client.query("COMMIT");
        } catch (err) {
          await client.query("ROLLBACK");
          throw err;
        }
      }
      return json({
        dryRun,
        scanned: rows.length,
        changed: changes.length,
        hungarianAdded: changes.filter(
          (c) => !String(c.before || "").includes("Hungarian") && c.after.includes("Hungarian")
        ).length,
        samples: changes.slice(0, 40),
      });
    }

    if (action === "rebuild" && !dryRun) {
      const summary = await rebuildStats(client, await loadCategories());
      return json({ ok: true, summary: { ...summary, perDay: undefined } });
    }

    return json({ error: "use ?action=backfill (GET=dry run, POST=apply) or POST ?action=rebuild" }, 400);
  } finally {
    client.release();
  }
};
