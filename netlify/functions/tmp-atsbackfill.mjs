/*
  DISPOSABLE one-off endpoint — delete right after use.

  A 2026-08-30-i AI→ats-crawl szerep-szétválasztás (_ats_handoff.mjs) csak a
  JÖVŐT védi. Ez a két lépés takarítja le a meglévő hátralékot:

   1) A már behozott `AI-scraped` ATS-url-ek mögötti tenantok felvétele az
      `ats_tenants`-be — semmi nem vész el, csak a boardok bekerülnek a napi
      ats-crawl rotációjába.
   2) Azoknak az `AI-scraped` soroknak a TÖRLÉSE, amelyeknek BITRE azonos
      url-je már ott van `ats-crawl` source alatt. A `job_posts` identitása
      `(source, url)`, ezért ezek ténylegesen két sor ugyanarról a hirdetésről.

  Miért az AI-sor megy és az ats-crawl marad: az ats-crawl a kanonikus,
  munkáltatói forrás, és van gazdája a sor életciklusának (újra-aratja a
  boardot). Az applied/interview jelölés nem vész el: az `admin_applied_jobs`
  URL-kulcsos (`jobKeyFor()`), nem `job_posts.id`-ra hivatkozik.

  Két biztonsági fék, mindkettő szándékos:
   • Ha az AI-sor AKTÍV, de az ats-crawl párja már INAKTÍV, a sort NEM töröljük
     (különben egy élő hirdetés tűnne el a boardról). Ezek `heldBack`-ként
     jelennek meg a válaszban.
   • Ha az AI-sort valaki elrejtette (`hidden`), de az ats-crawl párja látszik,
     a rejtést ÁTVISSZÜK a megmaradó sorra a törlés előtt — különben a takarítás
     visszahozná a boardra azt, amit az admin levett róla.

  Alapból SZÁRAZ futás; írni csak `&go=1`-gyel ír.
*/
import { Pool } from "pg";
import { atsHandoff, registerAtsTenant, ensureAtsTenantTable } from "./_ats_handoff.mjs";

const TOKEN = "8f2dfb68966333295ec90b6ce382bb9aa3053361aa2b8ffd";
const AI_SOURCES = ["AI-scraped", "ai-scraped"];

const pool = new Pool({
  connectionString: process.env.NETLIFY_DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

const json = (status, body) =>
  new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });

export default async (req) => {
  const u = new URL(req.url);
  if (u.searchParams.get("t") !== TOKEN) return new Response("nope", { status: 403 });
  const dry = u.searchParams.get("go") !== "1";

  const client = await pool.connect();
  try {
    await ensureAtsTenantTable(client);

    /* ── 1) tenantok ─────────────────────────────────────────────── */
    const { rows: aiRows } = await client.query(
      `SELECT id, url, company FROM job_posts WHERE source = ANY($1)`,
      [AI_SOURCES]
    );

    const wanted = new Map();
    let legacyRows = 0;
    let nonAtsRows = 0;
    for (const r of aiRows) {
      const h = atsHandoff(r.url);
      if (!h) { nonAtsRows++; continue; }
      if (h.kind === "legacy") { legacyRows++; continue; }
      const key = `${h.provider}:${h.slug}`;
      if (!wanted.has(key)) wanted.set(key, { provider: h.provider, slug: h.slug, company: r.company || null });
    }

    const { rows: known } = await client.query(`SELECT provider, slug FROM ats_tenants`);
    const knownSet = new Set(known.map((t) => `${t.provider}:${t.slug}`));
    const toRegister = [...wanted.entries()].filter(([k]) => !knownSet.has(k));

    /* ── 2) bitre azonos url-ű duplikátumok ──────────────────────── */
    const { rows: dupes } = await client.query(
      `SELECT a.id AS ai_id, a.url, a.title, a.active AS ai_active, a.hidden AS ai_hidden,
              b.id AS ats_id, b.active AS ats_active, b.hidden AS ats_hidden
         FROM job_posts a
         JOIN job_posts b ON lower(b.url) = lower(a.url) AND b.source = 'ats-crawl'
        WHERE a.source = ANY($1)
        ORDER BY a.url`,
      [AI_SOURCES]
    );

    const deletable = dupes.filter((d) => d.ats_active || !d.ai_active);
    const heldBack = dupes.filter((d) => !(d.ats_active || !d.ai_active));
    const needHide = deletable.filter((d) => d.ai_hidden && !d.ats_hidden);

    const plan = {
      dryRun: dry,
      aiRows: aiRows.length,
      classified: { atsUrls: wanted.size, legacyRows, nonAtsRows },
      tenants: {
        knownBefore: known.length,
        toRegister: toRegister.map(([k]) => k),
      },
      dupes: {
        total: dupes.length,
        toDelete: deletable.length,
        heldBack: heldBack.map((d) => ({ url: d.url, reason: "AI row active, ats-crawl counterpart inactive" })),
        hiddenToPropagate: needHide.map((d) => d.url),
        sample: deletable.slice(0, 10).map((d) => ({ url: d.url, title: d.title })),
      },
    };

    if (dry) return json(200, plan);

    const registered = [];
    for (const [key, t] of toRegister) {
      if (await registerAtsTenant(client, { ...t, via: "ai-handoff-backfill" })) registered.push(key);
    }

    let hiddenPropagated = 0;
    if (needHide.length > 0) {
      const res = await client.query(
        `UPDATE job_posts SET hidden = true WHERE id = ANY($1) AND hidden = false`,
        [needHide.map((d) => d.ats_id)]
      );
      hiddenPropagated = res.rowCount;
    }

    let deleted = 0;
    if (deletable.length > 0) {
      const res = await client.query(
        `DELETE FROM job_posts WHERE id = ANY($1)`,
        [deletable.map((d) => d.ai_id)]
      );
      deleted = res.rowCount;
    }

    const { rows: after } = await client.query(`SELECT count(*)::int AS n FROM ats_tenants`);
    return json(200, { ...plan, executed: { registered, hiddenPropagated, deleted, tenantsAfter: after[0].n } });
  } catch (e) {
    return json(500, { error: e.message, stack: String(e.stack).slice(0, 800) });
  } finally {
    client.release();
  }
};
