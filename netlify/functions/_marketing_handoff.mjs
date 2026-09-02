/* =========================================================================
   Marketing hand-off — nem-IT (marketing/sales/HR/admin) hirdetések átadása a
   testvérprojektnek (marketing_scraper, megkellelnemvalahogy.netlify.app).

   2026-09-02: az ats-crawl (cron_jobs_ATSCRAWL-background.mjs) ugyanazokat a
   cég-ATS-boardokat kéri le, amiket a marketing_scraper saját, önálló
   ATS-crawlere is aratott volna — két scraper, két lista-hívás, ugyanarra a
   boardra. Ahelyett hogy a duplikált crawlert életben tartanánk (törölve),
   az itt már úgyis lekért, IT-szempontból nem-releváns board-sorokat adjuk át
   a marketing_scraper MEGLÉVŐ ai-ingest.mjs végpontjának — pontosan ugyanazon
   a csatornán, amit az AI-scraped felderítő rutin "Step 5"-e is használ
   ([[marketing-scraper-project]] emlékezet), csak `source: "ATS"` címkével.

   Duplikáció: NEM ez a fájl felel érte. Az ai-ingest.mjs upsertje
   `ON CONFLICT (source, url) DO NOTHING`-gal insert-only, tehát egy már
   ismert hirdetés újraküldése ártalmatlan — és mivel a heti write-budget
   (_ai_rate_limit.mjs ottani oldalon) csak a TÉNYLEGESEN beszúrt sorokat
   számolja, egy `live` board óránkénti újraküldése a már ismert
   hirdetéseiről nem fogyasztja el a keretet, amin a felfedező rutin osztozik.
   Csak a ténylegesen ÚJ sorok számítanak bele.

   Fail-soft: a marketing_scraper elérhetetlensége vagy a token hiánya sosem
   állíthatja meg az ats-crawl futását (az IT-oldal a fő feladat) — minden hiba
   itt nyelődik el, csak naplózva.
   ========================================================================= */

const ENDPOINT = "https://megkellelnemvalahogy.netlify.app/.netlify/functions/ai-ingest";
const FETCH_TIMEOUT_MS = 15000;
const MAX_ROWS_PER_REQUEST = 100; // tükrözi az ottani _ai_rate_limit.mjs sapkáját

/**
 * @param {{title:string, url:string, experience?:string}[]} jobs
 * @returns {Promise<{inserted:number, skipped:boolean}|null>} null = hívás
 *   meg sem történt vagy elhasalt — a hívó ilyenkor nem tud és nem is kell
 *   tudnia semmit tenni, csak naplózni.
 */
export async function postMarketingCandidates(jobs) {
  if (!jobs || jobs.length === 0) return { inserted: 0, skipped: false };

  const token = process.env.MARKETING_AI_INGEST_TOKEN;
  if (!token) {
    console.warn("[marketing-handoff] MARKETING_AI_INGEST_TOKEN not set — skipping hand-off");
    return { inserted: 0, skipped: true };
  }

  const payload = {
    source: "ATS",
    jobs: jobs.slice(0, MAX_ROWS_PER_REQUEST).map((j) => ({
      title: j.title,
      url: j.url,
      experience: j.experience || undefined,
    })),
  };

  try {
    const res = await fetch(ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    const body = await res.json().catch(() => null);
    if (!res.ok) {
      console.error(`[marketing-handoff] HTTP ${res.status}: ${JSON.stringify(body)}`);
      return null;
    }
    console.log(
      `[marketing-handoff] sent=${payload.jobs.length} inserted=${body?.inserted ?? "?"} ` +
      `skippedLevel=${body?.skippedLevel ?? "?"} skippedBlacklisted=${body?.skippedBlacklisted ?? "?"}`
    );
    return { inserted: body?.inserted ?? 0, skipped: false };
  } catch (err) {
    console.error(`[marketing-handoff] request failed: ${err.message}`);
    return null;
  }
}
