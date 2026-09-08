// netlify/functions/tmp-wherewework-diag.mjs
//
// ELDOBHATÓ, egyszer használatos diagnosztikai endpoint (2026-09-08).
//
// Előzmény: két, a wherewework.hu-n élőben megerősítetten fent lévő hirdetés
// ("Validation Engineer, API" — Debrecen, Healthcare & Pharmaceuticals
// Employers in Hungary, feladva 2026.08.02.; "3D labor gyakornok" — Bosch,
// Hatvan, feladva 2026.06.17.) nincs bent a `job_posts`-ban / a pestidev.hu
// frontendjén. A `cron_jobs_DIAK_3-background.mjs` wherewework-lapozását
// időközben self-scaling cap-re állítottuk (ld. a fájl "Self-scaling cap"
// kommentjét), de ez csak az EGYIK gyanús ok (a lapozási cap korábban majdnem
// kifutott: 90 oldal / jelenleg 892 találat). A MÁSIK gyanús ok a `job_filters`
// cím-denylist — ezt innen, éles DB-kapcsolattal lehet csak ellenőrizni (ez a
// session, ahonnan a scrapert vizsgáltuk, nem lát DB-t).
//
// Ez az endpoint NEM ír semmit, csak olvas — biztonságos többször futtatni.
// Használat után `git rm netlify/functions/tmp-wherewework-diag.mjs`.
//
//   BASE=https://bakan7.netlify.app/.netlify/functions/tmp-wherewework-diag
//   curl -s "$BASE?token=TOKEN" | jq .

import pkg from "pg";
const { Pool } = pkg;
import { shouldSkipTitleFilter, getBlockingFilterWord } from "./_seniority_policy.mjs";

const TOKEN = "tmp-ww-diag-6f3c1a9e";

const pool = new Pool({
  connectionString: process.env.NETLIFY_DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// A két élőben megerősített, hiányzó hirdetés — a wherewework kártyáján
// pontosan ilyen (dátum-utótag nélküli, cleanWhereweworkTitle utáni) címmel
// jelennek meg.
const KNOWN_MISSING = [
  { title: "Validation Engineer, API", url: "https://www.wherewework.hu/en/jobs/validation-engineer-api/174892" },
  { title: "3D labor gyakornok", url: "https://www.wherewework.hu/en/jobs/3d-labor-gyakornok/172546" },
];

// A pharma/gyártás-jellegű címek gyanús, esetlegesen túl széles denylist-szavai
// — nem állítjuk, hogy ezek tényleg benne vannak a job_filters-ben, csak
// megnézzük, mi illeszkedne rájuk, ha igen.
const SUSPECT_WORD_PATTERN =
  "(^|[^a-z0-9])(validation|process|packaging|pharma|gyogyszer|gmp|qa|qc|sterile|api|labor)([^a-z0-9]|$)";

async function fetchText(url) {
  const res = await fetch(url, {
    headers: { "User-Agent": "JobWatcher-Diag/1.0" },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.text();
}

export default async (req) => {
  const url = new URL(req.url);
  if ((url.searchParams.get("token") || "").trim() !== TOKEN) {
    return new Response("unauthorized", { status: 401 });
  }

  const client = await pool.connect();
  try {
    // 1) A két konkrét hirdetés: job_filters szűrné-e a címét, és bent van-e
    //    már a DB-ben (bármilyen active-állapotban)?
    const { rows: filters } = await client.query(`SELECT word FROM job_filters ORDER BY word`);
    const titleChecks = KNOWN_MISSING.map((item) => ({
      title: item.title,
      url: item.url,
      wouldBeFiltered: shouldSkipTitleFilter(item.title, filters),
      blockingWord: getBlockingFilterWord(item.title, filters),
    }));

    const dbRows = await client.query(
      `SELECT url, title, source, active, experience, first_seen
       FROM job_posts
       WHERE url = ANY($1::text[])`,
      [KNOWN_MISSING.map((i) => i.url)]
    );

    // 2) Gyanús, pharma/gyártás-jellegű denylist-szavak — ha ezek közül bármelyik
    //    tényleg job_filters-szó, az önmagában megmagyarázhatja a kiesést,
    //    függetlenül a fenti két konkrét címtől.
    const suspectWords = await client.query(
      `SELECT word FROM job_filters WHERE word ~* $1 ORDER BY word`,
      [SUSPECT_WORD_PATTERN]
    );

    // 3) A wherewework forrás jelenlegi állapota a DB-ben: mennyi aktív sor van,
    //    mikori a legrégebbi/legújabb first_seen — ha a legújabb sor napokkal
    //    ezelőtti, az arra utal, hogy a cron mostanában nem futott le sikeresen
    //    (vagy a lapozási cap tényleg rendszeresen csonkolja a listát).
    const wwStats = await client.query(
      `SELECT COUNT(*)::int AS active_count, MIN(first_seen) AS oldest, MAX(first_seen) AS newest
       FROM job_posts WHERE source = 'wherewework' AND active = true`
    );

    // 4) Élő cap-ellenőrzés: a wherewework.hu #jobs-total mezője + a lapozás
    //    "self-scaling" logikájával ugyanúgy számolt szükséges oldalszám, hogy
    //    lássuk, a mostani (immár self-scaling) cap valóban lefedi-e a teljes
    //    listát.
    let liveCapCheck = null;
    try {
      const html = await fetchText("https://www.wherewework.hu/en/jobs/budaors,budapest");
      const totalMatch = html.match(/id="jobs-total"[^>]*>\s*([\d\s]+)\s*results/i);
      const lastPageMatch = [...html.matchAll(/[?&]page=(\d+)"/g)].map((m) => parseInt(m[1], 10));
      const totalResults = totalMatch ? parseInt(totalMatch[1].replace(/\s/g, ""), 10) : null;
      const maxPageSeen = lastPageMatch.length ? Math.max(...lastPageMatch) : null;
      liveCapCheck = { totalResults, maxPageLinkSeen: maxPageSeen };
    } catch (err) {
      liveCapCheck = { error: err.message };
    }

    return new Response(
      JSON.stringify(
        {
          titleChecks,
          dbRows: dbRows.rows,
          dbRowsFound: dbRows.rowCount,
          note:
            dbRows.rowCount > 0
              ? "A sor MÁR bent van a DB-ben — ha mégsem látszik a frontenden, az egy megjelenítési/szűrési kérdés (pl. active=false, vagy experience='senior' és a frontend elrejti), NEM ingest-hiány."
              : "A sor NINCS bent a DB-ben — vagy a job_filters szűrte ki insert előtt (ld. titleChecks), vagy a lapozás sosem érte el (ld. liveCapCheck).",
          suspectFilterWords: suspectWords.rows,
          wherewworkDbStats: wwStats.rows[0],
          liveCapCheck,
        },
        null,
        2
      ),
      { headers: { "Content-Type": "application/json" } }
    );
  } finally {
    client.release();
  }
};
