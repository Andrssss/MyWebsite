// netlify/functions/tmp-tech-heal.mjs
//
// ELDOBHATÓ, egyszer használatos endpoint (2026-09-01). Két retroaktív
// takarítás egy helyen, a `technologies` oszlopon:
//
//   (A) HAMIS CÍMKÉK. A techBoundaryRegex ASCII szóhatárt használt, az
//       ékezetes betű pedig nincs [a-z]-ben, ezért minden kulcsszóval KEZDŐDŐ
//       + ékezetessel folytatódó magyar szó illeszkedett: "elkötelezett" →
//       ELK Stack, "eltérő" → ELT. A `solid` kulcsszó ugyanígy a "solid
//       knowledge of…" fordulatból csinált SOLID-ot; azt user-döntésre
//       KIVETTÜK a TECH_KEYWORDS-ből, tehát azt nem újraszámolni, hanem
//       mindenhonnan törölni kell.
//   (B) HIÁNYZÓ CÍMKÉK. 10 forrás eddig egyáltalán nem írt technologies-t
//       (erste, mfb, atlasz, melodiak, pannondiak, trenkwalder, qdiak,
//       workly, ydiak, vizmuvek/miszisz/onejob) — a scraperek most már
//       írják, de a MEGLÉVŐ sorok NULL-ok maradtak.
//
// Azért endpoint és nem helyi script: a prod connection string helyben nincs
// meg (a Netlify CLI mindkét DB-vart maszkolja). Használat után `git rm`.
//
//   BASE=https://bakan7.netlify.app/.netlify/functions/tmp-tech-heal
//
//   # 1. állapotfelmérés (semmit nem ír):
//   curl -s "$BASE?token=TOKEN&action=scan"
//
//   # 2. a lista/API-alapú források gyógyítása (qdiak + trenkwalder, gyors):
//   curl -s -X POST "$BASE?token=TOKEN&action=api"
//
//   # 3. a html-fetches sorok gyógyítása, ciklusban amíg remaining>0:
//   curl -s -X POST "$BASE?token=TOKEN&action=heal"
//
//   # 4. maradék hamis címkék törlése (amit nem sikerült újraszámolni):
//   curl -s -X POST "$BASE?token=TOKEN&action=strip"

import pkg from "pg";
const { Pool } = pkg;
// Az import önmagában nem használt: `_db_audit.js` CommonJS-ből `require`-öli a
// @netlify/blobs-ot, amit az esbuild NEM lát a bundle-be — enélkül a függvény
// már a betöltéskor elszáll ("Cannot find module '@netlify/blobs'"). Egy
// explicit ESM-import viszont behúzza. Ugyanez a minta a tmp-stats-rebuild-ben.
import "@netlify/blobs";
import { extractTechnologies, fetchText, ensureTechnologiesColumn } from "./_experience_core.mjs";
import { withDbAuditFlush } from "./_db_audit.js";

// Egyszer használatos, ebbe a fájlba generált token — szándékosan NEM env var
// (a CRON_SECRET maszkolt a CLI-ban), és a fájllal együtt megszűnik.
const TOKEN = "2cdc12aadb7023f3a5217e8fa34e81eadf82";

const connectionString = process.env.NETLIFY_DATABASE_URL;
if (!connectionString) throw new Error("NETLIFY_DATABASE_URL is not set");

const pool = new Pool({ connectionString, ssl: { rejectUnauthorized: false } });

// A hibás határ-regex által gyártott címkék. A SOLID külön kategória: azt a
// kulcsszót kivettük, tehát SOHA nem jöhet vissza — a másik kettő viszont
// lehet valódi ("(ELK)" tényleg szerepel az Erste DevOps-hirdetésében), ezért
// azokat elsősorban ÚJRASZÁMOLJUK, és csak a elérhetetlen sorokból töröljük.
const BOGUS_LABELS = ["ELK Stack", "ELT"];
const DEAD_LABELS = ["SOLID"];

// Az a 10+ forrás, aminek eddig egyáltalán nem volt technologies-támogatása.
// (prodiak KIMARAD: Vue-SPA, a detail-oldal csak page-chrome, a lista
// `description`-je meg bevezető — nincs mit újraszámolni rajta.)
const BACKFILL_SOURCES = [
  "erste", "mfb", "atlasz", "melodiak", "pannondiak",
  "workly", "ydiak", "vizmuvek", "miszisz", "onejob",
];

// Egy hívás alatt ennyi ideig dolgozunk, aztán visszaadjuk a haladást — a
// szinkron Netlify-függvény kemény 10 mp-es faláról kell időben visszalépni.
const BUDGET_MS = 7500;
const FETCH_TIMEOUT_MS = 6000;

function json(status, body) {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

function withDeadline(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`timeout ${label}`)), ms)),
  ]);
}

function splitLabels(value) {
  return String(value ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

// A `technologies` egy vesszővel összefűzött CÍMKE-lista, nem szabad szöveg,
// tehát a törlés címke-szinten pontos (a "ELT" nem eszi meg a "Delta Lake"-et).
function stripLabels(value, labels) {
  const kept = splitLabels(value).filter((l) => !labels.includes(l));
  return kept.join(", ");
}

// Címke-szintű illesztés SQL-ben is (nem LIKE '%ELT%', ami a "Delta Lake"-be
// is belelógna). A paraméter-számot a hívó adja meg, mert ez a fragment több,
// eltérő paraméter-sorrendű query-ben is szerepel.
const hasLabel = (param) => `
  EXISTS (
    SELECT 1 FROM unnest(string_to_array(technologies, ',')) AS t(label)
     WHERE btrim(t.label) = ANY(${param}::text[])
  )`;

/* ── 1. scan ─────────────────────────────────────────────────── */

async function scan(client) {
  const all = [...BOGUS_LABELS, ...DEAD_LABELS];

  const { rows: labelRows } = await client.query(
    `SELECT btrim(t.label) AS label,
            COUNT(*)::int AS rows,
            COUNT(*) FILTER (WHERE active)::int AS active_rows,
            COUNT(DISTINCT source)::int AS sources
       FROM job_posts,
            unnest(string_to_array(technologies, ',')) AS t(label)
      WHERE btrim(t.label) = ANY($1::text[])
      GROUP BY 1 ORDER BY 2 DESC`,
    [all]
  );

  const { rows: bogusBySource } = await client.query(
    `SELECT source, COUNT(*)::int AS rows
       FROM job_posts
      WHERE technologies IS NOT NULL AND ${hasLabel("$1")}
      GROUP BY 1 ORDER BY 2 DESC`,
    [BOGUS_LABELS]
  );

  const { rows: backfill } = await client.query(
    `SELECT source,
            COUNT(*)::int AS null_rows,
            COUNT(*) FILTER (WHERE active)::int AS null_active,
            COUNT(*) FILTER (WHERE active OR first_seen > NOW() - INTERVAL '30 days')::int AS null_displayed
       FROM job_posts
      WHERE source = ANY($1::text[]) AND technologies IS NULL
      GROUP BY 1 ORDER BY 2 DESC`,
    [BACKFILL_SOURCES]
  );

  const { rows: apiSources } = await client.query(
    `SELECT source,
            COUNT(*)::int AS rows,
            COUNT(*) FILTER (WHERE technologies IS NULL)::int AS null_rows,
            COUNT(*) FILTER (WHERE active AND technologies IS NULL)::int AS null_active
       FROM job_posts
      WHERE source = ANY($1::text[])
      GROUP BY 1 ORDER BY 1`,
    [["qdiak", "trenkwalder", "prodiak"]]
  );

  return {
    bogusLabels: labelRows,
    bogusBySource,
    backfillCandidates: backfill,
    apiSources,
    workQueue: await queueSize(client),
  };
}

/* ── 2. munkasor ─────────────────────────────────────────────── */

// Két csoport, ebben a sorrendben:
//   A) hamis ELK Stack / ELT címkét viselő, ÚJRAFETCHELHETŐ sorok
//   B) a 10 forrás NULL-technologies sorai (csak ami a frontenden látszik:
//      aktív VAGY 30 napnál frissebb — a régi inaktívakat felesleges hajtani)
// KIMARAD a bogus-ágból, szándékosan:
//   • LinkedIn (64 sor) — a hirdetés-oldalt login-wall/anti-bot védi, egy 999-es
//     válasz semmit nem bizonyít. Ezek a sorok amúgy is időablakosak a
//     frontenden (30 nap), tehát maguktól kikopnak; jobb egy elavult címke,
//     mint egy tévedésből kitörölt valódi.
//   • AI-scraped (18 sor) — ott a technologies nem oldal-body-ból jön, hanem az
//     LLM saját listájából (normalizeTechnologyList). Ahhoz, hogy ott hamis ELK
//     szülessen, az LLM-nek magának kellett volna „elkötelezett"-et írnia a
//     technológia-listába — gyakorlatilag kizárt, tehát ezek valódiak. Az
//     oldalról újraszámolni ráadásul MÁS módszer: alul-detektálna (élő példa:
//     egy Azure-os adatmérnök sor elvesztette volna az „Azure Data Factory"-t).
const SQL_WORK = `
  SELECT id, source, url, technologies, 'bogus' AS reason
    FROM job_posts
   WHERE technologies IS NOT NULL
     AND source NOT IN ('LinkedIn', 'AI-scraped')
     AND ${hasLabel("$1")}
   UNION ALL
  SELECT id, source, url, technologies, 'missing' AS reason
    FROM job_posts
   WHERE source = ANY($2::text[])
     AND technologies IS NULL
     AND (active OR first_seen > NOW() - INTERVAL '30 days')`;

// Egy fetch-hiba csak akkor jogosít címke-törlésre, ha VÉGLEGES (a hirdetés
// tényleg nincs meg). Egy 6 mp-es timeout NEM az: élő példa ebből a futásból —
// az attrecto.com DevOps-hirdetése timeoutolt, és majdnem elvesztette a
// TÉNYLEG kiírt ELK Stack címkéjét. Tranziens hibánál a sor érintetlen marad
// és a következő kör újrapróbálja.
function isPermanentFailure(message) {
  const m = /HTTP (\d{3})/.exec(String(message || ""));
  if (!m) return false; // timeout / ECONNRESET / DNS → tranziens
  const code = Number(m[1]);
  return code >= 400 && code < 500 && code !== 429;
}

async function queueSize(client) {
  const { rows } = await client.query(
    `SELECT reason, COUNT(*)::int AS rows FROM (${SQL_WORK}) q GROUP BY 1`,
    [BOGUS_LABELS, BACKFILL_SOURCES]
  );
  return rows;
}

/* ── 3. heal (html-fetch + újraszámolás) ─────────────────────── */

async function heal(client, limit, offset) {
  // Az `offset` a tranziens hibák megkerülésére kell: a javított sorok maguktól
  // kiesnek a sorból, a makacsul hibázók viszont az elején ragadnának és
  // eltorlaszolnák a haladást. A hívó annyival lép előre, ahány sort feldolgozott
  // anélkül, hogy bármit írt volna.
  const { rows: work } = await client.query(
    `SELECT * FROM (${SQL_WORK}) q ORDER BY reason, id LIMIT $3 OFFSET $4`,
    [BOGUS_LABELS, BACKFILL_SOURCES, limit, offset]
  );

  const started = Date.now();
  const samples = [];
  let processed = 0;
  let updated = 0;
  let fetchFailed = 0;
  let transientSkips = 0;

  for (const row of work) {
    if (Date.now() - started > BUDGET_MS) break;
    processed++;

    let html = null;
    try {
      html = await withDeadline(fetchText(row.url), FETCH_TIMEOUT_MS, row.url);
    } catch (err) {
      fetchFailed++;
      // 'missing': nincs mit tenni, marad NULL, a következő kör újrapróbálja.
      // 'bogus': a hamis címkét CSAK véglegesen halott hirdetésnél szedjük le
      // (a hirdetés nincs meg, a rossz címkét nincs mihez mérni) — tranziens
      // hibánál érintetlenül hagyjuk, különben egy pillanatnyi timeout töröl
      // ki valódi adatot.
      if (row.reason === "bogus" && isPermanentFailure(err.message)) {
        const next = stripLabels(row.technologies, BOGUS_LABELS);
        await client.query(`UPDATE job_posts SET technologies = $1 WHERE id = $2`, [next, row.id]);
        updated++;
        if (samples.length < 40) samples.push({ id: row.id, source: row.source, reason: "bogus/dead", from: row.technologies, to: next, err: err.message });
      } else {
        transientSkips++;
      }
      continue;
    }

    const fresh = extractTechnologies(html);

    if (row.reason === "missing") {
      // Nem volt mit elveszíteni: az üres eredmény is információ ('' = megnézve,
      // nincs találat — a frontenden falsy, és nem fetcheljük újra minden körben).
      const next = fresh ?? "";
      await client.query(`UPDATE job_posts SET technologies = $1 WHERE id = $2`, [next, row.id]);
      updated++;
      if (samples.length < 40) samples.push({ id: row.id, source: row.source, reason: "missing", to: next });
      continue;
    }

    // 'bogus': a meglévő értéket CSAK akkor cseréljük le teljesen, ha az
    // újraszámolás adott is valamit. Üres eredmény jellemzően lejárt/átalakult
    // oldalt jelent — ilyenkor a jó címkéket nem dobjuk el, csak a hamisakat.
    const next = fresh || stripLabels(row.technologies, BOGUS_LABELS);
    if (next !== row.technologies) {
      await client.query(`UPDATE job_posts SET technologies = $1 WHERE id = $2`, [next, row.id]);
      updated++;
      if (samples.length < 40) samples.push({ id: row.id, source: row.source, reason: "bogus", from: row.technologies, to: next });
    }
  }

  return { processed, updated, fetchFailed, transientSkips, samples, remaining: await queueSize(client) };
}

/* ── 4. api (qdiak + trenkwalder saját listájából) ───────────── */

// Ennek a két forrásnak a hirdetés-törzse a LISTA-válaszban van, nem a job
// url-en (a qdiak url-je Directus-SPA, a trenkwalderé meg fölösleges körözés),
// így egyetlen API-hívásból az egész forrás meggyógyul.
const QDIAK_API_URL =
  "https://cloud.qdiak.hu/-/items/toborzas?filter[statusz][_eq]=aktiv&filter[kategoriak][munka_kategoria_id][_in]=1,12,21&fields=id,allasleiras,feladatok,elvarasok&limit=200";

async function healQdiak(client) {
  const payload = JSON.parse(await withDeadline(fetchText(QDIAK_API_URL), FETCH_TIMEOUT_MS, "qdiak"));
  const rows = Array.isArray(payload?.data) ? payload.data : [];
  let updated = 0;
  for (const job of rows) {
    const parts = [job.allasleiras, job.feladatok, job.elvarasok].filter((v) => typeof v === "string" && v);
    const tech = parts.length ? extractTechnologies(`<div class="description">${parts.join(" ")}</div>`) : null;
    const res = await client.query(
      `UPDATE job_posts SET technologies = $1
        WHERE source = 'qdiak' AND url = $2
          AND (technologies IS NULL OR ${hasLabel("$3")})`,
      [tech ?? "", `https://cloud.qdiak.hu/munkak/${job.id}`, BOGUS_LABELS]
    );
    updated += res.rowCount;
  }
  return { listed: rows.length, updated };
}

async function healTrenkwalder(client) {
  let updated = 0;
  let listed = 0;
  for (let page = 0; page < 10; page++) {
    const body = JSON.stringify({
      query: "",
      filters: "publishingStatus:Published",
      facetFilters: [["jobObject.jobCategory.national:IT/Szoftverfejlesztés"]],
      aroundLatLng: "47.497912,19.040235",
      aroundRadius: 25000,
      hitsPerPage: 100,
      page,
    });
    const res = await withDeadline(
      fetch("https://02IH9HMLGA-dsn.algolia.net/1/indexes/PROD_HU_New_Index_1_date/query", {
        method: "POST",
        headers: {
          "X-Algolia-Application-Id": "02IH9HMLGA",
          "X-Algolia-API-Key": "b885435a7745a7fd4c7637560f35f48a",
          "Content-Type": "application/json",
        },
        body,
      }).then((r) => r.json()),
      FETCH_TIMEOUT_MS,
      "trenkwalder"
    );
    const hits = res.hits || [];
    if (!hits.length) break;
    listed += hits.length;
    for (const hit of hits) {
      const url = hit.web?.jobUrl;
      if (!url) continue;
      const c = hit.jobContent || {};
      const parts = [c.jobDescription, c.jobRequirements, c.companyInformation, c.compensationBenefits]
        .filter((v) => typeof v === "string" && v);
      const tech = parts.length ? extractTechnologies(`<div class="description">${parts.join(" ")}</div>`) : null;
      // A scraper normalizeUrl-özött url-t tárol; a LIKE-horgony az url elejére
      // illeszt, hogy a query-string-beli eltérés ne akadályozza a párosítást.
      const upd = await client.query(
        `UPDATE job_posts SET technologies = $1
          WHERE source = 'trenkwalder' AND url LIKE $2
            AND (technologies IS NULL OR ${hasLabel("$3")})`,
        [tech ?? "", `${url.split("?")[0]}%`, BOGUS_LABELS]
      );
      updated += upd.rowCount;
    }
  }
  return { listed, updated };
}

/* ── 5. strip (maradék hamis címkék, hálózat nélkül) ─────────── */

// Csak a DEAD_LABELS (SOLID) megy ki hálózat nélkül, GLOBÁLISAN — az a kulcsszó
// megszűnt, tehát sehol nem lehet valódi. Az ELK Stack / ELT SZÁNDÉKOSAN nincs
// benne: azok valódiak is lehetnek, ezért csak a `heal` ág dönthet róluk (élő
// oldal alapján), és csak véglegesen halott hirdetésnél töröljük vakon.
async function strip(client) {
  const { rows } = await client.query(
    `SELECT id, source, technologies FROM job_posts
      WHERE technologies IS NOT NULL AND ${hasLabel("$1")}`,
    [DEAD_LABELS]
  );
  const bySource = {};
  for (const row of rows) {
    const next = stripLabels(row.technologies, DEAD_LABELS);
    if (next === row.technologies) continue;
    await client.query(`UPDATE job_posts SET technologies = $1 WHERE id = $2`, [next, row.id]);
    bySource[row.source] = (bySource[row.source] || 0) + 1;
  }
  return { matched: rows.length, updated: Object.values(bySource).reduce((a, b) => a + b, 0), bySource };
}

/* ── handler ─────────────────────────────────────────────────── */

export default withDbAuditFlush("tmp_tech_heal", async (request) => {
  const url = new URL(request.url);
  const token =
    url.searchParams.get("token") ||
    (request.headers.get("authorization") || "").replace(/^Bearer\s+/i, "").trim();
  if (token !== TOKEN) return json(401, { error: "Unauthorized" });

  const action = url.searchParams.get("action") || "scan";
  const limit = Math.min(Number(url.searchParams.get("limit")) || 25, 100);
  const offset = Math.max(Number(url.searchParams.get("offset")) || 0, 0);

  const client = await pool.connect();
  try {
    await ensureTechnologiesColumn(client);

    if (action === "scan") return json(200, { ok: true, ...(await scan(client)) });
    if (action === "heal") return json(200, { ok: true, ...(await heal(client, limit, offset)) });
    if (action === "strip") return json(200, { ok: true, ...(await strip(client)) });
    if (action === "api") {
      const qdiak = await healQdiak(client).catch((e) => ({ error: e.message }));
      const trenkwalder = await healTrenkwalder(client).catch((e) => ({ error: e.message }));
      return json(200, { ok: true, qdiak, trenkwalder, workQueue: await queueSize(client) });
    }
    return json(400, { error: `unknown action: ${action}` });
  } catch (err) {
    console.error("[tmp_tech_heal]", err);
    return json(500, { error: err.message, stack: String(err.stack).split("\n").slice(0, 4) });
  } finally {
    client.release();
  }
});
