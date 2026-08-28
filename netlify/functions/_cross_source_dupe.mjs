/*
  Cross-source duplicate guard.

  Some sources are aggregators that mostly re-list postings we already ingest
  straight from the employer (startup.jobs is the first one wired up: a
  2026-08-28 overlap analysis found 45 of its 56 rows were already on the board
  from ats-crawl / LinkedIn / AI-scraped / profession-intern / alllocaljobs /
  talent, with no meaningful time advantage — median discovery lag ~0 days).

  The dedupe key is deliberately the one the site owner asked for:

      <first real word of company>  |  <normalized title>

  ...and it is matched against EVERY other source, not a whitelist. A hardcoded
  "sources worth checking" list is the exact bug class this repo keeps hitting
  (see the melonjobs / unicredit taxonomy-ID lists): the moment a new scraper
  lands, the list is silently wrong. Checking all of them costs one extra query
  per run.

  Company-name normalization has to survive raw ATS entity labels, which is
  what startup.jobs actually serves: "100 Shift4 Payments, LLC",
  "111 - GoTo Technologies USA, LLC", "8100 United States - Genesys Cloud
  Services, Inc.", "435 Itron Mgmt Svcs Ireland, Ltd", "C_001 Transaction
  Network Services, Inc.", "BR02 VALEO SISTEMAS AUTOMOTIVOS LTDA". A naive
  "first word" on those yields "100"/"111"/"8100"/"c_001"/"br02" and matches
  nothing, so a leading numeric/alphanumeric entity code is stripped first —
  and ONLY when such a code was present may a following "<region> - " segment
  be stripped too ("8100 United States - Genesys …" → "genesys"). Without that
  guard a legitimate name like "Roland Berger - Digital" would lose its head.
*/

function stripDiacritics(s) {
  return String(s ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "");
}

// Title key: lowercase, accent-free, punctuation-free, whitespace-collapsed.
// The only semantic normalization is the frontend/backend/fullstack spacing
// variance — pure spelling, and it is what made a real duplicate slip through
// the first analysis pass ("Frontend Engineer" vs LinkedIn's "front end
// engineer" at Qneiform). Deliberately NOT normalizing developer↔engineer or
// dropping seniority words: those are different jobs often enough to matter.
export function normalizeDupeTitle(title) {
  return stripDiacritics(title)
    .toLowerCase()
    .replace(/front[\s-]?end/g, "frontend")
    .replace(/back[\s-]?end/g, "backend")
    .replace(/full[\s-]?stack/g, "fullstack")
    .replace(/[^a-z0-9+#]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

// First meaningful word of the company name (see header for the entity-code
// handling). Returns "" when there is nothing usable — callers must treat an
// empty key as "cannot compare", never as a match.
export function normalizeDupeCompany(company) {
  let s = stripDiacritics(company).trim();
  if (!s) return "";

  // Leading ATS entity code: "8100 ", "435 ", "BR02 ", "C_001 ".
  const codeMatch = s.match(/^([0-9]+|[A-Za-z]{1,3}[_-]?[0-9]{2,5})\s+/);
  if (codeMatch) {
    s = s.slice(codeMatch[0].length);
    // Only now is a "<region/whatever> - " prefix safe to drop.
    const seg = s.match(/^[^-–]{1,30}[-–]\s+/);
    if (seg) s = s.slice(seg[0].length);
  }

  const words = s.toLowerCase().split(/[^a-z0-9+]+/).filter(Boolean);
  for (const w of words) if (w.length >= 2) return w;
  return words[0] ?? "";
}

export function dupeKey(company, title) {
  const c = normalizeDupeCompany(company);
  const t = normalizeDupeTitle(title);
  if (!c || !t) return "";
  return `${c}|${t}`;
}

/*
  Build the lookup set from every row of every OTHER source.

  Scope is "every row still in job_posts", inactive ones included, on purpose:
  keying only on active rows would let a posting bounce back in the moment the
  employer-side source deactivates it, which is exactly the flip-flop churn
  _active_core.mjs exists to prevent. Rows inactive for 60+ days are already
  archived out of the table by cron_jobposts_cleanup.mjs, so this stays bounded
  on its own.
*/
export async function loadCrossSourceDupeIndex(client, ownSource) {
  const { rows } = await client.query(
    `SELECT company, title
       FROM job_posts
      WHERE source <> $1
        AND company IS NOT NULL AND company <> ''
        AND title IS NOT NULL AND title <> ''`,
    [ownSource]
  );
  const index = new Set();
  for (const r of rows) {
    const k = dupeKey(r.company, r.title);
    if (k) index.add(k);
  }
  return index;
}

// Rows with no company can never be compared (A_K / schönherz style anonymous
// clients) — those are kept, not dropped, so a missing company field can never
// silently delete coverage.
export function isCrossSourceDupe(index, company, title) {
  const k = dupeKey(company, title);
  return !!k && index.has(k);
}
