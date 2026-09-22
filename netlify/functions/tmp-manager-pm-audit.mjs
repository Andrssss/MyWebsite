// Disposable endpoint for GitHub issue #31 ("Menedzser / PM" category
// removal). GET = read-only audit (default). POST {"action":"execute"} =
// the actual one-time cleanup: deletes the job_categories row, removes the
// matching rows from every job-posts-archive blob, and does a full-history
// job-stats rebuild so dailyCategories/dailyLanguages/dailyTechnologies stop
// carrying the category. Deploy, invoke GET first to sanity-check, then POST
// execute, verify the response, then remove this file (repo convention —
// see CLAUDE.md "Deploy & one-off writes workflow").

import { getStore } from "@netlify/blobs";
import pkg from "pg";
const { Pool } = pkg;
import { categorize } from "../../src/lib/categorize.mjs";
import { rebuildStats } from "./_stats_rebuild_core.mjs";

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

async function runExecute(request) {
  const client = await pool.connect();
  try {
    const catRes = await client.query(
      `SELECT id, name, keywords FROM job_categories ORDER BY id`
    );
    const categoryRows = catRes.rows;
    const categories = categoryRows.map((r) => [r.name, r.keywords]);
    const targetRow = categoryRows.find((r) => r.name === TARGET);

    if (!targetRow) {
      return json(409, { error: `"${TARGET}" category not found — already deleted?` });
    }

    const postRes = await client.query(`SELECT id, title, active FROM job_posts`);
    const liveMatches = postRes.rows.filter(
      (row) => categorize(row.title || "", categories) === TARGET
    );

    await client.query(`DELETE FROM job_categories WHERE id = $1`, [targetRow.id]);

    const store = getStore(ARCHIVE_STORE);
    const { blobs } = await store.list();
    const archiveRemoved = [];
    for (const blob of blobs) {
      const payload = await store.get(blob.key, { type: "json" });
      const rows = payload?.rows || [];
      const kept = [];
      const removed = [];
      for (const row of rows) {
        if (categorize(row.title || "", categories) === TARGET) {
          removed.push({ title: row.title, source: row.source, url: row.url });
        } else {
          kept.push(row);
        }
      }
      if (removed.length === 0) continue;
      await store.set(
        blob.key,
        JSON.stringify({ ...payload, count: kept.length, rows: kept }, null, 2),
        { metadata: { type: "job-posts-archive", count: kept.length } }
      );
      archiveRemoved.push({ blob: blob.key, removed });
    }

    const catRes2 = await client.query(
      `SELECT name, keywords FROM job_categories ORDER BY id`
    );
    const categoriesAfter = catRes2.rows.map((r) => [r.name, r.keywords]);
    const rebuild = await rebuildStats(client, categoriesAfter, {});

    return json(200, {
      deletedCategory: { id: targetRow.id, name: targetRow.name, keywords: targetRow.keywords },
      liveMatchesFoundButNotDeleted: liveMatches.map((r) => ({
        id: r.id,
        title: r.title,
        active: r.active,
      })),
      archiveRowsRemoved: archiveRemoved,
      archiveRowsRemovedTotal: archiveRemoved.reduce((n, b) => n + b.removed.length, 0),
      rebuild,
    });
  } finally {
    client.release();
  }
}

export default async (request) => {
  if (!authorized(request)) return json(401, { error: "unauthorized" });

  if (request.method === "POST") {
    let body = {};
    try {
      body = await request.json();
    } catch {
      // no body / not JSON — fall through, action stays undefined
    }
    if (body?.action === "execute") {
      return runExecute(request);
    }
    return json(400, { error: "unknown POST action" });
  }

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
  const archiveMatchedTitles = [];
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
      archiveMatchedTitles.push({
        blob: blob.key,
        title: row.title,
        source: row.source,
        url: row.url,
        active: row.active,
        first_seen: row.first_seen,
      });
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
      matchedTitles: archiveMatchedTitles,
    },
  });
};
