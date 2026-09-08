// netlify/functions/cron_job_events-background.mjs
//
// Napi cron: beolvassa az `event_sources` regiszterben (event-sources.js-en
// keresztül karbantartott) listing oldalakat, AI-val (_ai_events_extract_core)
// kinyeri a rajtuk hirdetett közelgő állásbörzéket/eventeket, és beolvasztja
// a "job-events" Blobba (_job_events_store.mjs) — az a blob a jövőbeli
// eseményeket tárolja, a lejárt (mai nap előtti) sorokat minden futás
// eldobja, forrás nélkül is (ld. mergeAndPurgeEvents).
//
// Direkt ütemezve `config.schedule`-lel, mint a cron_daily_stats.mjs — nem a
// cron_scheduler dispatcheren keresztül, mert ez alacsony gyakoriságú (napi)
// és nem kell staggerelni. Netlify saját ütemezett hívása nem küld
// CRON_SECRET bearer-t, ezért — pont úgy, mint cron_daily_stats.mjs-nél —
// nincs itt bejövő auth-ellenőrzés.

export const config = {
  schedule: "30 5 * * *", // minden nap 05:30 UTC
};

import { Pool } from "pg";
import { withTimeout } from "./_error-logger.mjs";
import { extractEventsLLM, estimateCost, fetchListingPage } from "./_ai_events_extract_core.mjs";
import { mergeAndPurgeEvents } from "./_job_events_store.mjs";

const connectionString = process.env.NETLIFY_DATABASE_URL;
if (!connectionString) throw new Error("NETLIFY_DATABASE_URL is not set");

const pool = new Pool({ connectionString, ssl: { rejectUnauthorized: false } });

async function ensureTable(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS event_sources (
      site        text PRIMARY KEY,
      list_url    text NOT NULL,
      mode        text NOT NULL DEFAULT 'llm-read',
      last_ok     timestamptz,
      fail_streak int NOT NULL DEFAULT 0
    )
  `);

  // Két explicit jóváhagyott forrás (2026-09-08, user-döntés) — ugyanaz a
  // first-run seed minta, mint az ujbudaiallasok az ai_extractors táblában:
  // ON CONFLICT DO NOTHING, hogy egy operátor később szabadon módosíthassa
  // (mode/list_url) anélkül, hogy ez a seed visszaírná. Az eredeti URL-eken
  // Facebook UTM/fbclid tracking paraméterek voltak, azokat itt levágtuk.
  await client.query(
    `INSERT INTO event_sources (site, list_url)
     VALUES ($1, $2), ($3, $4)
     ON CONFLICT (site) DO NOTHING`,
    [
      "epam", "https://campus.epam.com/en/event/188",
      "progmasters", "https://www.progmasters.hu/esemenyek/nyilt-nap",
    ]
  );
}

async function runSite(client, site) {
  let html;
  try {
    html = await fetchListingPage(site.list_url);
  } catch (err) {
    await client.query(`UPDATE event_sources SET fail_streak = fail_streak + 1 WHERE site = $1`, [site.site]);
    console.error(`[job-events] ${site.site}: fetch failed — ${err.message}`);
    return [];
  }

  try {
    const { events, usage } = await extractEventsLLM(html, { baseUrl: site.list_url });
    await client.query(`UPDATE event_sources SET last_ok = NOW(), fail_streak = 0 WHERE site = $1`, [site.site]);
    console.log(
      `[job-events] ${site.site}: found=${events.length} cost=$${estimateCost(usage).toFixed(4)}`
    );
    return events.map((e) => ({ ...e, source: site.site }));
  } catch (err) {
    await client.query(`UPDATE event_sources SET fail_streak = fail_streak + 1 WHERE site = $1`, [site.site]);
    console.error(`[job-events] ${site.site}: extraction failed — ${err.message}`);
    return [];
  }
}

export default withTimeout("cron_job_events-background", async () => {
  const client = await pool.connect();
  let sites = [];
  try {
    await ensureTable(client);
    ({ rows: sites } = await client.query(
      `SELECT site, list_url FROM event_sources WHERE mode <> 'disabled' ORDER BY site`
    ));

    const collected = [];
    for (const site of sites) {
      try {
        collected.push(...(await runSite(client, site)));
      } catch (err) {
        // Egy forrás hibája sosem állíthatja meg a többit.
        console.error(`[job-events] ${site.site}: unexpected error — ${err.message}`);
      }
    }

    const { events } = await mergeAndPurgeEvents(collected);
    console.log(
      `[job-events] sources=${sites.length} collected=${collected.length} stored_after_purge=${events.length}`
    );
  } finally {
    client.release();
  }
  return new Response("OK");
});
