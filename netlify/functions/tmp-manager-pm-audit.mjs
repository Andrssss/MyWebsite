// Disposable read-only diagnostic for GitHub issue #31 ("Menedzser / PM"
// category removal). Reports, WITHOUT WRITING ANYTHING:
//   - the category's current keywords + DB id
//   - how many live job_posts rows (active/inactive) currently classify to it
//   - what they'd reclassify to if the category row were simply deleted
//   - the same two numbers across every job-posts-archive blob
// Deploy, invoke, read the result, then remove this file (repo convention —
// see CLAUDE.md "Deploy & one-off writes workflow").

import { getStore } from "@netlify/blobs";
import pkg from "pg";
const { Pool } = pkg;
import { categorize } from "../../src/lib/categorize.mjs";

const connectionString = process.env.NETLIFY_DATABASE_URL;
if (!connectionString) throw new Error("NETLIFY_DATABASE_URL is not set");
const pool = new Pool({ connectionString, ssl: { rejectUnauthorized: false } });

const TOKEN = "29f878ba0ab38c25b4882dd0f9d2849854530c7153101560";
const TARGET = "Menedzser / PM";
const ARCHIVE_STORE = "job-posts-archive";

function authorized(request) {
  const auth = request.headers.get("authorization") || "";
  return auth.replace(/^Bearer\s+/i, "").trim() === TOKEN;
}

function json(status, body) {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

export default async (request) => {
  if (!authorized(request)) return json(401, { error: "unauthorized" });

  const client = await pool.connect();
  let categoryRows, liveRows;
  try {
    const catRes = await client.query(
      `SELECT id, name, keywords FROM job_categories ORDER BY id`
    );
    categoryRows = catRes.rows;
    const postRes = await client.query(
      `SELECT title, source, url, active FROM job_posts`
    );
    liveRows = postRes.rows;
  } finally {
    client.release();
  }

  const categories = categoryRows.map((r) => [r.name, r.keywords]);
  const categoriesWithoutTarget = categories.filter(([name]) => name !== TARGET);
  const targetRow = categoryRows.find((r) => r.name === TARGET) || null;

  const liveMatches = liveRows.filter(
    (row) => categorize(row.title || "", categories) === TARGET
  );
  const reclassifyPreview = {};
  for (const row of liveMatches) {
    const cat = categorize(row.title || "", categoriesWithoutTarget);
    reclassifyPreview[cat] = (reclassifyPreview[cat] || 0) + 1;
  }

  const store = getStore(ARCHIVE_STORE);
  const { blobs } = await store.list();
  let archiveTotal = 0;
  let archiveMatchCount = 0;
  const archiveByBlob = [];
  const archiveReclassifyPreview = {};
  for (const blob of blobs) {
    const payload = await store.get(blob.key, { type: "json" });
    const rows = payload?.rows || [];
    archiveTotal += rows.length;
    let matchCount = 0;
    for (const row of rows) {
      if (categorize(row.title || "", categories) !== TARGET) continue;
      matchCount++;
      const reCat = categorize(row.title || "", categoriesWithoutTarget);
      archiveReclassifyPreview[reCat] = (archiveReclassifyPreview[reCat] || 0) + 1;
    }
    archiveMatchCount += matchCount;
    archiveByBlob.push({ key: blob.key, count: rows.length, matches: matchCount });
  }

  return json(200, {
    category: targetRow,
    live: {
      totalRows: liveRows.length,
      matches: liveMatches.length,
      active: liveMatches.filter((r) => r.active).length,
      inactive: liveMatches.filter((r) => !r.active).length,
      reclassifyPreview,
      sampleTitles: liveMatches
        .slice(0, 30)
        .map((r) => ({ title: r.title, source: r.source, active: r.active, url: r.url })),
    },
    archive: {
      totalRows: archiveTotal,
      matches: archiveMatchCount,
      reclassifyPreview: archiveReclassifyPreview,
      byBlob: archiveByBlob,
    },
  });
};
