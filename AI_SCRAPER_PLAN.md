# AI-scraped jobs — plan

Status: **DRAFT / proposal** (2026-07-16). Nothing here is built yet. This is the design doc for
adding an AI-driven ingestion path that lands jobs in a new **`ai-scraped`** bucket, so we can add
coverage without hand-writing and maintaining a bespoke `cron_jobs_<SOURCE>` scraper per site.

Related docs: `CLAUDE.md` (architecture + scraper invariants), `CRON_JOBS_AUDIT.md`,
`DEACTIVATION_AUDIT.md`, `netlify/functions/CRON_SCHEDULE.md`, `netlify/functions/_active_core.mjs`.

---

## 1. Why

We currently run ~30 hand-coded `cron_jobs_<SOURCE>-background.mjs` scrapers. Each one encodes that
site's HTML structure, pagination, dead-job detection, and quirks (see the long institutional memory
in `_active_core.mjs`, `CRON_JOBS_AUDIT.md`, `DEACTIVATION_AUDIT.md`). This is the bulk of the
codebase and the bulk of the maintenance: when a site changes its markup, the selector silently
breaks and the source goes stale until someone notices and rewrites it. Some sites we can't scrape at
all right now (e.g. `allasportal`, `workcenter` — blocked at the Cloudflare/IP layer, see their files).

**Goal:** use an LLM (Claude API) to read a site's listing HTML and extract structured job rows,
so we stop hand-maintaining per-site selectors. New jobs land in a distinct **`ai-scraped`** bucket
in the UI so we can evaluate quality side-by-side with the hand scrapers before trusting it.

**Scope (decided 2026-07-16):** the AI pipeline **only targets sites we do NOT already scrape.** It
is for *new* coverage, never a second copy of a site a `cron_jobs_<SOURCE>` scraper already handles.

**Non-goals (for v1):** ripping out or duplicating the existing scrapers, or scraping behind logins /
heavy JS SPAs (those still need a browser; out of scope until we add a headless fetch layer).

## 0. Phase 2 automation — CURRENT DESIGN (2026-07-20): routine calls the API directly

**This supersedes §0.1 below.** The registry-file + git-push design described there never worked: the
routine fired on schedule from 2026-07-17 onward, but its `git push` silently failed every single run —
`ai_scraped_registry.json` was never committed to `main` even once (verified: `git log origin/main`
has zero commits touching that path), so not one finding ever reached the DB.

Replaced with a direct API call. The routine now:

1. **`GET /.netlify/functions/ai-registry`** at the start of a run — this is its *memory*. Routines run
   with `persist_session:false`, so without a read-back it would re-research the same ~120 already-
   rejected companies forever. Returns `sites` (with `lastChecked`, driving the 7-day re-check rule),
   `permanentlyRejected`, and `knownUrls`.
2. **`POST /.netlify/functions/ai-registry`** at the end — findings go through the same
   `_ai_ingest_core.mjs` `ingestJobs` tail every other AI-scraped write path uses, so the routine's own
   LLM judgment is still never the only gate.

The POST is **incremental, not a whole-state replace**: the routine reports only what it did this run
(`findings` / `sitesChecked` / `rejected`) and the server merges. Payloads stay small as the registry
grows, and a run that dies halfway can't truncate state it never echoed back.

State lives in **Netlify Blobs** (`ai-scraped-registry` store, key `registry.json`, strong consistency
for the read-modify-write) — it's one small bookkeeping doc, not relational data, so this avoids a
schema migration. `cron_ai_registry_sync-background.mjs` was **deleted**: its only job was bridging the
GitHub file to the DB, and that file never existed.

**Auth — the unavoidable tradeoff.** The endpoint is bearer-gated. Routines have **no** env-var
injection: the trigger API rejects `session_context.environment_variables` outright
(`"not supported on triggers — trigger configs are persisted and replayed on every fire"`), which
confirms §0.1's original concern. So the token must live in the routine's stored prompt text. Mitigated
by minting a **dedicated `AI_INGEST_TOKEN`** instead of reusing `CRON_SECRET`: a leak of this token
lets someone submit job rows that still pass every deterministic filter, and read the tracked
career-page list — it does **not** grant control of the ~30 background scrapers the way `CRON_SECRET`
would. Both `ai-registry.mjs` and `ai-ingest.mjs` accept `AI_INGEST_TOKEN` and fall back to
`CRON_SECRET`. Rotate by changing the Netlify env var and the routine's prompt together.

**Deactivating a live finding (2026-08-13):** the routine sometimes verifies during a run that a row it
(or an earlier run) already inserted is dead — a cross-platform duplicate, a since-filled posting, a
senior-level miss a live re-check caught. It still has no DB credential, so instead of asking for one,
`ai-deactivate.mjs` (same `AI_INGEST_TOKEN`/`CRON_SECRET` auth as the other two) accepts
`POST {"urls": [...], "reason": "..."}` and sets `active=false, sweep_dead=true` on matching rows —
**scoped to `source = 'AI-scraped'` only**, so even a leaked token or a bad LLM call can never touch any
other scraper's rows. It does not attempt to add new BANNER_DEAD_SOURCES-style dead-page detection for
eightfold.ai/Workday-style ATS shells (no reliable closed-status signal was found live for either); this
endpoint is the routine's own escape hatch for one-off cases it already verified by hand, not a general
sweep mechanism.

No auto-deploy side effect anymore — the routine no longer pushes to `main`, so the "production deploy
every 5 hours" consequence noted in §0.1 is gone.

## 0.1 Phase 2, the ORIGINAL registry-file design (2026-07-17) — SUPERSEDED, kept for context

The manual/in-session Phase 1 (§11) worked well (10 real finds), but the user wanted it fully
automatic without separate Anthropic API billing. Landed on a two-piece design, split across two
completely different execution environments because neither one alone can do both halves safely:

- **Discovery/research half — a Claude Code cloud "routine"** (`claude.ai/code/routines`,
  id `trig_01M97i1ZoBRxmnk6LvZYfbCa`, cron `0 */5 * * *` = every 5h). Runs on Anthropic's
  infrastructure, billed under the user's Claude subscription (NOT a separate Anthropic API key — this
  is what makes it "free" relative to Option B in §12). It has WebSearch/WebFetch + git access to this
  repo, and its job each run is: read `ai_scraped_registry.json` (repo root), re-check any tracked
  `sites` entry whose `lastChecked` is >7 days old for new postings, spend the rest of its effort
  discovering brand-new candidate companies (same 5 filters + exclusion list this whole session built
  by hand), write everything back into the registry, and `git push origin main` — but ONLY if it
  actually has DB write access would it be able to touch `job_posts` directly, and it deliberately
  does NOT: a routine has no clean way to receive a DB credential (no env-var field in its config, and
  pasting a secret into stored prompt text is a real exposure risk), so it only ever writes the JSON
  file, never the database.
- **DB-write half — a normal Netlify scheduled function**, `cron_ai_registry_sync-background.mjs`
  (schedule `20 */5 * * *`, 20 min after the routine's own cycle). This one has NO web-search/LLM
  capability at all — its only job is: fetch `ai_scraped_registry.json` via a plain HTTPS GET from
  `raw.githubusercontent.com/Andrssss/MyWebsite/main/...` (repo is public, confirmed), and feed its
  `findings` array through the exact same shared `ingestJobs` pipeline (`_ai_ingest_core.mjs`) every
  other AI-scraped write path already uses. This means the routine's own LLM judgment is never the
  ONLY gate — the deterministic `isItJob`/`isSeniorLike`/`isSeniorByYears` checks apply a second time,
  in code, before anything reaches the real DB.

**Why not just give the routine DB credentials directly?** Two reasons, both deliberate: (1) no secure
way to inject a secret into a routine's runtime was available in the tool surface we had, and (2) even
if there were, letting an unsupervised LLM agent write straight to a live production DB with zero
second check felt like a meaningfully bigger trust step than this session was ready to take silently —
real judgment-call edge cases (the "1-3 év" range bug, the Capsys "2+ years but senior-scope tooling"
call) came up even with interactive review, so a second, deterministic gate before production felt
worth the extra piece of infrastructure.

**Why not have the sync function delete processed entries from the registry instead of replaying the
whole thing every run?** A serverless function has no git-push credentials — it can read the repo's
files (via the raw-content fetch) but can't commit changes back. So instead the whole thing is designed
to be safely re-run in full every time: `ON CONFLICT (source, url) DO UPDATE` (the same upsert every
scraper already uses) makes re-processing an already-synced finding a harmless no-op. The registry only
ever grows; the sync function just keeps replaying it.

**Side effect accepted knowingly:** the routine pushes to `main`, and this repo auto-deploys on every
push to `main` — so this pipeline causes an automatic production Netlify deploy roughly every 5 hours
whenever the registry actually changes. User was shown this tradeoff explicitly (a same-repo dedicated
branch would have avoided it) and chose to push to `main` anyway.

**Status: DEAD, never worked.** The git push failed silently on every run — see §0 above. Retained
only to explain why the code looks the way it does and why the direct-API design was chosen.

---

## 2. Terminology: this is a new *source*, not a keyword *category*

In this codebase "category" already means something specific — the **keyword classification**
(`job_categories`, IT / marketing / etc.), matched from the **title** (see the memory note
"category-classification-audit"; logic is title-only keyword match). That is orthogonal to where a
job came from.

What the request calls a "category" maps cleanly onto our existing **`source`** concept
(`job_posts.source`, the per-scraper bucket listed in `FIXED` in
[`jobs.js`](netlify/functions/jobs.js)). So:

- **`ai-scraped` is modelled as a source bucket, not a `job_categories` row.**
- Keyword category classification keeps working **unchanged** — an AI-scraped job gets an
  IT/marketing/etc. category from its title exactly like every other row, no new code.

### 2.1 One UI label, per-site source values (recommended)

The active-flag model in `_active_core.mjs` keys everything on `source` (`reconcileActive(source, …)`,
the 404 sweep, the sticky/redirect sets). If we dump every AI-scraped site under a single literal
`source = 'ai-scraped'`, then reconcile becomes all-or-nothing across all sites and one site failing
poisons the whole bucket.

`FIXED` already supports aggregating several DB sources under one label via the `keys` array
(`jobs.js`: `const dbKeys = s.keys || [s.key]`). So we get the best of both:

- **DB `source` values are per-site:** `AI - muisz`, `AI - profession`, `AI - allasportal`, …
  → per-site `reconcileActive` works cleanly, one broken site can't wipe the others.
- **UI shows one bucket** by adding a single `FIXED` entry:

  ```js
  { key: "ai-scraped", label: "AI-scraped", keys: ["AI - muisz", "AI - profession", "AI - allasportal"] }
  ```

  `/jobs/sources` sums the counts; `/jobs?source=ai-scraped` unions the `AI - *` rows. No other API
  change needed — the aggregation path already exists.

Prefix chosen as `AI - <site>` so it's greppable and can never collide with an existing source name.

---

## 3. Two extraction approaches (and the recommended hybrid)

### Approach A — "AI reads every page"
Each run: fetch listing HTML → strip to text/markup → send to Claude → Claude returns a JSON array of
jobs. Simple, maximally robust to markup changes, **but** you pay LLM tokens on every page of every
site on every run. Cost scales with volume (see §8).

### Approach B — "AI authors the extractor" (recipe caching)
Ask Claude **once per site** to produce a small deterministic extraction recipe (the CSS selectors /
field mapping for that listing), store it in a `ai_extractors` table, and run it with `cheerio` on the
hourly cron with **no LLM call**. Only re-invoke Claude when the recipe stops working (0 rows, or a
validation tripwire fires) — i.e. when the site's markup actually changed. This is the real
maintenance win: no hand-written selectors, and the "self-healing" happens by re-prompting instead of
by a human.

### Recommended: **hybrid, B-first**
- Default to **B** (recipe) for stable server-rendered listings — cheap, fast, deterministic.
- Fall back to **A** (per-page LLM read) for sites where a static recipe can't be made reliable
  (irregular cards, inline-rendered data). Same code path, just a per-site `mode` flag.
- A tripwire (`extracted 0 rows` or `< N% of expected`) demotes a site from B→A for one run and
  queues a recipe regeneration.

`mode` per site: `recipe` | `llm-read` | `disabled`.

---

## 4. Fitting the existing scraper invariants

Whatever extracts the rows, the ingestion tail **must reuse the existing machinery** — these are the
invariants from `CLAUDE.md` and they are non-negotiable:

- **Upsert keyed on `url`** (`ON CONFLICT (source, url)`), with `source = 'AI - <site>'`.
- **`reconcileActive(client, 'AI - <site>', foundUrls, { complete })`** at the end of a *complete* run —
  reactivates re-seen rows, deactivates aged-out ones. Pass `complete:false` on any partial/failed
  fetch so a broken run can never mass-deactivate (same rule as every other scraper).
- **`withTimeout("cron_jobs_AI-background", …)`** wrapper so failures land in the Netlify
  function log instead of dying silently.
- **Senior filter** (`loadFilters` + the title blacklist) and **company blocklist**
  (`_company_blocklist.mjs`, per-source list) applied before upsert, exactly like `ALLASPORTAL`.
  The `foundUrls` passed to reconcile must be the **full** pre-filter set (F3 rule) so a filter change
  doesn't deactivate a live job.
- **Experience / technologies**: reuse `_experience_core.mjs` title shortcuts; optionally let the LLM
  fill `experience` from the card, but keep the **fetch-before-insert** rule (row fully built before
  the upsert; no separate fetch-then-UPDATE — see memory "experience-write-policy").
- **Volatile-URL sites** still need `migrateVolatileUrl` if the AI-scraped URL embeds a rotating id.
- **Location policy** (Budapest-only etc.) — reuse the two-stage fail-open filter approach if the
  target site mixes regions (memory "profession-location-gotchas").

Net: the AI part only replaces the **fetch + parse** step. The **dedup, active-flag, filtering, and
logging** tail is the same shared code every scraper already uses.

---

## 5. New sites only — so there is no dedup problem

**Decision (2026-07-16): the AI pipeline never targets a site we already have a
`cron_jobs_<SOURCE>` scraper for.** It exists purely to add coverage of *new* sites — ones we don't
scrape today and don't want to hand-code a bespoke scraper for.

Because the AI target sites are **disjoint** from the existing hand-scraped sources, the same posting
can never exist under two sources. That eliminates the dedup concern entirely and means we need **no
shadow/cutover machinery**:

- Each AI-scraped site gets its own `AI - <site>` source and shows up in the `ai-scraped` UI bucket.
- Existing hand scrapers are untouched — we are not replacing or shadowing them.
- If we ever want AI to take over a site we already scrape, that's a separate future decision, out of
  scope here.

---

## 6. Data model

No schema migration for `job_posts` (source is just a string; category classification is title-based).
Two additions:

1. **`FIXED` entry** in `jobs.js` (§2.1) — one `ai-scraped` label aggregating the `AI - *` sources.
2. **`ai_extractors` table** (only if we do Approach B), created lazily like every other table:

   ```sql
   CREATE TABLE IF NOT EXISTS ai_extractors (
     site         text PRIMARY KEY,        -- e.g. 'allasportal'
     source_value text NOT NULL,           -- 'AI - allasportal' (or canonical after cutover)
     list_url     text NOT NULL,           -- listing/entry URL(s), JSON if several
     mode         text NOT NULL DEFAULT 'llm-read', -- recipe | llm-read | disabled
     recipe       jsonb,                   -- selectors/field-map produced by the LLM
     recipe_model text,                    -- which model authored it (audit)
     full_listing boolean NOT NULL DEFAULT false, -- true only if list_url shows the ENTIRE
                                            -- listing in one fetch → reconcile may deactivate.
                                            -- Default false = reactivate-only, 404-sweep owns deaths.
     last_ok      timestamptz,             -- last run that extracted > 0 valid rows
     last_regen   timestamptz,             -- last time the LLM (re)authored the recipe
     fail_streak  int NOT NULL DEFAULT 0
   );
   ```

   `recipe` is the deterministic map the cron runs with cheerio (Approach A sites just leave it null
   and set `mode='llm-read'`).

Everything else — `active`, `sweep_dead`, `experience`, `technologies`, `company` — already exists on
`job_posts` and is reused as-is.

---

## 7. Components to add

```
netlify/functions/
  _ai_extract_core.mjs            # the LLM boundary: HTML -> jobs[]; and HTML -> recipe
  cron_jobs_AI-background.mjs     # background worker: for a batch of sites, fetch->extract->filter->upsert->reconcile
  ai-extractors.js                # (optional) small admin API to CRUD ai_extractors, like categories.js/filters.js
```

- `cron_jobs_AI-background.mjs` is a **background** function (15-min budget) wrapped in `withTimeout`,
  authed by `Authorization: Bearer $CRON_SECRET`, and triggered by `cron_dispatcher_daily.mjs`
  (AI-scraped sites are low-volume; daily is the right tier — see `CRON_SCHEDULE.md`). Process sites
  in batches so one run stays inside the budget and one site's failure is isolated (`complete:false`
  for that site only).
- `_ai_extract_core.mjs` owns *all* Anthropic API usage (one place to manage key, model, caching,
  retries, cost logging). It never touches the DB — it takes HTML in, returns validated rows out.
- Reuse `_error-logger.mjs`, `_active_core.mjs`, `_company_blocklist.mjs`, `_experience_core.mjs`,
  `load_filters.mjs` unchanged.

Admin UI (later, optional): a hidden route like `/allasfigyelo/ai` mirroring the existing
`/allasfigyelo/categories` and `/allasfigyelo/filters` pages to add sites, see per-site status
(`last_ok`, `fail_streak`, `mode`), and trigger a manual regenerate.

---

## 8. The Claude API extraction contract

All calls go through `_ai_extract_core.mjs` using the official SDK (`@anthropic-ai/sdk`).

**Model:** default sketch uses `claude-opus-4-8`. Because this is a high-volume, mechanical
extraction task, **model choice is an explicit cost decision for you** (§8.1) — a smaller model may be
the right call for the bulk read; keep the strongest model for recipe authoring / hard pages.

**Structured outputs** so we never regex model prose — constrain the response to a strict schema:

```js
// _ai_extract_core.mjs (sketch)
import Anthropic from "@anthropic-ai/sdk";
const client = new Anthropic(); // ANTHROPIC_API_KEY from env

const JOB_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["jobs"],
  properties: {
    jobs: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["title", "url"],
        properties: {
          title:    { type: "string" },
          url:      { type: "string" },       // MUST be an absolute URL present in the input HTML
          company:  { type: ["string", "null"] },
          location: { type: ["string", "null"] },
        },
      },
    },
  },
};

export async function extractJobs(pageHtml, { baseUrl }) {
  const res = await client.messages.create({
    model: "claude-opus-4-8",
    max_tokens: 16000,                          // stream + get_final_message if a listing can exceed this
    output_config: { format: { type: "json_schema", schema: JOB_SCHEMA } },
    system: [
      { type: "text",
        text: EXTRACTION_INSTRUCTIONS,          // stable across all sites+pages
        cache_control: { type: "ephemeral" } }, // cache the instructions+schema prefix
    ],
    messages: [
      { role: "user", content:
        `Base URL: ${baseUrl}\nExtract every distinct job posting from this listing HTML. ` +
        `Only output a job if its link appears verbatim in the HTML.\n\n<html>\n${pageHtml}\n</html>` },
    ],
  });
  return JSON.parse(textOf(res)).jobs;
}
```

Key points:
- **Prompt caching** (`cache_control` on the stable instructions+schema block) — the system prefix is
  identical for every site and every page, so after the first call each request pays ~0.1× on that
  prefix. Put the volatile HTML in the user turn, after the cached prefix (prefix-match rule).
- **Token control:** strip `<script>/<style>/<svg>/<head>/comments` and collapse whitespace before
  sending (cheerio). Send **one page at a time**; paginate deterministically.
- **Hallucination guard:** discard any returned `url` that does **not** appear as a substring of the
  input HTML — this is the single most important validation (an LLM can invent plausible URLs). Also
  normalize URLs (drop `utm_*`, resolve relative → absolute against `baseUrl`) exactly like the
  existing scrapers' `normalizeUrl`.
- **Recipe authoring (Approach B)** is the same call with a different system prompt: "return CSS
  selectors + field map as JSON" instead of the rows themselves; store in `ai_extractors.recipe`.

### 8.1 Cost model & levers

Rough per-page estimate (≈30k input tokens stripped HTML + ≈2k output), before prompt-cache savings:

| Model          | Input $/1M | Output $/1M | ≈ $ / page |
|----------------|-----------:|------------:|-----------:|
| Haiku 4.5      |     $1.00  |      $5.00  |     ~$0.04 |
| Sonnet 5       |     $3.00  |     $15.00  |     ~$0.12 |
| Opus 4.8       |     $5.00  |     $25.00  |     ~$0.20 |

Levers that dominate the bill:
1. **Approach B (recipe) vs A (read-every-page).** B calls the LLM ~once per site per *markup change*,
   not per run — this is a 100–1000× reduction in LLM calls vs A at hourly cadence. **Biggest lever.**
2. **Cadence** — daily, not hourly, for the AI tier (these are low-volume sites anyway).
3. **Model** — Haiku 4.5 for bulk extraction, a stronger model only for recipe authoring / hard sites.
4. **Prompt caching** the instruction/schema prefix.
5. **HTML stripping** — fewer input tokens per page.

Add a per-run cost line to the function log (sum `usage.input_tokens` / `output_tokens` × rate) so we
can watch spend from the start.

---

## 8.2 Experience & technologies (user requirement, 2026-07-16)

Every hand scraper fills `job_posts.experience` and `.technologies`, and does it with a specific
precedence: **title-based classification wins when it matches** (diákmunka/junior/medior via
`isInternshipTitle`/`isJuniorTitle`/`isMidLevelTitle` in `_experience_core.mjs`); only when the title
gives no signal does the scraper fetch the job's own DETAIL page and fall back to a body-derived value
(`extractBodyExperience` → a free-text years phrase like "8 év", plus `extractTechnologies` → a
comma-joined list of recognized keywords). The row is fully built BEFORE insert — never a separate
fetch-then-UPDATE (see [[experience-write-policy]]).

The `ai-scraped` pipeline follows the exact same precedence (`_ai_ingest_core.mjs` `resolveExperience`)
— `ingestJobs` now accepts optional `experience`/`technologies` per job and only uses them when the
title alone resolves to `"-"`. In Phase 1 (in-session), that means: after picking the jobs to ingest,
fetch each one's own detail page and pull the real experience/technologies signal — don't just leave
`experience: "-"` when the title is generic (see §8.3 for why this matters). In the automated Phase 2
worker, this becomes a per-URL detail fetch feeding `extractBodyExperience`/`extractTechnologies`
directly, same as any other scraper.

## 8.3 Years-based senior gate — AI-PIPELINE-ONLY (user requirement, 2026-07-16)

**Real incident that motivated this:** bap.hu's "Java szoftverfejlesztő" and "PHP backend fejlesztő" —
both generic, non-senior-sounding titles — turned out on their detail pages to require **8+** and **5+**
years of experience respectively. The title-keyword blacklist (`isSeniorLike` / `loadFilters()`) can
never catch this, since the title itself says nothing senior — only the body reveals it.

None of the other ~30 hand scrapers reject on body-stated years — they just record the years honestly
for stats (`job_daily_stats`, `ZERO_RANGE_EXPERIENCE_REGEX` etc.), because every one of those sources
was individually vetted by a human as student/entry-level-focused before it was ever wired up. An
AI-discovered career page has no such guarantee — it's picked from a general web search, so a stricter,
AI-pipeline-ONLY gate is warranted (and does not change behavior for any of the existing 30 scrapers).

Implementation (`_ai_ingest_core.mjs`): `isSeniorByYears(resolvedExperience)` parses the largest
"N év/éves/years" number out of a body-derived experience string and rejects (counts toward
`skippedSenior`) at **≥ 3 years**. It never fires on the four canonical title-matched labels
(`diákmunka`/`junior`/`medior`/`-`) — a title-matched "medior" is a legitimate, non-rejected category
everywhere else in the app, so this only targets the specific failure mode: a generic title whose body
reveals real seniority. Threshold (3) is a judgment call, tune if it proves too strict/loose in practice.

**Range fix (2026-07-17):** a real find (WM Rendszerház "Back End Fejlesztő", stated "1-3 év szakmai
tapasztalat") exposed a bug — `parseMaxYears` took the MAX number found in the string, so a range's
upper bound got compared to the threshold. But a range signals the poster accepts the LOWER bound
("1-3 év" ⇒ they'd take someone with 1 year), which is a fundamentally different signal than an
unambiguous floor like bap.hu's "legalább 8 év" (minimum 8, no upper bound at all). Fixed: an explicit
"N-M év" range now uses N (the lower bound); a plain floor phrase still uses the max across all such
mentions (unchanged). Verified: "1-3 év" → not senior, "3-5 év" → still senior (floor itself is at the
threshold), "8 év"/"legalább 8 év" → still senior (regression-tested, unchanged).

## 8.4 Dead-job detection for `AI - *` sources (user requirement, 2026-07-16)

**No new mechanism needed — already covered by the existing shared 404 sweep.** `sweepActive404`
(`_active_core.mjs`, run daily via `cron_404sweep-background.mjs` → `cron_dispatcher_daily.mjs`) selects
every `active = true` row from `job_posts` **except** `SWEEP_EXCLUDED_SOURCES` (currently `{LinkedIn,
tudasdiak}` — confirmed by reading the source, 2026-07-16). `AI - <site>` sources are never in that
exclusion set, so any AI-scraped row that goes active is automatically re-checked for a real 404 (or,
for sites later added to `REDIRECT_DEAD_SOURCES`/`BANNER_DEAD_SOURCES`, a redirect-to-different-path or
closed-banner) — exactly like every hand-scraped source that isn't a full-listing walker.

**Caveat to verify per-site, not assumed:** this only works if a dead posting's OWN detail-page URL
plainly 404s. Several existing sources instead soft-404 (200 + a "this posting has expired" banner, or
a redirect to an unrelated listing page) — allasportal, nofluffjobs, talent, and bluebird all needed a
specific rule added to `BANNER_DEAD_SOURCES` or `REDIRECT_DEAD_SOURCES` after a human confirmed the
site's actual dead-posting behavior on a real example. Do the same check the first time an AI-scraped
site's posting is confirmed to have closed: if the sweep isn't deactivating it, that site needs its own
entry in one of those two sets (`_active_core.mjs`) — same as every precedent case, not a new pattern.

## 9. Reliability & guardrails

- **Fail-open reconcile:** empty/failed extraction → `complete:false` → no deactivation (same guard as
  every scraper; see `_active_core.mjs` doc comments).
- **URL-in-HTML check** (§8) to kill hallucinated rows before they ever reach the DB.
- **Row cap / sanity:** if a page yields absurdly many or zero rows vs the recipe's historical count,
  treat as incomplete and trip the B→A / regenerate path instead of writing.
- **Same senior + company-blocklist filtering** as `ALLASPORTAL`, with the full pre-filter URL set fed
  to reconcile.
- **Dead-job detection:** AI-scraped sources rely on the shared 404 sweep (`sweepActive404`) unless the
  listing is a full re-enumeration each run (then reconcile handles it). Decide per site; default to
  letting reconcile + the sweep do their jobs, and add to `REDIRECT_DEAD_SOURCES` /
  `BANNER_DEAD_SOURCES` only after live-checking, per the existing rules.
- **Idempotency / cost cap:** a per-run hard ceiling on LLM calls so a pathological run can't rack up
  spend; over the ceiling → stop and log.

---

## 10. Secrets / env

- **`ANTHROPIC_API_KEY`** — new Netlify env var (not currently set; see the env list in `CLAUDE.md`).
- Reuses existing `NETLIFY_DATABASE_URL`, `CRON_SECRET`, `URL`.

---

## 11. Rollout milestones

0. **Phase 1 — in-session (current, per user 2026-07-16): no Anthropic API yet.** Claude fetches an
   approved site during a chat, extracts jobs, and POSTs them to `ai-ingest.mjs`
   (`Bearer $CRON_SECRET`) → `AI - <slug>`. Site decisions live in the `AI_SITES.md` checklist. The
   automated worker (`cron_jobs_AI-background.mjs`) is built but **left off every schedule** until we
   move to automation; intended cadence then is **every 5 hours** (a 5-hourly trigger, not the daily
   dispatcher). The extract/ingest cores and `ai-scraped` bucket below are already in place.
1. **M0 — plumbing:** `ai-scraped` bucket in `jobs.js` (prefix-matched, so adding a site needs zero
   `jobs.js` edits), `_ai_extract_core.mjs` (extraction call + recipe run + URL-in-HTML validation),
   `_ai_ingest_core.mjs` (shared filter/upsert/reconcile tail), `ai-ingest.mjs` (in-session write
   path), `cron_jobs_AI-background.mjs` worker (data-driven from `ai_extractors`), `ai-extractors.js`
   admin API, `ANTHROPIC_API_KEY` set (only needed once automation starts).
2. **M1 — one NEW site end-to-end** via Approach A (llm-read): seed one site into `ai_extractors`,
   fetch→extract→filter→upsert `AI - <site>`→reconcile. Verify in the UI under `AI-scraped`. Log cost.
3. **M2 — Approach B recipe path** turned on for that site (`mode='recipe'`), with the 0-rows tripwire
   auto-regenerating the recipe; confirm cost drops.
4. **M3 — scale to more new sites** by seeding rows via the admin API.

Each milestone updates the live audit docs, same as any scraper change.

---

## 12. Decisions

**Resolved (2026-07-16):**
1. **Scope:** NEW sites only — never a site we already scrape (§5). No dedup, no cutover.
2. **Approach:** hybrid B-first (recipe caching, cheap) — §3.
4. **Bucket:** `ai-scraped` is a **permanent** distinct bucket in the UI.

**Still open:**
3. **Model:** `claude-opus-4-8` (default) vs `claude-haiku-4-5` (cheapest, likely fine for mechanical
   extraction) vs `claude-sonnet-5`. Pure cost/quality tradeoff (§8.1). Code defaults to
   `claude-opus-4-8`; swap in one place (`_ai_extract_core.mjs` `MODEL`).
5. **First target site(s):** which new site(s) to seed into `ai_extractors` for M1.

---

## 13. Risks

- **Hallucinated jobs / wrong fields** — mitigated by structured outputs + URL-in-HTML check + row
  sanity caps, but needs eyeballing during M1/M2.
- **Cost creep** — mitigated by Approach B, daily cadence, caching, and a hard per-run call cap; watch
  the logged spend.
- **JS-rendered sites** — out of scope until a headless-fetch layer exists; recipe/read both need the
  jobs present in the fetched HTML.
- **Dedup regressions** — only appear if Phase 1 discipline slips and AI is pointed at an
  already-scraped site under `AI - *`; the phasing in §5 is the mitigation.
- **Silent staleness** — an AI source that quietly returns 0 must trip `complete:false` and a
  regenerate, never a mass-deactivation; covered by §9 but must be tested.
