# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

> **Ignore `.github/CLAUDE.md`** — it belongs to an unrelated project ("caveman", unpacked from `.github.rar` by accident), same for `.github/prompts/` and `.github/CONTRIBUTING.md`. This file is the only valid CLAUDE.md.

## What this is

Personal website at https://bakan7.netlify.app — a Vite + React SPA with a Netlify Functions backend, all in one repo. Two products:

1. **University pages** — subject info & reviews ("tárgy info"), university links, and file sharing backed by Google Drive.
2. **Állásfigyelő (job watcher)** — ~30 scheduled scrapers ingest Hungarian student/entry-level job postings into Postgres; UI at `/allasfigyelo`. This is the bulk of the codebase.

UI text, code comments, and docs are largely Hungarian. There is no test framework; `test_jobs.js`, `script.js`, `src/temp.jsx` are scratch files and `src/Express.js` is empty.

## Commands

- `npm run dev` — Vite frontend only (calls to `/.netlify/functions/*` will 404)
- `npx netlify dev` — frontend + functions locally (needs env vars; scheduled functions still only fire when invoked manually)
- `npm run build` — production build to `dist/`
- `npm run lint` — ESLint
- `npm run server:dev` — legacy standalone Express reviews API (`server/server.js`); production uses Netlify Functions instead

Deploy = push to `main`; Netlify builds per `netlify.toml` (publish `dist`, functions from `netlify/functions`, esbuild, Node 20). `dist/` and `.netlify/functions-serve/` are build artifacts — never edit them.

## Where data lives

**Neon Postgres** — connection string in `NETLIFY_DATABASE_URL` (`NETLIFY_DATABASE_URL_UNPOOLED` for backups). There is no migrations directory: schema is created/patched lazily in function code (`CREATE TABLE IF NOT EXISTS` / `ADD COLUMN IF NOT EXISTS`).

| Table | What it holds | Writers → readers |
|---|---|---|
| `job_posts` | every scraped job posting; **`url` is the row identity**; `active` flag = still listed on source | all `cron_jobs_*` scrapers → `jobs.js` API |
| `job_daily_stats` | daily per-source aggregates | `cron_daily_stats.mjs` → `job-stats.js`; pruned by `cron_stats_cleanup.mjs` |
| `job_daily_categories` | daily per-category counts (`intern:` prefix = student/intern split) | same writers/readers as `job_daily_stats` |
| `job_categories` | category → keyword lists for classification | edited via `categories.js`, read by `load_categories.mjs` (5-min cache) |
| `job_filters` | title filter words | `filters.js`, `load_filters.mjs` |
| `subject_reviews` | university subject reviews | `reviews.js`; seedable via `seed-subjects.mjs`; backed up monthly |
| `targy_kerelem` | subject requests submitted from the site | `subject-request.js` |
| `bug_reports` | bug-report widget submissions | `bug-report.js` |
| `admin_applied_jobs` | jobs the admin marked as applied | `job-applied.js` (gated by `ADMIN_VISITOR_IDS` allowlist) |
| `visitor_click_dates` | visitor analytics | `visitor-click.js`, `daily-visitor.js` |

**Netlify Blobs** stores:
- `recovery-logs` — self-healing events (URL migrations, reactivations), written by `_error-logger.mjs` (the companion `fetch-error-logs` store and its `clear-error-blobs.mjs` cleanup endpoint were removed 2026-09-01 — scraper fetch failures now go to the Netlify function log only)
- `weekly-backups` — `subject_reviews` JSON dumps (despite the name, runs monthly on the 1st, ~10-day retention — `weekly-backup.js`)
- `ai-scraped-registry` — the AI discovery routine's cross-run memory (checked sites + `lastChecked`, permanently-rejected list, already-found URLs), read/written by `ai-registry.mjs`
- `zip-jobs` — async Drive-folder ZIP job results (`download-folder-background.mjs` → `download-result.mjs`)
- `job-posts-archive` — cold storage for `job_posts` rows that have been `active=false` for 60+ days (past both the frontend's 30-day inactive-visibility window and `reviveSweepDead`'s 45-day self-healing window, so nothing live reads them back); one JSON blob per month, written and then deleted from Postgres by `cron_jobposts_cleanup.mjs` — added 2026-08-18 as the table's inactive-row backlog started growing unbounded

**Google Drive** — the actual file storage for subject materials. Reads use rotating API keys (`drive-files`, `list-files-recursive`, `proxy-file`, `download-folder*`); uploads use a service account (`upload-to-drive.js`, setup in `DRIVE_UPLOAD_SETUP.md`).

**Static in-repo data** — `src/components/semesterData_pretty.js` (semester/subject structure rendered on the site).

## Architecture

### Frontend (`src/`)
React Router SPA; all routes live in `src/App.jsx` with Hungarian paths: `/targy_info`, `/egyetemi_linkek`, `/User_oldalak`, `/rolam`, `/allasfigyelo` plus hidden `/allasfigyelo/filters`, `/allasfigyelo/categories`, `/allasfigyelo/stats`. Everything calls the backend at `/.netlify/functions/...`. `JobWatcher.jsx` is the job-board UI; admin-only features unlock by browser visitor-id matching the allowlist in `job-applied.js`.

### Backend (`netlify/functions/`)
- **HTTP API**: `jobs.js` (job list; per-warm-container 60s cache; CORS pinned to the prod origin), `job-stats.js`, `categories.js`, `filters.js`, `reviews.js`, `bug-report.js`, `subject-request.js`, visitor tracking, Drive functions.
- **Shared cores** (prefix `_`, not routable): `_active_core.mjs` (active-flag reconcile + volatile-URL migration), `_linkedin_core.mjs`, `_experience_core.mjs` / `_profession_core.mjs` (backfill classification), `_error-logger.mjs` (`withTimeout` wrapper + blob logging), `_backup-core.js`, `_stats_core.mjs` + `_stats_rebuild_core.mjs` (see below).

**Stats are derived data — rebuild them, don't patch them.** `job_daily_stats`/`job_daily_categories` are just a nightly *snapshot* of rules that keep changing, so every category rename/retune leaves the saved history stale. **Since 2026-09-01 the classification rules are NOT owned by this repo.** The published board at pestidev.hu (separate repo `Andrssss/allasfigyelo`, local clone `c:\Users\Andris\allasfigyelo`) renders these same tables on its stats page, so the numbers have to mean what ITS filters mean — its `app/lib/categorize.ts` + `app/lib/experience.ts` are the reference implementation. This repo carries a 1-1 port in **`src/lib/categorize.mjs`** and **`src/lib/experienceLevel.mjs`**, and there is now exactly **one** copy: both `src/JobWatcher.jsx` (admin board) and `_stats_core.mjs` (which is now only the day-level aggregation) import it. **If the rule changes there, re-port it here, then rebuild** — three independently-edited copies had silently drifted before 2026-08-26, and the port itself was overdue: the v2 keyword table uses a `~` STEM prefix (34 such keywords live in `job_categories`) that this repo's old `*`-wildcard matcher could not read at all, so ~370 postings per archive sample sat in "uncategorised" that belonged on a real shelf. Note the fallback category is `Fejlesztő` (the actual DB name) and the no-match bucket is `Egyéb`. **`netlify/functions/_experience_core.mjs` is a different thing and must NOT be aligned to this** — that is the scrapers' WRITE side (what goes into `job_posts.experience`); `src/lib/experienceLevel.mjs` is the READ side (how a stored value is classified). `_stats_rebuild_core.mjs` recomputes any date range from the raw postings — `job_posts` **plus the `job-posts-archive` blobs**, without which every day older than ~60 days rebuilds as zero — and writes each range in one transaction. Run it from a disposable `tmp-*` endpoint (blobs need site context, and the prod connection string isn't available locally); the local `backfill_daily_stats.mjs` CLI is gitignored and needs `NETLIFY_SITE_ID`/`NETLIFY_API_TOKEN` to see the archive.

### Scraper/cron system
~30 `cron_jobs_<SOURCE>-background.mjs` Netlify **background** functions ingest into `job_posts`. Scheduling is two-tier (reference doc: `netlify/functions/CRON_SCHEDULE.md`):

- **Directly scheduled** via `export const config = { schedule: "..." }` in-file: LinkedIn shards `cron_jobs_L_1..L_8` (staggered minutes, hours `4-22` UTC), `cron_experience-background.mjs`, `cron_daily_stats.mjs` (23:59), `weekly-backup.js`. (`cron_stats_cleanup.mjs` has **no** `config.schedule` and nothing invokes it — it never runs, which is why the monthly "delete last month" it implements has not been eating the 6-month graph.)
- **Dispatcher-triggered**: `cron_dispatcher.mjs` (hourly, high-volume sources), `cron_dispatcher_daily.mjs` (14:00 UTC, sources with <10 postings), `cron_dispatcher_test.mjs`, and `cron_jobs_P.mjs` POST to the background workers with `Authorization: Bearer $CRON_SECRET`. Workers reject requests without the secret.

**Scraper invariants — keep these when touching any scraper:**
- Upsert keyed on `url`. Sources whose URLs contain volatile IDs must go through `migrateVolatileUrl` (`_active_core.mjs`) so the row migrates in place instead of churning (insert-new + deactivate-old breaks dedupe and stats).
- At the end of a **complete** run call `reconcileActive(client, source, foundUrls)`: reactivates re-seen rows, deactivates rows older than `ACTIVE_GRACE_DAYS` (3, by `first_seen`) that vanished. It deliberately does nothing on an empty result set or `complete:false`, so a blocked/broken crawl can never mass-deactivate a source. Also beware two scrapers reconciling the same `source` value — they wipe each other's finds.
- LinkedIn never uses the active model (it only sees a recent window); it stays time-based on the frontend.
- Wrap every cron handler in `withTimeout` so a crash or a hung run is logged (and the process killed) instead of dying silently.

**Validating "is source X broken?" / "are there really no new postings?" — always check a different way than the scraper itself:**
Never validate a scraper's live behavior by re-running (or re-importing) that scraper's own extraction/URL-building/filter functions against a fresh fetch — that only proves the code agrees with itself. A bug in the original logic (wrong category/tag IDs, a bad senior-filter, a broken slug-builder) reproduces identically and looks like confirmation instead of getting caught. Validate through a channel that shares no code or assumptions with the scraper: the public site's own listing/search UI, a broader/unfiltered query, a different endpoint, a sitemap, or a plain visual check of the source — then diff *that* against what's in the DB. (2026-07-21: "is dreamjobs broken" was checked by copy-pasting `buildDreamJobsUrl`/`isSeniorLike` out of `cron_jobs_MIX-background.mjs` and running them against a fresh pull of the scraper's own two hardcoded API URLs — worthless as independent proof, even though the conclusion happened to be right.)

### Live audit docs — update them when you fix a scraper
- `CRON_JOBS_AUDIT.md` (root) — per-source fetch/pagination/completeness checklist
- `DEACTIVATION_AUDIT.md` (root) — per-source active-flag correctness checklist
- `scripts/*_SCRAPE_RESEARCH.md` — per-source endpoint/API research notes

## Environment variables

Set in the Netlify dashboard (local `.env` is minimal). Names in use: `NETLIFY_DATABASE_URL`, `NETLIFY_DATABASE_URL_UNPOOLED`, `CRON_SECRET`, `URL` (Netlify-provided; dispatchers build worker URLs from it), `ALLOWED_ORIGIN`, `GDRIVE_API_KEY_1`/`GDRIVE_API_KEY_2`/`GOOGLE_DRIVE_API_KEY`, `GOOGLE_SERVICE_ACCOUNT_JSON`, `DRIVE_UPLOAD_FOLDER_ID`, `MINDDIAK_API_BEARER`, `LINKEDIN_DISABLED`, `ANTHROPIC_API_KEY` (only for `cron_jobs_AI-background.mjs`, which is currently on no schedule — the discovery routine does NOT use it, see `AI_SCRAPER_PLAN.md`), `AI_SCRAPER_MODEL` (optional model override, default `claude-opus-4-8`), `AI_INGEST_TOKEN` (bearer for `ai-registry.mjs` + `ai-ingest.mjs`; scoped on purpose so the discovery routine never holds `CRON_SECRET` — falls back to `CRON_SECRET` when unset), `STARTUPJOBS_API_KEY` (bearer for `cron_jobs_STARTUPJOBS-background.mjs`'s calls to the official `api.startup.jobs/v1` REST API — free-tier key from a startup.jobs account, see that file's header).

`last-deploy.js` (powers the "Utoljára frissítve" timestamp on `/allasfigyelo`) reuses `CRON_SECRET` as the bearer token for the Netlify API call `GET api.netlify.com/api/v1/sites/{SITE_ID}/deploys` — that only works if `CRON_SECRET`'s value is actually set to a Netlify personal access token (User settings → Applications → New access token), not just an arbitrary app secret. `SITE_ID` is auto-provided to functions at runtime, no setup needed.

**Admin credentials — two tiers, deliberately separate.** Never hardcode either in source: an earlier model used a source-committed visitor UUID as the admin credential, which made the public repo the password.
- `ADMIN_SECRET` — **write/destructive** tier. Bearer token required for every non-GET action on `filters.js` and `categories.js` (adding/deleting filter words & categories, and the `job_posts` purge). Falls back to `CRON_SECRET` when unset. Sent as `Authorization: Bearer …` by `src/adminAuth.js` (`adminFetch`), which stores it in localStorage after a one-time prompt on the hidden admin pages.
- `LITTLE_ADMIN`, `LITTLE_ADMIN_2`, `LITTLE_ADMIN_3`, … — **read-only** tier: makes `jobs.js` return `hidden` rows (plus the `hidden` column itself) instead of filtering them out. The credential is the device's own `jobWatcherVisitorId` cookie (a UUID), matched against these env vars — nothing to set up per device; read the UUID with the "Eszköz-azonosító" button on `/allasfigyelo/filters` and paste it into an env var. `jobs.js` auto-discovers every env var matching `^LITTLE_ADMIN(_\d+)?$`, so **adding a device is an env change only — no code edit**; the `_\d+` suffix is mandatory, so a misspelled name grants nobody access instead of silently becoming a key. One UUID per device/person means any single one can be revoked without disturbing the others.
  - **Known, and now higher-stakes than it was:** four of the configured UUIDs used to be hardcoded in `ADMIN_VISITOR_IDS` (`src/JobWatcher.jsx` — removed 2026-08-25) and are still hardcoded in `bug-report.js`, `daily-visitor.js` and `visitor-click.js`, i.e. published in this repo and its git history. Anyone can read one and set it as their `jobWatcherVisitorId` cookie. Accepting that was a deliberate 2026-07-23 owner decision back when it only bought you *hidden rows* ("decluttered off my board", not "confidential"). **Since the 2026-08-25 page-wide gate below, the same cookie now buys the whole admin board** — job list, stats, filter/category lists — so the accepted blast radius grew. Writes are still safe (they need `ADMIN_SECRET`). Closing it is env-only and breaks no feature: rotate each admin/little-admin to a fresh UUID, update `ADMIN_*` / `LITTLE_ADMIN*`, and set the new UUID as each device's cookie. Note `jobs.js` folds admin-ness into its cache key and switches to `private, no-store`; keep that if you touch the caching, or an admin response will leak to ordinary visitors.

**`/allasfigyelo` is admin-only (2026-08-25).** Ordinary visitors get redirected to `https://pestidev.hu` — new-postings browsing lives there now; this site keeps only the admin side. Two halves, and both are needed:
- **Client:** `src/JobAccessGate.jsx` wraps all four `/allasfigyelo*` routes in `src/App.jsx`. It asks `job-access.js` (GET → `{access, tier}`, no data, `private, no-store`) and either renders the page or `window.location.replace`s to pestidev.hu. `JobWatcher` takes both admin flags from that gate's context (`useJobAccess()`) instead of the old source-committed UUID set and the old `jobs?limit=1` `hidden`-column sniff — both are gone.
- **Server:** `hasJobBoardAccess(event)` in `_admin_identity_core.js` (= either admin tier by cookie, **or** an `ADMIN_SECRET` bearer so repo scripts and curl still work) gates `jobs.js`, `job-stats.js`, `last-deploy.js`, `visitor-click.js`, and the previously-public GETs of `filters.js` and `categories.js`. The redirect is UX; this is the actual lock. `job-access.js` is the one endpoint an ordinary visitor may still call — it has to be, since only the server can match the cookie against the env vars — and it answers `200 {access:false}`, never 401, so the client can tell "you're a visitor" apart from "auth broke".

**Write/destructive tier — every job- and filter-touching endpoint (2026-08-28 audit).** A sweep of every routable function that touches `job_posts` / `job_filters` / `job_categories` / `job_daily_*` / `ai_extractors` / `ats_tenants` / `admin_applied_jobs` found two with **no authentication at all**, both live in production:
- `ai-extractors.js` — CRUD over the AI-scraper site registry, answering `200` to anonymous callers. A POST here adds an arbitrary `list_url` that `cron_jobs_AI-background.mjs` then fetches on our infrastructure and ingests into `AI - <site>`; a DELETE empties the registry. Now gated on **every** method with `AI_INGEST_TOKEN` (falling back to `CRON_SECRET`) — deliberately the AI family's own narrow token, the same one `ai-ingest` / `ai-registry` / `ai-deactivate` / `ats-tenants` use, **not** `ADMIN_SECRET`: the AI paths never hold the destructive key, and this endpoint belongs to that family. Nothing in the browser calls it — it is a curl-only admin API.
- `jobPipeline.js` — dead first-generation LinkedIn scraper, referenced nowhere, but anonymously callable and happy to fetch linkedin.com with caller-supplied `keyword`/`geo`/`pages`. Gated with `ADMIN_SECRET`; it should really just be deleted.

Also moved: `fix-job-field.mjs` from `CRON_SECRET` to `ADMIN_SECRET` (falling back, as elsewhere) — it is a manual `job_posts` write that deliberately bypasses the anti-clobber guard, so it belongs in the write tier, not on the key that drives the whole cron fleet.

Deliberately left alone: the routine-scoped tokens (`AI_INGEST_TOKEN` on `ai-ingest`/`ai-registry`/`ai-deactivate`/`ats-tenants`/`ai-mcp`, `AUDIT_TOKEN` on `audit-data`/`audit-report`) stay narrow — folding them into `ADMIN_SECRET` would put the destructive credential into a cloud routine's prompt. `daily-visitor.js` is site-wide visitor analytics, not a job endpoint, and stays public (note it is also referenced by nothing in `src/`). `netlify/functions/backfill_daily_stats.mjs` has no auth and runs `main()` at module load, but it is **gitignored and therefore never deployed** — harmless today, a landmine if it is ever committed; it belongs in `scripts/`, not in the functions directory.

Scrapers are unaffected: they read `job_categories`/`job_filters` straight from the DB via `load_categories.mjs` / `load_filters.mjs`, never over HTTP. `bug-report.js` stays public (the site-wide bug widget uses it). `scripts/audit_all_sources.mjs` and `scripts/check_false_deactivations.mjs` hit `jobs.js` anonymously and now need an `Authorization: Bearer $ADMIN_SECRET` header.
