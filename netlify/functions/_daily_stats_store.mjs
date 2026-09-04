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
// Store: "job-stats", single key "latest.json" holding BOTH arrays (small:
// ~200+ days, one stats row and ~20-30 category rows each). Whole-blob
// read-modify-write is safe because there is never a concurrent writer.

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
    return { generatedAt: null, dailyStats: [], dailyCategories: [] };
  }
  return raw;
}

export async function writeDailyStats({ dailyStats, dailyCategories }) {
  const payload = {
    generatedAt: new Date().toISOString(),
    dailyStats: sortByDate(dailyStats),
    dailyCategories: sortByDate(dailyCategories),
  };
  await store().setJSON(BLOB_KEY, payload);
  return payload;
}

// Replaces every row whose date falls in [from, to] with the freshly computed
// ones — mirrors the old DELETE-then-INSERT transaction, so re-running a
// rebuild for the same range is idempotent.
export async function replaceDays(newStats, newCategories, { from, to } = {}) {
  const current = await readDailyStats();
  const inRange = (d) => (!from || d >= from) && (!to || d <= to);

  return writeDailyStats({
    dailyStats: [...current.dailyStats.filter((r) => !inRange(r.date)), ...newStats],
    dailyCategories: [...current.dailyCategories.filter((r) => !inRange(r.date)), ...newCategories],
  });
}

// Adds today's rows only if that date isn't already present — mirrors the
// old `ON CONFLICT (date) DO NOTHING` daily upsert.
export async function appendDayIfMissing(day, { totalJobs, internJobs, categories, internCategories }) {
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

  await writeDailyStats({ dailyStats, dailyCategories });
  return { skipped: false };
}
