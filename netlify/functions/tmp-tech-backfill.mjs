// TEMPORARY one-off endpoint — retroactively backfills job_posts.technologies
// for rows that predate the 2026-07-29 title-shortcut fix (kh, unicredit, otp,
// wherewework — intern/junior/medior-titled rows skipped the detail fetch) or
// that never had technologies wired at all (minddiak, schonherz — DIAK_1
// didn't extract it until that same fix). Deployed, invoked repeatedly in
// small batches (stays under the function timeout), then deleted. Do not
// leave this in the repo; if you're reading this later and it's still here,
// it should have been removed right after use (see conversation history).
import pkg from "pg";
const { Pool } = pkg;
import https from "node:https";
import zlib from "node:zlib";
import { load as cheerioLoad } from "cheerio";
import { fetchText, extractTechnologies, ensureTechnologiesColumn } from "./_experience_core.mjs";

const connectionString = process.env.NETLIFY_DATABASE_URL;
if (!connectionString) throw new Error("NETLIFY_DATABASE_URL is not set");

const pool = new Pool({ connectionString, ssl: { rejectUnauthorized: false } });
const ONE_OFF_TOKEN = "4902ba8526e1fd6155a78c84a2557bbc35522b02c5a3ad65";

const SOURCES = ["kh", "unicredit", "otp", "wherewework", "minddiak", "schonherz"];

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/* ── minddiak: SPA detail page has no server-rendered content — pull the ad
   body straight from the humancentrum API's per-id record instead (same data
   cron_jobs_DIAK_1-background.mjs's live listing fetch already uses). ── */
function minddiakFetchWithHeaders(url, extraHeaders = {}, method = "GET", body = null, redirectLeft = 5) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request(
      u,
      {
        method,
        headers: {
          "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
          "Accept-Language": "hu-HU,hu;q=0.9,en;q=0.8",
          "Accept-Encoding": "gzip,deflate,br",
          Accept: "application/json, text/plain, */*",
          ...extraHeaders,
        },
        timeout: 25000,
      },
      (res) => {
        const code = res.statusCode || 0;
        if ([301, 302, 303, 307, 308].includes(code)) {
          const loc = res.headers.location;
          if (!loc || redirectLeft <= 0) return reject(new Error(`HTTP ${code} redirect fail`));
          return resolve(minddiakFetchWithHeaders(new URL(loc, url).toString(), extraHeaders, method, body, redirectLeft - 1));
        }
        const enc = String(res.headers["content-encoding"] || "").toLowerCase();
        let stream = res;
        if (enc.includes("gzip")) stream = res.pipe(zlib.createGunzip());
        else if (enc.includes("deflate")) stream = res.pipe(zlib.createInflate());
        else if (enc.includes("br")) stream = res.pipe(zlib.createBrotliDecompress());
        let data = "";
        stream.setEncoding("utf8");
        stream.on("data", (c) => (data += c));
        stream.on("end", () => (code >= 200 && code < 300 ? resolve(data) : reject(new Error(`HTTP ${code} for ${url}: ${data.slice(0, 200)}`))));
        stream.on("error", reject);
      }
    );
    req.on("timeout", () => req.destroy(new Error(`Timeout for ${url}`)));
    req.on("error", reject);
    if (body) req.write(typeof body === "string" ? body : JSON.stringify(body));
    req.end();
  });
}

function absolutize(href, base) {
  try { return new URL(href, base).toString(); } catch { return null; }
}

function extractScriptSrcs(html, baseUrl) {
  const $ = cheerioLoad(html);
  let base = baseUrl;
  try { base = new URL(baseUrl).origin + "/"; } catch {}
  return $("script[src]").map((_, s) => absolutize($(s).attr("src"), base)).get().filter(Boolean);
}

function extractGuestEndpointFromBundle(jsText) {
  const idx = jsText.indexOf('key:"guest"');
  if (idx < 0) return null;
  const snippet = jsText.slice(idx, Math.min(jsText.length, idx + 8000));
  let m = snippet.match(/concat\(this\.API_URL,\s*"([^"]+)"\)/i);
  if (m?.[1]) return m[1];
  m = snippet.match(/this\.API_URL\+\s*"([^"]+)"/i);
  if (m?.[1]) return m[1];
  m = snippet.match(/"\/[^"]*guest[^"]*"/i);
  if (m?.[0]) return JSON.parse(m[0]);
  return null;
}

function extractApiBaseFromBundle(jsText) {
  const m = jsText.match(/https?:\/\/api\.humancentrum\.hu\/[a-z0-9_\-\/]*/i);
  return m?.[0] ? (m[0].endsWith("/") ? m[0] : m[0] + "/") : "https://api.humancentrum.hu/";
}

function pickTokenFromPayload(p) {
  return p?.token || p?.accessToken || p?.access_token || p?.jwt ||
    p?.data?.token || p?.data?.accessToken || p?.data?.access_token || null;
}

let _minddiakToken = null;
async function getMinddiakToken() {
  if (_minddiakToken) return _minddiakToken;
  const pageUrl = "https://minddiak.hu/diakmunka-226/work_type/it-mernok-10";
  const html = await minddiakFetchWithHeaders(pageUrl, { Accept: "text/html,*/*" });
  const scripts = extractScriptSrcs(html, pageUrl);
  const mainLike = scripts.find((s) => /main\..*\.js(\?|$)/i.test(s)) || scripts.find((s) => /\.js(\?|$)/i.test(s));
  if (!mainLike) throw new Error("minddiak: no bundle found");
  const jsText = await minddiakFetchWithHeaders(mainLike, { Accept: "*/*" });
  const guestPath = extractGuestEndpointFromBundle(jsText);
  const apiBase = extractApiBaseFromBundle(jsText);
  if (!guestPath) throw new Error("minddiak: no guest endpoint found");
  const guestUrl = new URL(guestPath, apiBase).toString();
  const common = { Origin: "https://minddiak.hu", Referer: "https://minddiak.hu/", Accept: "application/json, text/plain, */*" };
  for (const attempt of [{ method: "POST", body: {} }, { method: "GET" }]) {
    try {
      const txt = await minddiakFetchWithHeaders(guestUrl, { ...common, ...(attempt.method === "POST" ? { "Content-Type": "application/json" } : {}) }, attempt.method, attempt.body);
      const token = pickTokenFromPayload(JSON.parse(txt));
      if (token) { _minddiakToken = token; return token; }
    } catch { /* try next */ }
  }
  throw new Error("minddiak: could not obtain token");
}

async function fetchMinddiakTechHtml(jobUrl) {
  const id = (jobUrl.match(/-(\d+)\/?$/) || [])[1];
  if (!id) throw new Error(`minddiak: no id in url ${jobUrl}`);
  const token = await getMinddiakToken();
  const txt = await minddiakFetchWithHeaders(`https://api.humancentrum.hu/positions/${id}`, {
    Authorization: `Bearer ${token}`,
    Referer: "https://minddiak.hu/",
    Origin: "https://minddiak.hu",
  });
  const j = JSON.parse(txt);
  const techHtml = [j?.description, j?.requirements, j?.advantages, j?.offer]
    .filter((s) => typeof s === "string" && s)
    .join(" ");
  return techHtml || null;
}

export default async (request) => {
  const auth = (request.headers.get("authorization") || "").trim();
  const token = auth.replace(/^Bearer\s+/i, "").trim();
  if (token !== ONE_OFF_TOKEN) return new Response("Unauthorized", { status: 401 });

  const url = new URL(request.url);
  const limit = Math.min(Math.max(Number(url.searchParams.get("limit") || 8), 1), 15);

  const client = await pool.connect();
  const results = [];
  try {
    await ensureTechnologiesColumn(client);

    const { rows } = await client.query(
      `SELECT id, url, source FROM job_posts
       WHERE source = ANY($1::text[]) AND technologies IS NULL
       ORDER BY source, id
       LIMIT $2`,
      [SOURCES, limit]
    );

    for (const row of rows) {
      try {
        let html;
        if (row.source === "minddiak") {
          const techHtml = await fetchMinddiakTechHtml(row.url);
          html = techHtml ? `<body>${techHtml}</body>` : null;
        } else {
          html = await fetchText(row.url);
        }
        const technologies = html ? (extractTechnologies(html) ?? "") : "";
        await client.query(
          `UPDATE job_posts SET technologies = $1 WHERE id = $2 AND technologies IS NULL`,
          [technologies, row.id]
        );
        results.push({ id: row.id, source: row.source, url: row.url, technologies: technologies || "(none)" });
      } catch (err) {
        // One-off pass, no future automated retry (unlike enrichExperience's
        // recurring healer) — leaving technologies NULL on a permanently-dead
        // url (404/410/etc) would just make this same row get re-selected by
        // every subsequent batch forever. Mark it '' (checked, no signal) so
        // the backlog can actually reach zero.
        await client.query(
          `UPDATE job_posts SET technologies = '' WHERE id = $1 AND technologies IS NULL`,
          [row.id]
        );
        results.push({ id: row.id, source: row.source, url: row.url, error: err.message, marked: "''" });
      }
      await sleep(500);
    }

    const { rows: remainingRows } = await client.query(
      `SELECT source, COUNT(*)::int AS n FROM job_posts
       WHERE source = ANY($1::text[]) AND technologies IS NULL
       GROUP BY source`,
      [SOURCES]
    );
    const remaining = remainingRows.reduce((s, r) => s + r.n, 0);

    return new Response(JSON.stringify({ processed: rows.length, remaining, remainingBySource: remainingRows, results }, null, 2), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  } finally {
    client.release();
  }
};
