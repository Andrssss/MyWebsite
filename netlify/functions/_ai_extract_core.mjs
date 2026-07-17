// netlify/functions/_ai_extract_core.mjs
//
// The AI boundary for the `ai-scraped` pipeline. This module is the ONLY place
// that talks to the Anthropic API, and it never touches the DB — HTML in,
// validated job rows (or a reusable extraction recipe) out. See AI_SCRAPER_PLAN.md.
//
// Two modes, both live here so cron_jobs_AI-background.mjs can pick per site:
//   • llm-read   — send the (stripped) listing HTML to Claude, get jobs[] back.
//                  Robust to any markup, but costs tokens on every page.
//   • recipe     — Claude authors a small cheerio recipe ONCE (authorRecipe);
//                  runRecipe() then extracts deterministically with zero LLM
//                  calls until the recipe stops working.
//
// Every returned row is validated against the SOURCE html (validateJobs): a url
// the model invented but that isn't actually on the page is dropped — this is
// the main hallucination guard.

import Anthropic from "@anthropic-ai/sdk";
import { load as cheerioLoad } from "cheerio";

// Model is a single knob (see AI_SCRAPER_PLAN.md §8.1 for the cost tradeoff).
// Default per house policy; swap to "claude-haiku-4-5" to cut extraction cost.
export const MODEL = process.env.AI_SCRAPER_MODEL || "claude-opus-4-8";

// Cap on how much markup we send per page (~char budget → ~token budget). A
// stripped listing page is usually well under this; the cap just stops a
// pathological page from blowing the token bill.
const MAX_HTML_CHARS = 120_000;

// Lazily constructed so a missing key only breaks the AI worker, never import.
let _client = null;
function client() {
  if (!_client) {
    if (!process.env.ANTHROPIC_API_KEY) {
      throw new Error("ANTHROPIC_API_KEY is not set");
    }
    _client = new Anthropic();
  }
  return _client;
}

/* ── html reduction ─────────────────────────────────────────────── */

// Strip everything that carries no job signal (scripts, styles, svg, head, …)
// and collapse whitespace, so we spend tokens on cards + links, not on a
// bundled framework. Anchors (href) are preserved — they are the row identity.
export function stripHtml(html) {
  const $ = cheerioLoad(html);
  $("script, style, noscript, svg, head, link, meta, iframe, template, picture source").remove();
  $("*").contents().each(function () {
    if (this.type === "comment") $(this).remove();
  });
  const body = $("body").html() || $.root().html() || "";
  const collapsed = body.replace(/\s+/g, " ").trim();
  return collapsed.length > MAX_HTML_CHARS ? collapsed.slice(0, MAX_HTML_CHARS) : collapsed;
}

/* ── url helpers ─────────────────────────────────────────────────── */

const TRACKING_PARAMS = ["utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content", "fbclid", "gclid"];

export function normalizeUrl(raw, baseUrl) {
  try {
    const u = new URL(raw, baseUrl);
    u.hash = "";
    TRACKING_PARAMS.forEach((p) => u.searchParams.delete(p));
    return u.toString().replace(/\?$/, "");
  } catch {
    return null;
  }
}

/* ── LLM: extract jobs directly (Approach A / llm-read) ──────────── */

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
          title: { type: "string" },
          url: { type: "string" },
          company: { type: ["string", "null"] },
          location: { type: ["string", "null"] },
        },
      },
    },
  },
};

const EXTRACT_SYSTEM =
  "You extract job postings from a job board's listing HTML. Return every DISTINCT " +
  "job posting on the page. For each: `title` is the job title text; `url` is the link " +
  "to that posting's detail page and MUST be a link that literally appears as an href in " +
  "the provided HTML (absolute, or relative to the given base URL) — never invent, guess, " +
  "or complete a URL. Set `company` and `location` to the card's values or null if absent. " +
  "Ignore navigation, ads, category links, and 'similar jobs' widgets — only real postings.";

/**
 * llm-read: send stripped HTML, get a validated jobs[] back.
 * @returns {Promise<{jobs: Array, usage: object}>}
 */
export async function extractJobsLLM(rawHtml, { baseUrl }) {
  const stripped = stripHtml(rawHtml);
  const res = await client().messages.create({
    model: MODEL,
    max_tokens: 8000,
    output_config: { format: { type: "json_schema", schema: JOB_SCHEMA } },
    system: [{ type: "text", text: EXTRACT_SYSTEM, cache_control: { type: "ephemeral" } }],
    messages: [
      {
        role: "user",
        content:
          `Base URL: ${baseUrl}\n` +
          `Extract every distinct job posting from this listing HTML.\n\n<html>\n${stripped}\n</html>`,
      },
    ],
  });
  const raw = parseJson(res)?.jobs ?? [];
  return { jobs: validateJobs(raw, rawHtml, baseUrl), usage: usageOf(res) };
}

/* ── LLM: author a reusable recipe (Approach B / recipe) ─────────── */

const RECIPE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["card", "title", "url"],
  properties: {
    card: { type: "string" }, // CSS selector matching one element per posting
    title: { type: "string" }, // selector relative to a card (or "" = card's own text)
    url: { type: "string" }, // "a" | "a.foo" | "@href" | "a@href" — attr defaults to href
    company: { type: ["string", "null"] },
    location: { type: ["string", "null"] },
  },
};

const RECIPE_SYSTEM =
  "You are given a job board's listing HTML. Produce a REUSABLE cheerio/CSS extraction recipe " +
  "so the SAME selectors keep working across future loads of this listing. `card` is a CSS " +
  "selector matching exactly one element per job posting. `title`, `company`, `location` are " +
  "selectors RELATIVE to a card (empty string means the card's own text). `url` selects the " +
  "posting link; use `selector@attribute` form (default attribute is href), e.g. `a.title@href` " +
  "or `@href` if the card itself is the anchor. Prefer stable structural/class selectors over " +
  "nth-child. Only match real postings, not nav/ads/similar-jobs.";

/**
 * Ask Claude for a recipe from a sample page.
 * @returns {Promise<{recipe: object|null, usage: object}>}
 */
export async function authorRecipe(rawHtml, { baseUrl }) {
  const stripped = stripHtml(rawHtml);
  const res = await client().messages.create({
    model: MODEL,
    max_tokens: 2000,
    output_config: { format: { type: "json_schema", schema: RECIPE_SCHEMA } },
    system: [{ type: "text", text: RECIPE_SYSTEM, cache_control: { type: "ephemeral" } }],
    messages: [
      {
        role: "user",
        content: `Base URL: ${baseUrl}\nProduce the extraction recipe for this listing.\n\n<html>\n${stripped}\n</html>`,
      },
    ],
  });
  const recipe = parseJson(res);
  return { recipe: recipe && recipe.card ? recipe : null, usage: usageOf(res) };
}

/* ── deterministic recipe execution (no LLM) ─────────────────────── */

// "sel@attr" | "sel" | "@attr" | "" → { sel, attr }
function parseSpec(spec) {
  if (!spec) return { sel: "", attr: null };
  const at = spec.indexOf("@");
  if (at === -1) return { sel: spec.trim(), attr: null };
  return { sel: spec.slice(0, at).trim(), attr: spec.slice(at + 1).trim() || null };
}

function pick($, $card, spec) {
  const { sel, attr } = parseSpec(spec);
  const el = sel ? $card.find(sel).first() : $card;
  if (!el || el.length === 0) return null;
  const val = attr ? el.attr(attr) : el.text();
  const trimmed = (val || "").replace(/\s+/g, " ").trim();
  return trimmed || null;
}

/**
 * Run a stored recipe against a page — pure cheerio, zero LLM cost.
 * @returns {Array} validated job rows
 */
export function runRecipe(rawHtml, recipe, { baseUrl }) {
  if (!recipe || !recipe.card) return [];
  const $ = cheerioLoad(rawHtml);
  const urlSpec = recipe.url && recipe.url.includes("@") ? recipe.url : `${recipe.url || "a"}@href`;
  const out = [];
  $(recipe.card).each((_, el) => {
    const $card = $(el);
    const title = pick($, $card, recipe.title);
    const url = pick($, $card, urlSpec);
    if (!title || !url) return;
    out.push({
      title,
      url,
      company: recipe.company ? pick($, $card, recipe.company) : null,
      location: recipe.location ? pick($, $card, recipe.location) : null,
    });
  });
  return validateJobs(out, rawHtml, baseUrl);
}

/* ── validation (shared by both modes) ───────────────────────────── */

/**
 * Normalize + hallucination-guard the raw rows. A row survives only if its link
 * actually appears in the source HTML (by pathname or verbatim) — that is what
 * stops the model from inventing plausible-but-fake postings.
 */
export function validateJobs(rawJobs, sourceHtml, baseUrl) {
  const seen = new Set();
  const out = [];
  for (const j of rawJobs || []) {
    if (!j || typeof j.title !== "string" || typeof j.url !== "string") continue;
    const title = j.title.replace(/\s+/g, " ").trim();
    if (title.length < 3) continue;

    const url = normalizeUrl(j.url, baseUrl);
    if (!url) continue;

    // Must be present on the page: try the raw href, then the pathname (tolerates
    // our own normalization differing from the on-page relative href).
    let pathname;
    try {
      pathname = new URL(url).pathname;
    } catch {
      continue;
    }
    if (!sourceHtml.includes(j.url) && !sourceHtml.includes(pathname)) continue;

    if (seen.has(url)) continue;
    seen.add(url);

    out.push({
      title: title.slice(0, 300),
      url,
      company: cleanField(j.company),
      location: cleanField(j.location),
    });
  }
  return out;
}

function cleanField(v) {
  if (v == null) return null;
  const s = String(v).replace(/\s+/g, " ").trim();
  return s ? s.slice(0, 200) : null;
}

/* ── response helpers ────────────────────────────────────────────── */

function textOf(res) {
  return (res.content || [])
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("");
}

function parseJson(res) {
  try {
    return JSON.parse(textOf(res));
  } catch {
    return null;
  }
}

function usageOf(res) {
  const u = res.usage || {};
  return {
    input_tokens: u.input_tokens || 0,
    output_tokens: u.output_tokens || 0,
    cache_read_input_tokens: u.cache_read_input_tokens || 0,
    cache_creation_input_tokens: u.cache_creation_input_tokens || 0,
  };
}

// Per-1M USD rates for the cost line in the worker log. Keep in sync with MODEL.
const RATES = {
  "claude-opus-4-8": { in: 5, out: 25 },
  "claude-sonnet-5": { in: 3, out: 15 },
  "claude-haiku-4-5": { in: 1, out: 5 },
};

/** Rough USD cost of a usage object (cached input billed at ~0.1×). */
export function estimateCost(usage, model = MODEL) {
  const r = RATES[model] || RATES["claude-opus-4-8"];
  const inTok = (usage.input_tokens || 0) + (usage.cache_creation_input_tokens || 0);
  const cachedTok = usage.cache_read_input_tokens || 0;
  return (inTok * r.in + cachedTok * r.in * 0.1 + (usage.output_tokens || 0) * r.out) / 1_000_000;
}
