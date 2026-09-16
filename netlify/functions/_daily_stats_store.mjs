// netlify/functions/_daily_stats_store.mjs
//
// job_daily_stats + job_daily_categories moved from Postgres to Netlify Blobs
// (2026-09-04, user decision). This data is a nightly-rebuildable derived
// snapshot — never queried relationally (no joins, no filters beyond a date
// range), written by exactly one daily cron plus the occasional manual
// rebuild, and read by this repo's own admin stats page and by pestidev.hu's
// public stats page (over cross-site blob access, not this file — see that
// project's own reader). A flat JSON blob is enough and drops the whole
// table off Postgres.
//
// Store: "job-stats", single key "latest.json" holding all four arrays
// (small: ~200+ days, one stats row and ~20-30 category rows each). Whole-blob
// read-modify-write is safe because there is never a concurrent writer.
//
// 2026-09-16 (user request): dailyLanguages/dailyTechnologies added, same
// shape and same writer/rebuild path as dailyCategories — job_posts.technologies
// (a comma list of extractTechnologies() canonical labels, see
// _tech_keywords.js) split into spoken-language vs. actual-technology rows by
// _stats_core.mjs's technologyBreakdown(), using the LANGUAGE_LABELS set.
// Unlike categories these are NOT split into an intern:-prefixed bucket —
// pestidev.hu only shows one aggregate pie each, no month/half-year/intern
// breakdown, so callers are expected to sum across the whole history rather
// than filter by date range.

import { getStore } from "@netlify/blobs";

const STORE_NAME = "job-stats";
const BLOB_KEY = "latest.json";

function store() {
  return getStore({ name: STORE_NAME, consistency: "strong" });
}

function sortByDate(rows) {
  return [...rows].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

export async function readDailyStats() {
  const raw = await store().get(BLOB_KEY, { type: "json" });
  if (!raw || !Array.isArray(raw.dailyStats) || !Array.isArray(raw.dailyCategories)) {
    return { generatedAt: null, dailyStats: [], dailyCategories: [], dailyLanguages: [], dailyTechnologies: [] };
  }
  // Older blobs written before 2026-09-16 won't have these two keys yet —
  // default to [] rather than treating that as an invalid/empty blob.
  return {
    ...raw,
    dailyLanguages: Array.isArray(raw.dailyLanguages) ? raw.dailyLanguages : [],
    dailyTechnologies: Array.isArray(raw.dailyTechnologies) ? raw.dailyTechnologies : [],
  };
}

export async function writeDailyStats({ dailyStats, dailyCategories, dailyLanguages = [], dailyTechnologies = [] }) {
  const payload = {
    generatedAt: new Date().toISOString(),
    dailyStats: sortByDate(dailyStats),
    dailyCategories: sortByDate(dailyCategories),
    dailyLanguages: sortByDate(dailyLanguages),
    dailyTechnologies: sortByDate(dailyTechnologies),
  };
  await store().setJSON(BLOB_KEY, payload);
  return payload;
}

// Replaces every row whose date falls in [from, to] with the freshly computed
// ones — mirrors the old DELETE-then-INSERT transaction, so re-running a
// rebuild for the same range is idempotent.
export async function replaceDays(newStats, newCategories, newLanguages, newTechnologies, { from, to } = {}) {
  const current = await readDailyStats();
  const inRange = (d) => (!from || d >= from) && (!to || d <= to);

  return writeDailyStats({
    dailyStats: [...current.dailyStats.filter((r) => !inRange(r.date)), ...newStats],
    dailyCategories: [...current.dailyCategories.filter((r) => !inRange(r.date)), ...newCategories],
    dailyLanguages: [...current.dailyLanguages.filter((r) => !inRange(r.date)), ...newLanguages],
    dailyTechnologies: [...current.dailyTechnologies.filter((r) => !inRange(r.date)), ...newTechnologies],
  });
}

// Adds today's rows only if that date isn't already present — mirrors the
// old `ON CONFLICT (date) DO NOTHING` daily upsert.
export async function appendDayIfMissing(
  day,
  { totalJobs, internJobs, categories, internCategories, languages = [], technologies = [] }
) {
  const current = await readDailyStats();
  if (current.dailyStats.some((r) => r.date === day)) {
    return { skipped: true };
  }

  const dailyStats = [...current.dailyStats, { date: day, total_jobs: totalJobs, intern_jobs: internJobs }];
  const newCatRows = [
    ...categories.map(({ category, count }) => ({ date: day, category, count })),
    ...internCategories.map(({ category, count }) => ({ date: day, category: `intern:${category}`, count })),
  ];
  const dailyCategories = [...current.dailyCategories, ...newCatRows];
  const newLangRows = languages.map(({ label, count }) => ({ date: day, language: label, count }));
  const dailyLanguages = [...current.dailyLanguages, ...newLangRows];
  const newTechRows = technologies.map(({ label, count }) => ({ date: day, technology: label, count }));
  const dailyTechnologies = [...current.dailyTechnologies, ...newTechRows];

  await writeDailyStats({ dailyStats, dailyCategories, dailyLanguages, dailyTechnologies });
  return { skipped: false };
}
