// ✅ polyfill még importok előtt (Node 18 + undici kompat)
globalThis.File ??= class File {};
globalThis.Blob ??= class Blob {};
globalThis.FormData ??= class FormData {};

const https = require("https");
const http = require("http");
const cheerio = require("cheerio");
const { Pool } = require("pg");

// ✅ In-file schedule (ha ezt akarod)
exports.config = {
  schedule: "0 4 * * *", // 04:00 UTC ~ 05:00 HU télen
};

const connectionString = process.env.NETLIFY_DATABASE_URL;
if (!connectionString) throw new Error("NETLIFY_DATABASE_URL is not set");

const pool = new Pool({
  connectionString,
  ssl: { rejectUnauthorized: false },
});

function json(statusCode, body) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify(body),
  };
}

function fetchText(url, redirectLeft = 5) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const lib = u.protocol === "https:" ? https : http;

    const req = lib.request(
      u,
      {
        method: "GET",
        headers: {
          "User-Agent": "JobWatcher/1.0",
          "Accept": "text/html,application/xhtml+xml",
          "Accept-Language": "hu-HU,hu;q=0.9,en;q=0.8",
        },
        timeout: 25000,
      },
      (res) => {
        const code = res.statusCode || 0;

        // ✅ Redirect kezelés
        if ([301, 302, 303, 307, 308].includes(code)) {
          const loc = res.headers.location;
          if (!loc) return reject(new Error(`HTTP ${code} (no Location) for ${url}`));
          if (redirectLeft <= 0) return reject(new Error(`Too many redirects for ${url}`));

          const nextUrl = new URL(loc, url).toString();
          res.resume(); // ürítsük a streamet
          return resolve(fetchText(nextUrl, redirectLeft - 1));
        }

        let data = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          if (code >= 200 && code < 300) resolve(data);
          else reject(new Error(`HTTP ${code} for ${url}`));
        });
      }
    );

    req.on("timeout", () => req.destroy(new Error(`Timeout for ${url}`)));
    req.on("error", reject);
    req.end();
  });
}

function absolutize(href, base) {
  try {
    return new URL(href, base).toString();
  } catch {
    return null;
  }
}

function normalizeWhitespace(s) {
  return String(s ?? "").replace(/\s+/g, " ").trim();
}

function dedupeByUrl(items) {
  const seen = new Set();
  return items.filter((x) => {
    if (!x.url) return false;
    if (seen.has(x.url)) return false;
    seen.add(x.url);
    return true;
  });
}

// ⚠️ TODO: IDE TEDD A KONKRÉT ÁLLÁSLISTA OLDALAKAT (nem főoldal)
const SOURCES = [
  { source: "melodiak", url: "https://melodiak.hu/" },
  { source: "minddiak", url: "https://minddiak.hu/" },
  { source: "muisz", url: "https://muisz.hu/" },
];

// ⚠️ TODO: később pontos szelektorok (most csak linkek)
function extractLinksCheerio(html, baseUrl) {
  const $ = cheerio.load(html);
  const items = [];

  $("a[href]").each((_, el) => {
    const title = normalizeWhitespace($(el).text());
    const href = $(el).attr("href");
    if (!title || !href) return;

    const url = absolutize(href, baseUrl);
    if (!url) return;

    // TODO: SZŰRÉS – ide írjuk majd, hogy csak állás linkek legyenek
    // pl:
    // if (!url.includes("allas") && !url.includes("gyakornok")) return;

    items.push({ title: title.slice(0, 300), url, description: null });
  });

  return dedupeByUrl(items);
}

async function upsertJob(client, source, item) {
  await client.query(
  `INSERT INTO job_posts
      (source, title, url, description, first_seen)
    VALUES
      ($1, $2, $3, $4, NOW())
    ON CONFLICT (source, url)
    DO UPDATE SET
      title = EXCLUDED.title,
      description = COALESCE(EXCLUDED.description, job_posts.description)
    `,
    [source, item.title, item.url, item.description]
  );
}

exports.handler = async () => {
  const client = await pool.connect();
  try {
    let totalFound = 0;
    let totalUpserted = 0;

    for (const s of SOURCES) {
      const html = await fetchText(s.url);

      const items = extractLinksCheerio(html, s.url).map((it) => ({
        ...it,
        source: s.source,
      }));

      totalFound += items.length;

      for (const it of items) {
        if (!it.title || !it.url) continue;
        await upsertJob(client, s.source, it);
        totalUpserted++;
      }
    }

    return json(200, {
      ok: true,
      node: process.version,
      totalFound,
      totalUpserted,
      ranAt: new Date().toISOString(),
    });
  } catch (err) {
    console.error(err);
    return json(500, { ok: false, error: err.message, node: process.version });
  } finally {
    client.release();
  }
};