globalThis.File ??= class File {};
globalThis.Blob ??= class Blob {};
globalThis.FormData ??= class FormData {};

const https = require("https");
const http = require("http");
const cheerio = require("cheerio");
const { Pool } = require("pg");

exports.config = {
  schedule: "0 4 * * *", // 04:00 UTC (~05:00 Budapest télen)
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

const JOB_PORTALS = [
  { key: "melodiak", label: "Melódiák – gyakornoki", url: "https://www.melodiak.hu/diakmunkak/?l=gyakornoki-szakmai-munkak&ca=informatikai-mernoki-muszaki" },
  { key: "minddiak", label: "Minddiák", url: "https://minddiak.hu/position?page=2" },
  { key: "muisz", label: "Muisz – gyakornoki kategória", url: "https://muisz.hu/hu/diakmunkaink?categories=3&locations=10" },
  { key: "cvcentrum-gyakornok-it", label: "CV Centrum – gyakornok IT", url: "https://cvcentrum.hu/allasok/?s=gyakornok&category%5B%5D=it&category%5B%5D=it-programozas&category%5B%5D=it-uzemeltetes&type=&location%5B%5D=budapest&_noo_job_field_year_experience=&post_type=noo_job" },
  { key: "cvcentrum-intern-it", label: "CV Centrum – intern IT", url: "https://cvcentrum.hu/?s=intern&category%5B%5D=information-technology&category%5B%5D=it&category%5B%5D=it-programozas&category%5B%5D=it-uzemeltetes&category%5B%5D=networking&type=&_noo_job_field_year_experience=&post_type=noo_job" },
  { key: "zyntern", label: "Zyntern – IT/fejlesztés", url: "https://zyntern.com/jobs?fields=16" },
  { key: "profession-intern", label: "Profession – Intern", url: "https://www.profession.hu/allasok/it-programozas-fejlesztes/budapest/1,10,23,intern" },
  { key: "profession-gyakornok", label: "Profession – Gyakornok", url: "https://www.profession.hu/allasok/it-uzemeltetes-telekommunikacio/budapest/1,25,23,gyakornok" },
  { key: "furgediak", label: "Fürge Diák – gyakornok", url: "https://gyakornok.furgediak.hu/allasok?statikusmunkakor=7" },
  { key: "schonherz", label: "Schönherz – Budapest fejlesztő/tesztelő", url: "https://schonherz.hu/diakmunkak/budapest/fejleszto---tesztelo" },
  { key: "pannondiak", label: "Pannondiak", url: "https://pannondiak.hu/jobs/?category%5B%5D=250&category%5B%5D=1845&category%5B%5D=1848&regio%5B%5D=267#job_list" },
  { key: "prodiak", label: "Prodiák – IT állások", url: "https://www.prodiak.hu/adverts/it-5980e4975de0fe1b308b460a/budapest/kulfold" },
  { key: "qdiak", label: "Qdiák", url: "https://cloud.qdiak.hu/munkak" },
  { key: "tudasdiak", label: "Tudasdiak", url: "https://tudatosdiak.anyway.hu/hu/jobs?searchIndustry%5B%5D=7&searchMinHourlyWage=1000" },
  { key: "nix-junior", label: "NIX – junior", url: "https://nixstech.com/hu/allasok/?level=junior-hu" },
  { key: "nix-trainee", label: "NIX – trainee", url: "https://nixstech.com/hu/allasok/?level=trainee-hu" },
  { key: "otp", label: "OTP", url: "https://karrier.otpbank.hu/go/Minden-allasajanlat/1167001/?q=&q2=&alertId=&locationsearch=&title=GYAKORNOK&date=&location=&shifttype=" },
  { key: "mol", label: "MOL", url: "https://molgroup.taleo.net/careersection/external/jobsearch.ftl?lang=hu" },
  { key: "taboola", label: "TABOOLA", url: "https://www.taboola.com/careers/jobs#team=&location=31734" },
  { key: "mediso", label: "MEDISO", url: "https://mediso.com/global/hu/career?search=&location=&category=9" },
  { key: "continental", label: "CONTINENTAL", url: "https://jobs.continental.com/hu/#/?fieldOfWork_stringS=3a2330f4-2793-4895-b7c7-aee9c965ae22,b99ff13c-96c8-4a72-b427-dec7effd7338&location=%7B%22title%22:%22Magyarorsz%C3%A1g%22,%22type%22:%22country%22,%22countryCode%22:%22hu%22%7D&searchTerm=intern" },
  { key: "kh", label: "K+H", url: "https://karrier.kh.hu/allasok?q=c3BlY2lhbGl0aWVzJTVCJTVEJTNESVQlMjAlQzMlQTlzJTIwaW5ub3YlQzMlQTFjaSVDMyVCMyUyNmNpdGllcyU1QiU1RCUzREJ1ZGFwZXN0JTI2#!" },
  { key: "piller", label: "PILLER", url: "https://piller.karrierportal.hu/allasok?q=Y2l0aWVzJTVCJTVEJTNEQnVkYXBlc3QlMjYuuzzuuzz#!" },
];



const KEYWORDS = [
  "gyakornok",
  "intern",
  "internship",
  "fejlesztő",
  "fejleszto",
  "trainee",
  "data",
  "business",
  "developer",
  "devops"
];

function stripAccents(s) {
  return String(s ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

function normalizeText(s) {
  return stripAccents(String(s ?? ""))
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

// IT special: only match as separate token or uppercase IT in original
function matchesIT(original, normalized) {
  if (/\bIT\b/.test(String(original ?? ""))) return true;
  // normalized "it" token as separate word
  return /\bit\b/.test(normalized);
}

function matchesKeywords(title, desc) {
  const original = `${title ?? ""} ${desc ?? ""}`;
  const n = normalizeText(original);

  // IT külön kezelés, hogy ne legyen fals pozitív
  const itOk = matchesIT(original, n);

  const kwOk = KEYWORDS.some((kw) => n.includes(normalizeText(kw)));

  // akkor engedjük át, ha:
  // - van rendes kulcsszó, vagy
  // - IT találat + mellette van valami szakmai jellegű (developer/data/business/fejleszt)
  if (kwOk) return true;

  if (itOk) {
    const extra = ["developer", "data", "business", "fejleszt", "trainee", "intern", "internship"].some((k) =>
      n.includes(k)
    );
    return extra;
  }

  return false;
}

function absolutize(href, base) {
  try {
    return new URL(href, base).toString();
  } catch {
    return null;
  }
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

function normalizeWhitespace(s) {
  return String(s ?? "").replace(/\s+/g, " ").trim();
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

        if ([301, 302, 303, 307, 308].includes(code)) {
          const loc = res.headers.location;
          if (!loc) return reject(new Error(`HTTP ${code} (no Location) for ${url}`));
          if (redirectLeft <= 0) return reject(new Error(`Too many redirects for ${url}`));
          const nextUrl = new URL(loc, url).toString();
          res.resume();
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

// Heurisztikus kinyerés: "értelmes" linkek + cím környezetből
function extractCandidates(html, baseUrl) {
  const $ = cheerio.load(html);
  const items = [];

  $("a[href]").each((_, el) => {
    const href = $(el).attr("href");
    if (!href) return;

    const url = absolutize(href, baseUrl);
    if (!url) return;

    // csak http(s) és ne legyen asset
    if (!/^https?:\/\//i.test(url)) return;
    if (/\.(jpg|jpeg|png|gif|svg|webp|pdf|zip|rar|7z)(\?|#|$)/i.test(url)) return;

    // cím: link szöveg vagy közeli heading
    let title = normalizeWhitespace($(el).text());
    if (!title || title.length < 4) {
      const card = $(el).closest("article, li, .card, .item, .job, .position, .listing, div");
      title =
        normalizeWhitespace(card.find("h1,h2,h3,h4,h5,h6").first().text()) ||
        normalizeWhitespace($(el).parent().find("h1,h2,h3,h4,h5,h6").first().text());
    }

    if (!title || title.length < 4) return;

    // kis extra leírás próbálkozás
    const card2 = $(el).closest("article, li, .card, .item, .job, .position, .listing, div");
    const desc =
      normalizeWhitespace(card2.find("p").first().text()) ||
      null;

    items.push({ title: title.slice(0, 300), url, description: desc ? desc.slice(0, 800) : null });
  });

  return dedupeByUrl(items);
}

function portalSourceKey(label) {
  // label -> forrás kulcs (db source mező)
  return normalizeText(label).replace(/[^a-z0-9]+/g, "-").slice(0, 50) || "source";
}

async function upsertJob(client, source, item) {
  await client.query(
    `
    INSERT INTO job_posts
      (source, title, url, description, first_seen, last_seen)
    VALUES
      ($1, $2, $3, $4, NOW(), NOW())
    ON CONFLICT (source, url)
    DO UPDATE SET
      title = EXCLUDED.title,
      description = COALESCE(EXCLUDED.description, job_posts.description),
      last_seen = NOW()
    `,
    [
      source,            // $1
      item.title,        // $2
      item.url,          // $3
      item.description,  // $4
    ]
  );
}

exports.handler = async () => {
  const client = await pool.connect();
  const stats = {
    ok: true,
    node: process.version,
    portals: [],
    totalFetched: 0,
    totalCandidates: 0,
    totalMatched: 0,
    totalUpserted: 0,
  };

  try {
    for (const p of JOB_PORTALS) {
      const source = p.key;

      let html;
      try {
        html = await fetchText(p.url);
        stats.totalFetched++;
      } catch (err) {
        // ne álljon meg az egész scraper egy site miatt
        stats.portals.push({ source, label: p.label, url: p.url, ok: false, error: err.message });
        continue;
      }

      const candidates = extractCandidates(html, p.url);
      stats.totalCandidates += candidates.length;

      const matched = candidates.filter((c) => matchesKeywords(c.title, c.description));
      stats.totalMatched += matched.length;

      let up = 0;
      for (const it of matched) {
        await upsertJob(client, source, it);
        up++;
      }
      stats.totalUpserted += up;

      stats.portals.push({
        source,
        label: p.label,
        url: p.url,
        ok: true,
        candidates: candidates.length,
        matched: matched.length,
        upserted: up,
      });
    }

    stats.ranAt = new Date().toISOString();
    return json(200, stats);
  } catch (err) {
    console.error(err);
    return json(500, { ok: false, error: err.message, node: process.version });
  } finally {
    client.release();
  }
};
