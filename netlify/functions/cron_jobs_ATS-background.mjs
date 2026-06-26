/*
  ATS MIX background scraper

  Goal:
    Stable ingestion from SmartRecruiters public posting API
    for companies with Budapest offices.
    Fetches list → filters HU → detail fetch per HU job for applyUrl.
*/

import { Pool } from "pg";
import { loadFilters } from "./load_filters.mjs";
import { logFetchError, withTimeout } from "./_error-logger.mjs";
import { reconcileActive } from "./_active_core.mjs";
import { extractBodyExperience, isInternshipTitle } from "./_experience_core.mjs";

let _filters = [];

const connectionString = process.env.NETLIFY_DATABASE_URL;
if (!connectionString) throw new Error("NETLIFY_DATABASE_URL is not set");

const pool = new Pool({
  connectionString,
  ssl: { rejectUnauthorized: false },
});

const SR_SOURCES = [
  { key: "wise",   company: "Wise",         label: "SmartRecruiters Wise" },
  { key: "roland", company: "RolandBerger", label: "SmartRecruiters Roland Berger" },
];

function normalizeWhitespace(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function normalizeText(value) {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function normalizeUrl(raw) {
  try {
    const u = new URL(raw);
    u.hash = "";
    ["utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content", "fbclid", "gclid", "oga"]
      .forEach((p) => u.searchParams.delete(p));
    return u.toString().replace(/\?$/, "");
  } catch {
    return raw;
  }
}

function _blacklistRegex(k) {
  const escaped = normalizeText(k).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, "i");
}

function isSeniorLike(title) {
  const normalized = normalizeText(title ?? "");
  return _filters.some((kw) => _blacklistRegex(kw).test(normalized));
}

function isHungaryLocation(loc) {
  if (!loc) return false;
  if (loc.country?.toLowerCase() === "hu") return true;
  const t = normalizeText(`${loc.city || ""} ${loc.fullLocation || ""}`);
  return t.includes("budapest") || t.includes("hungary") || t.includes("magyarorszag");
}

async function fetchJson(url) {
  const res = await fetch(url, {
    method: "GET",
    headers: {
      "User-Agent": "JobWatcher/1.0",
      Accept: "application/json,text/plain;q=0.9,*/*;q=0.8",
      "Accept-Language": "hu-HU,hu;q=0.9,en;q=0.8",
    },
  });

  if (!res.ok) {
    throw new Error(`HTTP ${res.status} for ${url}`);
  }

  return res.json();
}

function extractSrDescription(detail) {
  const sections = detail?.jobAd?.sections;
  if (!sections) return null;
  return [sections.jobDescription?.text, sections.qualifications?.text]
    .filter(Boolean)
    .join(" ") || null;
}

async function fetchSmartRecruiters(src) {
  const listUrl = `https://api.smartrecruiters.com/v1/companies/${encodeURIComponent(src.company)}/postings?limit=100`;
  const payload = await fetchJson(listUrl);
  const all = Array.isArray(payload?.content) ? payload.content : [];

  const nonHu = all.filter((it) => !isHungaryLocation(it?.location));
  const huItems = all.filter((it) => isHungaryLocation(it?.location));

  console.log(`[ats][${src.label}] total=${all.length} hu=${huItems.length} non-hu=${nonHu.length}`);
  if (nonHu.length > 0) {
    for (const it of nonHu) {
      const loc = it?.location;
      console.log(`[ats][${src.label}] skip non-HU: "${it.name}" → country=${loc?.country ?? "?"} city=${loc?.city ?? "?"}`);
    }
  }

  const results = [];
  for (const it of huItems) {
    const title = normalizeWhitespace(it.name);
    if (!title) {
      console.log(`[ats][${src.label}] skip no-title: id=${it.id}`);
      continue;
    }
    if (!it.ref) {
      console.log(`[ats][${src.label}] skip no-ref: "${title}"`);
      continue;
    }

    let applyUrl = null;
    let detail = null;
    try {
      detail = await fetchJson(it.ref);
      applyUrl = detail?.applyUrl || null;
      if (!applyUrl) {
        console.log(`[ats][${src.label}] skip no-applyUrl: "${title}" ref=${it.ref}`);
      }
    } catch (err) {
      await logFetchError("cron_jobs_ATS-background", { url: it.ref, message: err.message });
      console.error(`[ats][${src.label}] detail fetch failed for "${title}" (${it.id}): ${err.message}`);
    }

    if (!applyUrl) continue;

    const url = normalizeUrl(applyUrl);

    let experience = isInternshipTitle(title) ? "diakmunka" : null;
    if (!experience) {
      const descHtml = extractSrDescription(detail);
      experience = (descHtml ? extractBodyExperience(descHtml) : null) || "-";
    }

    console.log(`[ats][${src.label}] ACCEPT: "${title}" exp=${experience} url=${url}`);
    results.push({ source: src.key, title, url, experience });
  }

  return { raw: all.length, mapped: results };
}

function dedupeBySourceUrl(items) {
  const seen = new Set();
  const out = [];

  for (const item of items) {
    const key = `${item.source}::${normalizeUrl(item.url)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }

  return out;
}

async function upsertJob(client, item) {
  const canonicalUrl = normalizeUrl(item.url);
  const res = await client.query(
    `INSERT INTO job_posts
      (source, title, url, canonical_url, experience, first_seen)
     VALUES ($1,$2,$3,$4,$5,NOW())
     ON CONFLICT (source, url) DO NOTHING
     RETURNING id;`,
    [item.source, item.title, item.url, canonicalUrl, item.experience ?? "-"]
  );
  return res.rowCount > 0;
}

export default withTimeout("cron_jobs_ATS-background", async () => {
  _filters = await loadFilters();

  const client = await pool.connect();
  let fetchedRaw = 0;
  let candidates = 0;
  let skippedSenior = 0;
  let newlyInserted = 0;
  let alreadyExisted = 0;

  try {
    let anyFetchFailed = false;
    const foundBySource = new Map();
    const collected = [];

    for (const src of SR_SOURCES) {
      try {
        const { raw, mapped } = await fetchSmartRecruiters(src);
        fetchedRaw += raw;
        console.log(`[ats] ${src.label}: raw=${raw} hu_mapped=${mapped.length}`);
        collected.push(...mapped);
      } catch (err) {
        anyFetchFailed = true;
        await logFetchError("cron_jobs_ATS-background", { url: `SR:${src.company}`, message: err.message });
        console.error(`[ats] ${src.label} failed: ${err.message}`);
      }
    }

    const deduped = dedupeBySourceUrl(collected);
    candidates = deduped.length;

    for (const item of deduped) {
      if (isSeniorLike(item.title)) {
        console.log(`[ats] skip senior: "${item.title}" (${item.source})`);
        skippedSenior += 1;
        continue;
      }

      const wasNew = await upsertJob(client, item);
      if (wasNew) newlyInserted += 1;
      else alreadyExisted += 1;
      if (!foundBySource.has(item.source)) foundBySource.set(item.source, []);
      foundBySource.get(item.source).push(item.url);
    }

    console.log(
      `[ats] DONE - raw=${fetchedRaw}, candidates=${candidates}, new=${newlyInserted}, ` +
      `existed=${alreadyExisted}, skipped_senior=${skippedSenior}`
    );

    // Per-source reconcile, but only if every SmartRecruiters source loaded —
    // a failed source would otherwise look like "all its jobs vanished".
    if (!anyFetchFailed) {
      for (const [src, urls] of foundBySource) {
        const rc = await reconcileActive(client, src, urls, { complete: true });
        console.log(`[ats] active reconcile [${src}] — ${JSON.stringify(rc)}`);
      }
    } else {
      console.log(`[ats] active reconcile skipped — a source fetch failed`);
    }
  } finally {
    client.release();
  }

  return new Response("OK");
});
