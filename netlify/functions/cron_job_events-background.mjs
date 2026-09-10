// netlify/functions/cron_job_events-background.mjs
//
// 2 naponta futó cron (2026-09-11 óta — előtte heti, előtte napi; user-döntés
// mindkétszer: az esemény-lista lassan változik, ritkább futás is elég):
// beolvassa az `event_sources` regiszterben (event-sources.js-en keresztül
// karbantartott) listing oldalakat, és beolvasztja a "job-events" Blobba
// (_job_events_store.mjs) — az a blob a jövőbeli eseményeket tárolja, a
// lejárt (mai nap előtti) sorokat minden futás eldobja, forrás nélkül is
// (ld. mergeAndPurgeEvents). Ritkább ütemezés mellett is helyes marad: a
// purge dátum-alapú, csak ritkábban fut, egy lejárt sor legfeljebb ~1 napig
// maradhat bent a törlés előtt ahelyett, hogy még aznap eltűnne.
//
// **Két kinyerési mód, forrásonként `event_sources.mode` dönt (2026-09-11,
// user request: "csak amit egyszerű vagy van rá API, AI nélkül"):**
//   - `jsonld` — determinisztikus, AI nélkül (_events_jsonld_core.mjs):
//     a listázó oldal saját schema.org/Event JSON-LD-jét parse-olja
//     (cheerio + JSON.parse, nulla LLM-hívás). Csak azokra a forrásokra
//     használható, amik tényleg közlik ezt (kibernaptar.hu igen — WordPress
//     events-calendar plugin; ivsz.hu/mvisz.hu ELLENŐRIZVE és NEM, ezért
//     azok ki is kerültek a regiszterből, nem próbálunk rájuk törékeny
//     HTML-mintaillesztést építeni).
//   - `llm-read` — a régi AI-s út (_ai_events_extract_core.mjs), meghagyva
//     epam/progmasters-nek (2 kicsi, egy-eseményes céges oldal, nincs
//     strukturált adatuk, de a költség is elhanyagolható).
//
// `registrationDeadline` (2026-09-08 kibővítve, csak az `llm-read` módnál):
// a listázó oldal HTML-je gyakran nem közli a jelentkezési határidőt, csak
// az esemény saját aloldala — ezért minden olyan eseményre, aminek a
// listázó-extrakcióból null jött, egy külön (olcsó, haiku-modelles)
// follow-up lekéri és átvizsgálja a saját `url`-jét (ld. enrichDeadline).
// Ezt csak EGYSZER teszi meg eseményenként: a tárolt sor `deadlineChecked`
// mezője jelzi, hogy már megnéztük. A `jsonld` módú források ezt sosem
// kapják meg — nincs rá strukturált mező, és ez maga is egy AI-hívás volna,
// pont amit a "no AI" kérés elkerülni akar; ott `registrationDeadline`
// mindig null marad.
//
// Direkt ütemezve `config.schedule`-lel, mint a cron_daily_stats.mjs — nem a
// cron_scheduler dispatcheren keresztül, mert ez alacsony gyakoriságú és nem
// kell staggerelni. Netlify saját ütemezett hívása nem küld CRON_SECRET
// bearer-t, ezért — pont úgy, mint cron_daily_stats.mjs-nél — nincs itt
// bejövő auth-ellenőrzés.

export const config = {
  schedule: "30 5 */2 * *", // 2 naponta (páratlan naptári napokon) 05:30 UTC
};

import { Pool } from "pg";
import { withTimeout } from "./_error-logger.mjs";
import {
  extractEventsLLM,
  extractRegistrationDeadline,
  estimateCost,
  fetchListingPage,
} from "./_ai_events_extract_core.mjs";
import { extractEventsJsonLd } from "./_events_jsonld_core.mjs";
import { readEvents, mergeAndPurgeEvents } from "./_job_events_store.mjs";

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

// Deadline model (see _ai_events_extract_core.mjs) is cheap per call, but an
// unbounded number of new events in one run would still be an unbounded
// number of extra fetches+LLM calls. This caps it per site per run; anything
// past the cap just stays unchecked and gets picked up on a later run (the
// `deadlineChecked` skip below means it costs nothing to leave for next time).
const MAX_DEADLINE_LOOKUPS_PER_SITE = 15;

/**
 * One event's own detail page rarely repeats across days, so the listing
 * extraction alone is cheap and safe to redo daily — but following every
 * event's `url` to look for a deadline is real, recurring cost. `known` is
 * this event's PREVIOUSLY stored row (if any): once `deadlineChecked` is true
 * there, the page has already been read once and stated no deadline (or
 * genuinely has none), so this never re-fetches it — only a brand-new event,
 * or one from before this feature shipped, gets the one-time follow-up.
 */
async function enrichDeadline(event, known, budget) {
  if (event.registrationDeadline) return { ...event, deadlineChecked: true };
  if (known?.deadlineChecked) {
    // The listing page never states a deadline for this event (that's WHY it
    // was already checked), so today's listing extraction will always come
    // back null here again — carrying `known`'s value forward is what stops
    // a deadline the one-time detail-page check actually found from being
    // silently overwritten back to null on every later run.
    return { ...event, registrationDeadline: known.registrationDeadline ?? null, deadlineChecked: true };
  }
  if (budget.used >= MAX_DEADLINE_LOOKUPS_PER_SITE) return event;

  budget.used += 1;
  try {
    const detailHtml = await fetchListingPage(event.url);
    const referenceDate = new Date().toISOString().slice(0, 10);
    const { registrationDeadline, usage } = await extractRegistrationDeadline(detailHtml, {
      referenceDate,
    });
    budget.cost += estimateCost(usage, "claude-haiku-4-5");
    return { ...event, registrationDeadline, deadlineChecked: true };
  } catch (err) {
    console.error(`[job-events] deadline lookup failed for ${event.url} — ${err.message}`);
    // Marked checked anyway: a page that 404s or times out today will most
    // likely do the same tomorrow, and retrying it daily forever is exactly
    // the recurring cost this bookkeeping exists to avoid. Worst case, a
    // transient failure just means this one event never gets a deadline.
    return { ...event, deadlineChecked: true };
  }
}

async function runSiteJsonLd(client, site) {
  let html;
  try {
    html = await fetchListingPage(site.list_url);
  } catch (err) {
    await client.query(`UPDATE event_sources SET fail_streak = fail_streak + 1 WHERE site = $1`, [site.site]);
    console.error(`[job-events] ${site.site}: fetch failed — ${err.message}`);
    return [];
  }

  try {
    const events = extractEventsJsonLd(html, { baseUrl: site.list_url });
    await client.query(`UPDATE event_sources SET last_ok = NOW(), fail_streak = 0 WHERE site = $1`, [site.site]);
    console.log(`[job-events] ${site.site}: found=${events.length} (jsonld, no AI)`);
    return events.map((e) => ({ ...e, source: site.site }));
  } catch (err) {
    await client.query(`UPDATE event_sources SET fail_streak = fail_streak + 1 WHERE site = $1`, [site.site]);
    console.error(`[job-events] ${site.site}: jsonld extraction failed — ${err.message}`);
    return [];
  }
}

async function runSiteLLM(client, site, knownByUrl) {
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

    const budget = { used: 0, cost: 0 };
    const enriched = await Promise.all(
      events.map((e) => enrichDeadline(e, knownByUrl.get(e.url), budget)),
    );

    console.log(
      `[job-events] ${site.site}: found=${events.length} deadlineLookups=${budget.used} ` +
        `cost=$${(estimateCost(usage) + budget.cost).toFixed(4)}`
    );
    return enriched.map((e) => ({ ...e, source: site.site }));
  } catch (err) {
    await client.query(`UPDATE event_sources SET fail_streak = fail_streak + 1 WHERE site = $1`, [site.site]);
    console.error(`[job-events] ${site.site}: extraction failed — ${err.message}`);
    return [];
  }
}

function runSite(client, site, knownByUrl) {
  return site.mode === "jsonld" ? runSiteJsonLd(client, site) : runSiteLLM(client, site, knownByUrl);
}

export default withTimeout("cron_job_events-background", async () => {
  const client = await pool.connect();
  let sites = [];
  try {
    await ensureTable(client);
    ({ rows: sites } = await client.query(
      `SELECT site, list_url, mode FROM event_sources WHERE mode <> 'disabled' ORDER BY site`
    ));

    const { events: storedEvents } = await readEvents();
    const knownByUrl = new Map(storedEvents.map((e) => [e.url, e]));

    const collected = [];
    for (const site of sites) {
      try {
        collected.push(...(await runSite(client, site, knownByUrl)));
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
