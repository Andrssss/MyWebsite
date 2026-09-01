# AI-scraped candidate sites (checklist)

Decision surface for the `ai-scraped` pipeline (design: `AI_SCRAPER_PLAN.md`). This is where we
decide which sites the AI pipeline visits. Fill / tick this, then approved sites get extracted.

**⚠️ Every finding the routine submits is a real production write, not a note-to-self.** A Claude Code
cloud routine (`AI-scraped job discovery`, `trig_01M97i1ZoBRxmnk6LvZYfbCa`, cron `0 */5 * * *`) runs
this checklist's rules automatically and POSTs its finds to `ai-registry.mjs`, which feeds them
through the same filter/upsert pipeline straight into the live `job_posts` table — real users see
them on `/allasfigyelo` within minutes, with no human review step in between. Apply the 5 filters
(career-page-only, IT title, not senior, not senior-by-years, not blocklisted company) with that
level of rigor, every time.

**Phase 2 = automated (current design, 2026-07-20).** The routine calls the API directly:
`GET /.netlify/functions/ai-registry` for its memory (it starts cold every run), then
`POST` for its finds. See `AI_SCRAPER_PLAN.md` §0. Note the earlier registry-file + git-push design
(§0.1) **never worked** — the push failed silently on every run and nothing ever reached the DB.

**Phase 1 = in-session (still available as a manual fallback):** Claude fetches an approved site
during a chat and extracts the jobs. Two ways to land them in the DB, both write to source
`AI - <slug>` (shown in the "AI-scraped" UI bucket):
- **HTTP path** — POST to `ai-ingest.mjs` (deployed; needs `AI_INGEST_TOKEN` or `CRON_SECRET`).
- **Manual SQL path** — run the INSERT below directly against the DB (Neon console / `psql`). No
  deploy, no secret. Useful for a one-off backfill outside the routine's own cycle.

⚠️ **This file is documentation, not the routine's source of truth.** The routine never reads the
repo's docs — it only knows what is in its own stored prompt. If you add or change a rule here,
update the routine's prompt to match (`RemoteTrigger` `update`, or the claude.ai routines UI), or the
two silently drift apart.

## Ready-to-run SQL for all current finds

**→ `AI_SCRAPED_FINDS.sql`** (repo root) has every find below as one runnable, idempotent INSERT
statement — that's the actual file to open and run, not this doc. This file just documents *why* each
one survived the filters.

## How to add a find — manual SQL template

Mirrors `_ai_ingest_core.mjs`'s own `upsertJob` exactly (same `ON CONFLICT` / `COALESCE` logic), so
running this by hand produces identical DB state to going through the code. Fill in the `<...>` spots:

```sql
INSERT INTO job_posts (source, title, url, experience, company, technologies, first_seen)
VALUES (
  'AI - <slug>',                 -- e.g. 'AI - argonsoft' — becomes the "AI-scraped" bucket entry
  '<exact title>',
  '<exact absolute detail-page url>',
  '<experience>',              -- 'diákmunka' | 'junior' | 'medior' | '-' if title-derived (isInternshipTitle/
                                -- isJuniorTitle/isMidLevelTitle match), OR a real "N év"/"N years" body-derived
                                -- phrase ONLY if title gave no signal AND N < 3 (the AI-pipeline senior-years
                                -- gate — see AI_SCRAPER_PLAN.md §8.3). Never insert a job whose real years ≥ 3
                                -- unless the title itself already earned a canonical label.
  '<company or NULL>',
  '<technologies or NULL>',    -- comma-joined, ONLY from the canonical TECH_KEYWORDS vocabulary in
                                -- _experience_core.mjs (e.g. "C#, Angular, .NET, PostgreSQL, Docker") —
                                -- don't invent labels outside that list.
  NOW()
)
ON CONFLICT (source, url) DO UPDATE SET
  experience = CASE
    WHEN (job_posts.experience IS NULL OR job_posts.experience IN ('-', ''))
     AND EXCLUDED.experience NOT IN ('-', '')
    THEN EXCLUDED.experience ELSE job_posts.experience END,
  technologies = COALESCE(job_posts.technologies, EXCLUDED.technologies),
  company = CASE
    WHEN job_posts.company IS NULL THEN EXCLUDED.company
    ELSE job_posts.company END;
```

Before filling this in, the job must already have passed the SAME gates `ingestJobs` applies (do this
by eye, in order): (1) IT-relevant title, (2) not on the senior/role blacklist, (3) not senior-by-years
(body doesn't state ≥3 years unless the title itself already resolved to a canonical label), (4) not an
already-blocklisted company for this source. `active`/`sweep_dead` are left unset — they default
correctly (`true`/`false`), same as a fresh scraper row.

## Rules for a candidate
- **CAREER PAGES ONLY — not job-board aggregators (user rule, 2026-07-16).** Target ONE company's (or
  ONE staffing/dev agency's) own listing of ITS OWN open positions — the same shape as our existing
  MBH/K&H/Raiffeisen/Erste/Capgemini/Wise/Trenkwalder/Talent scrapers. Do **not** target a multi-employer
  board that resyndicates ads FROM many unrelated companies (CVOnline, Jobline, Jooble, Indeed — all
  rejected below for this reason, even though technically "new sites").
- **NEW sites only** — never one we already scrape, and never the same company/site under a different
  domain (e.g. frissdiplomas.hu 301-redirects to workly.hu, already covered).
- **IT jobs only (user rule, 2026-07-16)** — the pipeline REJECTS any job whose title doesn't match the
  same `job_categories` IT keyword lists the rest of the site uses (see `_ai_ingest_core.mjs`
  `isItJob`). Verified live: correctly accepts "Junior React Developer"/"QA Tesztelő", correctly rejects
  "Áruházi munkatárs"/"Pultos"/"Raktári kisegítő" (retail/hospitality titles from student co-ops).
- Server-rendered: the jobs must be in the fetched HTML (no login, no heavy-JS SPA/ATS widget).

## Candidates — verified 2026-07-16

- [x] **bap.hu (Beck and Partners) — featured software-dev listing** —
  `https://bap.hu/friss-allasajanlatok/kiemelt-szoftverfejleszto-allasok` — ✅ site mechanically
  confirmed real/scrapable, but ❌ **0 of 4 postings survive filtering — nothing to ingest today.**
  Titles all IT, but: 2 hit the senior/role-title blacklist (Technical Analyst, Product Owner —
  user-confirmed 2026-07-16); the other 2 ("Java szoftverfejlesztő", "PHP backend fejlesztő") looked
  clean by title but their DETAIL PAGES demand **8+ years** and **5+ years** experience respectively —
  caught by a new years-based gate added to `_ai_ingest_core.mjs` (`isSeniorByYears`, threshold 3
  years, AI-pipeline-only). This site's current "featured" batch is entirely senior/non-junior; worth
  re-checking on a later day rather than treating the site itself as a dead end.
  Mechanically still valid: real absolute URLs (`bap.hu/allasajanlat/<id>/<slug>`), no login, single
  page. Keep `full_listing: false` if revisited (URL says "kiemelt"/featured, likely not the whole list).

- [ ] **capsys.hu (Capsys Informatikai Kft.) — own career page** —
  `https://www.capsys.hu/en/career` — ✅ real, clean, distinct per-posting URLs
  (`/en/career/<slug>`), no login — structurally the BEST-shaped candidate found so far. But ❌ **0/2
  survive**: "Lead Java Developer" title-blacklists (Lead); "DevOps Developer" states "2+ years" — under
  the 3-year numeric gate, but the actual scope (Kubernetes, OpenShift, Vault, Kafka+RabbitMQ+IBM MQ,
  HSM modules, 40+ named tools) reads as a senior infra role wearing a junior number. Deliberately
  excluded despite passing the numeric threshold — judgment call, flagged rather than silently included.
  **Structurally worth revisiting** if Capsys ever posts an actually-junior role.

- [ ] **novin.hu — career page** — `https://novin.hu/karrier/` — real "Junior Linux rendszergazda"
  posting found (min. 3-6 hónap — genuinely junior!), plus a "Java Backend fejlesztő" role mentioned
  only in an application-form dropdown. ❌ **Structurally rejected**: all roles share ONE page URL with
  no distinct per-posting anchor (`#jelentkezes` was identical for both roles I could see) — violates
  the url-is-row-identity model (`ON CONFLICT (source, url)` needs one real, distinct, navigable URL
  per posting; a shared URL would silently collide/overwrite between different jobs). Not fixable
  without a synthetic (non-navigable) URL, which we've deliberately avoided elsewhere (see
  [[canonical-url-linkedin-only]] / [[reconcile-url-identity-gotcha]] precedent: rejected exactly this
  kind of non-navigable synthetic id before). Skip unless the site adds real per-job pages.

- [x] **ArgonSoft Kft. — direct internship posting** —
  `https://www.argonsoft.hu/career/fejleszto-gyakornok-2/` — ✅ **CONFIRMED, extracted, SURVIVES ALL
  FILTERS.** ".NET/JAVA fejlesztő gyakornok" — real posting, no login, targets final-year/graduate
  BSc/MSc students explicitly (textbook `isInternshipTitle` match on "gyakornok" → title-based
  `"diákmunka"`, no body fallback even needed). No years requirement stated at all. Real tech list:
  .NET, C#, ASP.NET, Angular, Spring Boot, Hibernate, PostgreSQL, MSSQL, Oracle, Docker. Company:
  ArgonSoft itself (Hungarian model-driven-development software house, Budapest, Váci út).
  ⚠️ Found via search, not via a crawled listing page — `argonsoft.hu/career/` (guessed listing URL)
  404'd, so there's no confirmed way yet to discover OTHER postings on this site systematically.
  Treat as `full_listing: false` (can't claim this is the entire listing — it's one posting we found).
  **→ payload ready, see chat for the exact curl/PowerShell command.**

- [x] **HyperTeam Kft. — direct internship posting** —
  `https://www.hyperteam.hu/webalkalmazasfejlesztogyakornok` — ✅ **CONFIRMED, SURVIVES ALL FILTERS.**
  "Fullstack .NET fejlesztő gyakornok" — real posting, no login, explicit "ongoing university/college
  studies" requirement (no years stated) → title-based `isInternshipTitle` match → "diákmunka". Tech:
  C#, SQL, Angular, .NET (MAUI/SharePoint/Scrum/Agile/MS-certs mentioned but not in our canonical
  TECH_KEYWORDS vocab, excluded). Location: Budapest, District I, hybrid.
  Same career page (`hyperteam.hu/csatlakozzhozzank`) also listed **"Sales és Marketing gyakornok"**
  (not IT — skip) and **"Junior/Medior Business Analyst/Product Owner"** (contains "Product Owner" —
  same blacklist precedent as bap.hu, skip regardless of Junior/Medior prefix).
  **→ SQL ready, see chat.**

- [x] **Vadalarm — direct internship posting** —
  `https://www.vadalarm.hu/karrier/it-gyakornok` — ✅ **CONFIRMED, SURVIVES ALL FILTERS.**
  "Szoftverfejlesztő gyakornok" — real, active (live Google Form application link), explicitly
  states "nem is várunk el komoly szakmai felkészültséget, csak alapvető kódolási készségeket" (we
  don't expect serious professional background, just basic coding skills) — about as genuinely
  entry-level as it gets. Title-based `isInternshipTitle` match → "diákmunka". Tech (canonical
  TECH_KEYWORDS matches only — Atmel/Espressif/Arduino/MikroTik/VS Code aren't in that vocabulary):
  PHP, HTML, Angular, jQuery, Bootstrap, Docker, Android, iOS. Location: Budapest District XIII.
  Company: Vadalarm itself (small IoT/electronics company — wildlife-deterrent/alarm systems).
  **→ SQL ready, see chat.**

- **Clarity Consulting** (`karrier.clarity.hu/jobs/Fejleszt-gyakornok`) — real "Fejlesztő gyakornok"
  posting title exists, but the description body is JS-rendered (WebFetch only sees the page title,
  same failure pattern as evosoft/NNG/Stylers-Zoho). Can't verify content or extract reliably with
  current tooling. Revisit once the automated pipeline can render JS, or if the page changes.

**Batch 2 (2026-07-17, via 2 parallel research agents) — checked and rejected, one-line each:**
- AGROORG — field trainer/consultant role, not IT/dev.
- Videoton Holding, Rába Járműipari Holding (Győr) — only manufacturing/mechanical/QA/HR roles open.
- SEMILAB — JS-rendered ATS, no per-posting URLs in raw HTML.
- Aeriu — own career page is a bare JS redirect stub; real listing lives on excluded dreamjobs.hu.
- InnovITech — pure IT-consulting/outsourcing, wrong track for this search angle.
- F3 Drone — domain no longer resolves.
- WM Rendszerház's own "Tesztmérnök IoT & Smart Metering" — real but hardware-testing-first,
  programming only "advantageous", no honest seniority signal to classify — left out rather than guess.
- DSS Consulting — no active postings ("watch this space").
- Lanoga — only a Senior Java role listed.
- AgileXpert, TIGRA Informatika, RabIT (Szeged/Pécs), PEGACONSULT — all real junior/gyakornok roles
  exist, but every "apply" link funnels to ONE shared generic form/page with no distinct per-role
  detail URL — breaks the url-as-row-identity model, same failure as novin.hu earlier.
- Havasweb, Mortoff, NeoSoft (Székesfehérvár), TcT Group — dev roles explicitly require 3+ years.
- Stratis — open roles are IT-consultant/business-analyst titles (not dev/QA), deadlines expired anyway.
- ISYS-ON (Pécs), Dyntell (Debrecen) — ERP-consultant roles are business-facing, not dev/QA; the
  junior/gyakornok-titled postings found via secondary sources were no longer live on the actual site.
- Piper Kft — posting page 404s, no longer open.
- Adaptive Media — wrong vertical (digital ad sales, not IT consultancy).
- Processhunt — itself an IT recruitment/staffing agency, out of scope (same class as CVOnline/Jobline).

**Batch 3 (2026-07-17, startups/scale-ups agent) — checked and rejected, one-line each:**
- Shapr3D, Tresorit, Zocks, SEON Technologies, Turbine.ai, EV.analytica — JS-rendered / unfetchable
  description text (Tresorit's careers page now fully redirects to Swiss Post's ATS; EV.analytica's
  two job pages both rendered identical contradictory senior-level hydration artifacts — templating
  bug, not real content, correctly rejected rather than guessed at).
  RefinedScience — listed roles are "Remote," not Budapest.
- Prezi, Bitrise, Billingo — no junior dev openings at fetch time (Prezi: 2 non-junior; Bitrise:
  Sales-Ops-only; Billingo: Sales/Product-Owner/Scrum-Master only).
- Cheppers, Supercharge, Kodesage, Allonic — only mid/senior roles open (explicit "moved beyond early
  career", Tech Lead/Architect, 8+ years, or hardware-engineering 3-5+ years).
- Antavo, Axoflow, Qneiform, denxpert, ABZ Innovation, Redmenta, Ominimo, GitRabbit — no
  discoverable/reachable open junior dev listing.
- Silurus Software — domain now redirects elsewhere, academy/junior page dead (404).
- SolvencyAnalytics, INSPYRE Informatics — only a generic "spontaneous application" or an unqualified
  full-stack role demanding broad cloud/DB/API breadth (treated as mid-level per the
  seniority-by-tooling rule) currently open.
- Scaling Experts — a "Backend Programming Intern" is referenced by aggregators only; no reachable
  company-hosted posting URL to independently verify.
- Telemedi — the junior fullstack posting found is Polish-market, not Budapest.
- Emarsys — now a SAP subsidiary, no junior postings; Novo AI — Hanover, Germany, not Budapest.

**Batch 4 (2026-07-17, broad-sweep agent) — checked and rejected, one-line each:**
- E.ON, Groupama (×2), ROSSMANN, Attrecto (.NET/React/tester roles), Bosch, Continental, Schaeffler —
  the specific junior/gyakornok posting found was filled/expired/404 by the time of verification.
- Knorr-Bremse, Generali/UNIQA (karrierportal.hu), Dorsum, Ozeki, BlackBelt Technology — unreachable
  (DNS/connection blocked, 403 Forbidden, or client-side-routed SPA 404s on direct deep-link fetch).
- CIG Pannónia, Zenit.hu, Stratis (Power BI), RÉGENS "AI Architect" — explicitly require 1-3+/2+/4+
  years, mid/senior.
- CIB Bank — only an HR "Recruitment gyakornok" open, no IT.
- RÉGENS "Logisztikai alkalmazástámogató gyakornok" — helpdesk/app-support title, not clearly
  dev/QA/DevOps/sysadmin.
- Schaeffler's "IT gyakornok" — title is tooling/manufacturing support, not IT-software.
- Abesse Zrt — repeated nav-shell-only fetches, likely JS-rendered detail pages.
- Sun City Software, TIGRA Informatika, Trendency, Netrisk.hu, Horváth & Partners, SURVIOT, BIZQIT —
  no matching live junior/gyakornok IT posting found on their own domain.

- [x] **Turbo Tech Hungary Kft. — direct internship-friendly posting** —
  `https://ttech.hu/turbo-tech-karrier-allas-ajanlat/beagyazott-szoftver-es-vagy-hardverfejleszto/` —
  ✅ **SURVIVES ALL FILTERS.** "Beágyazott szoftver- és/vagy hardverfejlesztő" — industrial engineering
  firm (power distribution/automation/solar), in-house embedded dev unit. Body explicitly says "akár
  gyakornokként is" (also open to interns) + prioritizes university students, no years stated →
  body-derived "diákmunka". Tech (canonical matches only — STM32/FreeRTOS/Bluetooth/WiFi/LoRa/Zigbee
  aren't in our vocabulary): Java, C++, C#, .NET, Azure. Location: Budapest District IV.

- [x] **WM Rendszerház Kft. (m2mserver.com) — direct posting** —
  `https://m2mserver.com/back-end-fejleszto/` — ✅ **SURVIVES ALL FILTERS** (after the range fix below).
  "Back End Fejlesztő" — industrial IoT hardware maker (smart-grid modems/routers/loggers). States
  "1-3 év szakmai tapasztalat" — a RANGE, lower bound 1 year, genuinely junior-friendly, NOT the same
  as an unambiguous floor. This posting is what exposed the years-gate range bug (see
  `AI_SCRAPER_PLAN.md` §8.3) — fixed same-session. Tech: Python, SQL, Bash, AWS, Azure, CI/CD, Git,
  REST API (PowerShell/GitLab/Delphi/OpenAPI/GitHub-Copilot not in our canonical vocab; "Go" excluded
  since the real extractor only matches literal "golang", not bare "Go"). Location: Budapest.

- [x] **Flexinform Kft. — direct posting** — `https://www.flexinform.hu/karrier/junior-php-fejleszto`
  — ✅ **SURVIVES ALL FILTERS.** "Junior PHP fejlesztő" — small (~20 employee) Miskolc/Debrecen IT
  house, title-based junior match. Tech: PHP, SQL, Docker, Git.

- [x] **Nova Services — 2 direct postings** — `novaservices.hu/careers/junior-java-developer` and
  `.../junior-liferay-developer` — ✅ **BOTH SURVIVE ALL FILTERS.** Independent Hungarian IT consulting
  house (~300 employees — above the "sweet spot" size but not a bank/multinational/staffing
  agency/coop, so still in scope). "Junior Java Developer" (tech: Java, Angular, jQuery — JEE not in
  our canonical vocab) and "Junior Liferay Developer" (tech: Angular, jQuery — Liferay/JEE/AlloyUI not
  in our canonical vocab, unfortunate since Liferay is literally the job's core tech, but staying
  faithful to the existing vocabulary rather than inventing new keywords).

- [x] **KFS GROUP — via join.com** —
  `https://join.com/companies/kfs1/16347911-junior-full-stack-developer-typescript-react-supabase-postgres`
  — ✅ **SURVIVES ALL FILTERS.** "Junior Full-Stack Developer (TypeScript/React · Supabase/Postgres)" —
  small (1-10 employee) Budapest team. No years stated, explicitly targets juniors/recent grads.
  join.com is a third-party ATS where each company gets its own dedicated listing page — same category
  as Greenhouse/Lever (one company's own posting, NOT a multi-employer browse/search aggregator like
  CVOnline/Jobline), so it fits the career-pages-only rule. Verified server-rendered (description text
  directly quote-fetched, not just a list-page snippet — this agent correctly caught and rejected
  several genuinely JS-only pages elsewhere, e.g. EV.analytica's contradictory hydration artifacts, so
  its verification here is trustworthy). Tech: JavaScript, TypeScript, Python, SQL, React, Next.js,
  Vite, Tailwind, PostgreSQL, Git (Supabase isn't in our canonical TECH_KEYWORDS vocabulary — the
  job's actual core backend platform, unfortunately not trackable without extending that list).
  🔑 **join.com is a reusable pattern** — worth searching more small Budapest companies on it, same as
  the Greenhouse/Lever lead.

- [x] **BI Consulting Kft. — direct internship posting** —
  `https://biconsulting.hu/karrier/gyakornoki-program/dataviz-gyakornok/` — ✅ **SURVIVES ALL
  FILTERS.** "Adatvizualizációs gyakornok" (Data Visualization Intern) — Budapest BI/analytics
  consultancy, own domain/own career section. Title-based `isInternshipTitle` match ("gyakornok") →
  "diákmunka". Requires active full-time student status (min. 2 remaining semesters), no
  professional-years bar. Tech: SQL, Power BI (Tableau mentioned but not in our canonical
  TECH_KEYWORDS vocab, excluded).

- **TCS Hungary internship program** (`hungarycareer.tcsapps.com/internship-programs/`) — real internship
  titles (Backend/Data Engineer/DevOps Engineer/QA/GenAI Intern) but every listed URL points to
  `linkedin.com/jobs/view/...` — these ARE LinkedIn postings, just discovered via TCS's referral page.
  Same source as our already-covered `LinkedIn`. Skip — not a new site.
- **4iG** (`4ig.hu/gyakornok-program`) — guessed URL 404'd, not investigated further this round.
- **Stylers Group** (`join.stylersgroup.hu`) — real internship program exists ("Junior Programozó
  képzés + gyakornoki program"), but actual postings live on an external `stylers.zohorecruit.eu` Zoho
  Recruit ATS board that WebFetch could not reliably extract (repeatedly truncated regardless of
  prompt) — same large-payload limitation as Diligent/Greenhouse. Revisit once the automated pipeline
  can fetch it server-side.
- **WHC** (`whc.hu/student-offers`) — real, but confirmed general diákmunka staffing board (retail:
  "Raktári kisegítő", "Dohánybolti eladó"), same wrong-vertical pattern as Fürge Diák/Nebuló-Meló/etc.
  The one IT-sounding posting found via search (`szoftverfejleszto-gyakornok-217076`) had already
  expired (404). Skip unless a live IT posting turns up.

- [ ] **Diligent Corporation (Budapest office) — via Greenhouse board** —
  `https://job-boards.greenhouse.io/diligentcorporation` — ✅ real, plain server-rendered HTML
  (confirmed: GitLab's Greenhouse board renders full title/dept/location lists with no JS). Global
  board, ~120 openings, needs pagination (only first 43 fetched so far) + a post-filter for
  `location contains "Budapest, Hungary"`. First-page Budapest hits were UX/design roles (likely fail
  the IT-title gate); earlier research showed Budapest .NET/React/SWE openings exist but weren't on
  the fetched page — needs a full-list fetch to confirm current IT openings. **Not yet extracted.**
  🔑 **Reusable pattern:** ANY Budapest-office company on Greenhouse (`job-boards.greenhouse.io/<company>`
  or `boards.greenhouse.io/<company>`) can likely use the same recipe once we build one — worth
  actively searching for more Budapest-office companies on Greenhouse/Lever as a scalable source of
  candidates, rather than guessing custom-domain career pages one by one (most of those turned out to
  be JS-heavy enterprise ATS — see rejected list).

- [x] **Újbuda Prizma Állásközvetítés – Informatika, telekommunikáció kategória** –
  `https://ujbudaiallasok.hu/job-category/informatika-telekommunikacio/` - use the category/listing page
  as the recurring source, not the concrete `programfejleszto-munkatars-xi-ker` detail URL. Keep
  `full_listing: false`: this is a category window and the shared 404 sweep remains responsible for
  deactivating dead postings.

## Approved / live
| slug | listing URL | full_listing | cadence | status | notes |
|------|-------------|:------------:|:-------:|--------|-------|
| argonsoft | https://www.argonsoft.hu/career/fejleszto-gyakornok-2/ | no | 5h | extracted | 1 job pulled 2026-07-16, survives all filters; SQL INSERT handed to user (manual path, not via ai-ingest) — confirm once run |
| hyperteam | https://www.hyperteam.hu/webalkalmazasfejlesztogyakornok | no | 5h | extracted | 1 job pulled 2026-07-16, survives all filters; SQL INSERT handed to user — confirm once run |
| vadalarm | https://www.vadalarm.hu/karrier/it-gyakornok | no | 5h | extracted | 1 job pulled 2026-07-16, survives all filters; SQL INSERT handed to user — confirm once run |
| turbotech | https://ttech.hu/turbo-tech-karrier-allas-ajanlat/beagyazott-szoftver-es-vagy-hardverfejleszto/ | no | 5h | extracted | 1 job pulled 2026-07-17, survives all filters; SQL handed to user |
| m2mserver | https://m2mserver.com/back-end-fejleszto/ | no | 5h | extracted | 1 job pulled 2026-07-17 (WM Rendszerház), exposed+fixed years-range gate bug; SQL handed to user |
| flexinform | https://www.flexinform.hu/karrier/junior-php-fejleszto | no | 5h | extracted | 1 job pulled 2026-07-17, survives all filters; SQL handed to user |
| novaservices | https://www.novaservices.hu/careers/junior-java-developer + /junior-liferay-developer | no | 5h | extracted | 2 jobs pulled 2026-07-17, survive all filters; SQL handed to user |
| kfs1 (join.com) | https://join.com/companies/kfs1/16347911-junior-full-stack-developer-typescript-react-supabase-postgres | no | 5h | extracted | 1 job pulled 2026-07-17 (KFS GROUP), survives all filters; SQL handed to user |
| biconsulting | https://biconsulting.hu/karrier/gyakornoki-program/dataviz-gyakornok/ | no | 5h | extracted | 1 job pulled 2026-07-17, survives all filters; SQL handed to user |
| bap  | https://bap.hu/friss-allasajanlatok/kiemelt-szoftverfejleszto-allasok | no | 5h | candidate | 2026-07-16 batch: 0/4 survived (2 role-blacklisted, 2 senior-by-years). Nothing sent. Recheck later. |
| ujbudaiallasok | https://ujbudaiallasok.hu/job-category/informatika-telekommunikacio/ | no | 5h | candidate | Category/listing source added 2026-08-31; do not use the concrete Programfejleszto detail URL as the source. |
| capsys | https://www.capsys.hu/en/career | no | 5h | candidate | 2026-07-16 batch: 0/2 survived (1 title-blacklisted "Lead", 1 borderline-senior excluded by judgment). Structurally good site, recheck later. |

- **slug** → DB source `AI - <slug>`.
- **full_listing** = `yes` only if the whole current listing fits in one fetched page (then vanished
  jobs can be auto-deactivated). Default `no` = we only reactivate; the 404-sweep removes dead jobs.
- **cadence** = intended once automated (default every 5h).
- **status** = `candidate` → `extracted` (I've pulled jobs at least once) → `live` (POSTed successfully).

---

## Checked and rejected

**Job-board aggregators (wrong shape per the career-pages-only rule, even though technically new sites):**
- **CVOnline.hu** — dedicated IT/Telecom category (`/en/jobs/it-telecommunications`), confirmed real,
  paginated, ~309 postings — but it's a multi-employer aggregator (sample included a Trenkwalder ad,
  a company we already scrape directly). Rejected under the career-pages-only rule.
- **Jobline.hu** — same shape/reasoning as CVOnline, not independently verified further.
- **Jooble.org / Indeed.hu** — meta-aggregators that themselves re-index profession.hu, muisz, etc.
  Worse overlap risk, heavy bot-detection. Rejected.

**Student cooperatives (wrong vertical — mostly non-IT gig work, confirmed by live IT-gate test):**
- Fürge Diák (furgediak.hu), Nebuló-Meló (nebulomelo.hu), Multi Job (multijob.hu/multijobisz.hu),
  Job Force (job-force.hu) — real, server-rendered, but sample postings ("Áruházi munkatárs", "Pultos",
  "Raktári kisegítő", "Éttermi szervizes") all confirmed REJECTED by the IT gate.
- Metior (metior.hu) — postings gated behind a registration form, nothing public to fetch.
- Prodiák (prodiak.hu) — not independently verified, likely same retail-heavy mix as siblings.
- frissdiplomas.hu — 301-redirects to workly.hu. Already covered (`workly`).

**JS-heavy career pages (out of scope — no headless browser layer yet):**
- **evosoft.hu/open-positions** — no titles in HTML; redirects applicants to an external Siemens ATS.
- **hiflylabs.com/karrier** — 404 / no confirmed listing.
- **careers.nng.com** (NNG) — confirmed JS-rendered via a hr-felho.hu ATS widget; only 1 title loaded
  in static HTML.
- General pattern observed: individual enterprise career pages skew heavily toward JS ATS widgets
  (Workday, hr-felho.hu, etc.) — this is the main obstacle to the career-pages-only rule. **Greenhouse
  and Lever are the exception** (confirmed plain HTML) — prioritize searching for Budapest-office
  companies on those platforms over guessing custom-domain career pages.

**Explicitly excluded for other reasons:**
- **Deutsche Telekom IT Solutions** career site — real, IT-relevant, but this company is already
  deliberately company-blocklisted on talent/alllocaljobs/LinkedIn (`_company_blocklist.mjs`).
  Scraping their own site would reintroduce exactly what was blocked elsewhere. Skip.
- **bluebird.hu** — same domain as the already-covered `bluebird` source. Skip.
- Anything on profession.hu / zyntern.com / schonherz.hu / muisz.hu / miszisz.hu / ydiak.hu /
  minddiak.hu / qdiak.hu / tudatosdiak (app.tudatosdiak.hu) / eudiakok.hu / melodiak.hu /
  atlaszmunkak.hu / dreamjobs.hu / nofluffjobs.com — already-covered domains regardless of page.

---

## Already covered — do NOT add these (we already scrape them)
Source keys currently in `netlify/functions/jobs.js` (`FIXED`). A candidate must not be one of these:

karrierhungaria · minddiak · muisz · zyntern · profession(-intern) · schonherz · tudasdiak · otp ·
vizmuvek · LinkedIn · wherewework · onejob · miszisz · nofluffjobs · dreamjobs · melonjobs · kuka ·
talent · bluebird · ydiak · qdiak · alllocaljobs · allasportal · mbh · kh · raiffeisen · erste · mfb ·
unicredit · cg-jobstream (Capgemini) · wise · roland · eudiakok · melodiak · atlasz · pannondiak ·
valorebasis · trenkwalder · workcenter · workly · random_email
