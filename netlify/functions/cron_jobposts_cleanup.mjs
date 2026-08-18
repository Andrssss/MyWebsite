// netlify/functions/cron_jobposts_cleanup.mjs
// Havonta egyszer (1-jén 03:00 UTC) archiválja a régóta inaktív job_posts
// sorokat Netlify Blobs-ba, majd törli őket az adatbázisból. Ugyanaz a
// mintázat, mint cron_stats_cleanup.mjs a job_daily_stats-nál.
//
// Küszöb (ARCHIVE_AFTER_DAYS = 60): egy inaktív sort csak akkor archiválunk,
// ha már túl van MINDKÉT élő kódúton, ami még hozzányúlhatna:
//   - jobs.js csak akkor mutat egy inaktív sort, ha first_seen az utolsó 30
//     napban van (lásd active_core.mjs / jobs.js "active = true OR first_seen
//     >= NOW() - 30 days" szűrő) — 30 nap után a frontend már úgysem látja.
//   - reviveSweepDead (_active_core.mjs) csak REVIVE_MAX_AGE_DAYS=45 napnál
//     fiatalabb inaktív sorokat vizsgál újra self-healing céljából.
// 60 nap biztos tartalékot ad mindkét fölött, úgyhogy ami ide kerül, azt élő
// kód többé nem olvassa vissza — bátran törölhető a select után.
//
// LinkedIn KIVÉTEL (user-döntés 2026-08-18): a LinkedIn sosem használja az
// active modellt (reconcileActive nem fut rá, ld. jobs.js TIME_BASED_SOURCES
// / _active_core.mjs) — a sorai gyakorlatilag örökké active=true maradnak,
// úgyhogy az "active = false" feltétel ŐKET SOHA nem engedné archiválni. A
// frontend rájuk is ugyanazt a 30 napos first_seen-alapú ablakot alkalmazza
// (jobs.js), tehát 60 nap után ők is ugyanúgy láthatatlanok — ezért a
// LinkedIn forrásnál az active flag-től FÜGGETLENÜL archiválunk, kizárólag
// first_seen alapján. Minden más forrásnál változatlanul active=false kell.
//
// A job_posts identitása (source, url) — ez alapján töröljük ugyanazokat a
// sorokat, amiket archiváltunk (nem egy külön WHERE-újrafuttatással, hogy egy
// közben (nagyon valószínűtlenül) újraaktivált sort ne törölhessünk).

import { getStore } from "@netlify/blobs";
import pkg from "pg";
const { Pool } = pkg;
import { withDbAuditFlush } from "./_db_audit.js";

const connectionString = process.env.NETLIFY_DATABASE_URL;
if (!connectionString) throw new Error("NETLIFY_DATABASE_URL is not set");

const pool = new Pool({
  connectionString,
  ssl: { rejectUnauthorized: false },
});

const STORE_NAME = "job-posts-archive";
const ARCHIVE_AFTER_DAYS = 60;
const TIME_BASED_ONLY_SOURCES = ["LinkedIn"];

export const config = {
  schedule: "0 3 1 * *", // havonta 1-jén 03:00 UTC (a stats/backup cleanup-ok után)
};

// Óra is a névben, hogy egy ugyanaznapi kézi újrafuttatás (pl. tesztelés)
// ne írja felül az előző futás blobját ugyanazon a napon.
function budapestDateHourStamp() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Budapest",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date());
  const get = (type) => parts.find((p) => p.type === type)?.value;
  return `${get("year")}-${get("month")}-${get("day")}-${get("hour")}`;
}

export default withDbAuditFlush("cron_jobposts_cleanup", async function handler() {
  const client = await pool.connect();
  try {
    const { rows: oldPosts } = await client.query(
      `SELECT * FROM job_posts
        WHERE first_seen < NOW() - make_interval(days => $1::int)
          AND (source = ANY($2::text[]) OR active = false)
        ORDER BY first_seen`,
      [ARCHIVE_AFTER_DAYS, TIME_BASED_ONLY_SOURCES]
    );

    if (oldPosts.length === 0) {
      console.log(
        `[jobposts_cleanup] Nincs ${ARCHIVE_AFTER_DAYS} napnál régebbi inaktív sor, kihagyva.`
      );
      return;
    }

    const key = `job-posts-archive-${budapestDateHourStamp()}.json`;
    const store = getStore(STORE_NAME);

    await store.set(
      key,
      JSON.stringify(
        {
          exportedAt: new Date().toISOString(),
          archiveAfterDays: ARCHIVE_AFTER_DAYS,
          count: oldPosts.length,
          rows: oldPosts,
        },
        null,
        2
      ),
      { metadata: { type: "job-posts-archive", count: oldPosts.length } }
    );

    const sources = oldPosts.map((r) => r.source);
    const urls = oldPosts.map((r) => r.url);

    const { rowCount: deleted } = await client.query(
      `DELETE FROM job_posts
        WHERE (source, url) IN (
          SELECT s, u FROM unnest($1::text[], $2::text[]) AS t(s, u)
        )
          AND (source = ANY($3::text[]) OR active = false)`,
      [sources, urls, TIME_BASED_ONLY_SOURCES]
    );

    console.log(
      `[jobposts_cleanup] Archived to ${key}: ${oldPosts.length} rows. Deleted: ${deleted}`
    );
  } catch (err) {
    console.error("[jobposts_cleanup] Error:", err);
  } finally {
    client.release();
  }
});
