// netlify/functions/reviews.mjs
//
// subject_reviews lives in the "subject-reviews" Netlify Blob now, not
// Postgres (2026-09-08) — see _subject_reviews_store.mjs for the concurrency-
// safe read-modify-write helpers this file is built on, and CLAUDE.md's
// "Where data lives" for why (not derived data, not low-concurrency, unlike
// the earlier job-stats/ats-state blob migrations).
//
// Rewritten from a CommonJS `exports.handler` (.js) function to this ESM
// `export default` (.mjs, Functions API v2) shape 2026-09-08: v1-style
// `exports.handler` functions on this site do NOT get Netlify's automatic
// Blobs context injected (confirmed live — job-stats.js/job-events.js, two
// pre-existing v1 functions never touched in this change, fail with the
// exact same MissingBlobsEnvironmentError right now). Every already-working
// blob-using function in this repo (_daily_stats_store.mjs/_ats_state.mjs
// callers, ats-tenants.mjs, etc.) is a v2 `.mjs` function — this is that
// same shape, not a stylistic choice. See CLAUDE.md for the fuller note; if
// you add another Blob-backed HTTP endpoint, it MUST be a v2 (.mjs,
// `export default`) function or it will silently 500 on every request.
import {
  toPublicRow,
  listReviews,
  getReviewById,
  createReview,
  updateReview,
  deleteReview,
  toggleLike,
} from "./_subject_reviews_store.mjs";

function jsonResponse(statusCode, body) {
  return new Response(JSON.stringify(body), {
    status: statusCode,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

const INTEGER_FIELDS = new Set(["difficulty", "usefulness", "year", "semester"]);

// Postgres' INTEGER columns used to coerce a string like "7" (what an HTML
// form input always sends) on write — now that there's no DB doing that for
// us, both POST and PUT need to do it themselves or numeric fields end up
// stored as strings depending on which route last touched them.
function toIntOrNull(v, fieldName) {
  if (v === undefined || v === null || v === "") return null;
  const n = parseInt(v, 10);
  if (Number.isNaN(n)) {
    throw new Error(`Invalid integer value for ${fieldName}: ${v}`);
  }
  return n;
}

export default async (request) => {
  try {
    const method = request.method;
    const url = new URL(request.url);
    // pl. "/.netlify/functions/reviews/123" vagy ".../reviews/123/like"
    const parts = url.pathname.split("/");
    const last = parts[parts.length - 1];
    const secondLast = parts[parts.length - 2];
    const isLikeRoute = last === "like" && /^\d+$/.test(secondLast || "");
    const id = isLikeRoute
      ? parseInt(secondLast, 10)
      : /^\d+$/.test(last || "")
      ? parseInt(last, 10)
      : null;

    const viewerId = url.searchParams.get("viewer_id") || null;

    if (method === "OPTIONS") {
      return new Response(null, { status: 204 });
    }

    // ───────────────── POST /reviews/:id/like ─────────────────
    if (method === "POST" && isLikeRoute && id) {
      const MAX_BODY_BYTES = 2048;
      const rawBody = await request.text();
      if (Buffer.byteLength(rawBody, "utf8") > MAX_BODY_BYTES) {
        return jsonResponse(413, { error: "Payload too large" });
      }

      let body;
      try {
        body = JSON.parse(rawBody || "{}");
      } catch {
        return jsonResponse(400, { error: "Invalid JSON body" });
      }

      const userId = typeof body.user_id === "string" ? body.user_id.trim() : "";
      if (!userId || userId.length > 128) {
        return jsonResponse(400, { error: "user_id kötelező mező." });
      }

      const result = await toggleLike(id, userId);
      if (!result) {
        return jsonResponse(404, { error: "Nem található ilyen vélemény." });
      }
      return jsonResponse(200, result);
    }

    // ───────────────── GET ─────────────────
    if (method === "GET") {
      if (id) {
        const review = await getReviewById(id);
        if (!review) {
          return jsonResponse(404, { error: "Nem található ilyen vélemény." });
        }
        return jsonResponse(200, toPublicRow(review, viewerId));
      }

      const limitRaw = url.searchParams.get("limit");
      const limit = /^\d+$/.test(limitRaw || "") ? parseInt(limitRaw, 10) : null;

      const rows = await listReviews({ limit });
      return jsonResponse(200, rows.map((r) => toPublicRow(r, viewerId)));
    }

    // ───────────────── POST ─────────────────
    if (method === "POST") {
      const body = JSON.parse((await request.text()) || "{}");

      const {
        name,
        user: rawUser = "",
        general = null,
        duringSemester = null,
        exam = null,
        user_id,
        kepzes_fajtaja = "MI",
      } = body;

      const user = (typeof rawUser === "string" ? rawUser.trim() : "") || "anonim";

      // Speciális: "Általános információ" tárgyra ne lehessen POST-olni
      if (name && name.trim() === "Általános információ") {
        return jsonResponse(400, {
          error: "Ehhez a tárgyhoz nem lehet új véleményt hozzáadni.",
        });
      }

      const difficulty = toIntOrNull(body.difficulty, "difficulty");
      const usefulness = toIntOrNull(body.usefulness, "usefulness");
      const year = toIntOrNull(body.year, "year");
      const semester = toIntOrNull(body.semester, "semester");

      if (!name || !user_id) {
        return jsonResponse(400, {
          error: "name és user_id kötelező mezők.",
        });
      }

      const created = await createReview({
        name,
        user,
        difficulty,
        usefulness,
        general,
        duringSemester,
        exam,
        year,
        semester,
        user_id,
        kepzes_fajtaja,
      });

      return jsonResponse(201, toPublicRow(created, viewerId));
    }

    // ───────────────── PUT ─────────────────
    if (method === "PUT" && id) {
      const body = JSON.parse((await request.text()) || "{}");
      const patch = {};

      const editableKeys = [
        "name",
        "user",
        "difficulty",
        "usefulness",
        "general",
        "duringSemester",
        "exam",
        "year",
        "semester",
        "user_id",
        "kepzes_fajtaja",
      ];

      for (const key of editableKeys) {
        if (body[key] !== undefined && body[key] !== "N/A") {
          patch[key] =
            key === "user"
              ? (typeof body[key] === "string" ? body[key].trim() : "") || "anonim"
              : INTEGER_FIELDS.has(key)
              ? toIntOrNull(body[key], key)
              : body[key];
        }
      }

      if (Object.keys(patch).length === 0) {
        return jsonResponse(400, {
          error: "Nincs frissítendő mező.",
        });
      }

      const updated = await updateReview(id, patch);
      if (!updated) {
        return jsonResponse(404, { error: "Nem található ilyen vélemény." });
      }
      return jsonResponse(200, toPublicRow(updated, viewerId));
    }

    // ───────────────── DELETE ─────────────────
    if (method === "DELETE" && id) {
      const deleted = await deleteReview(id);
      if (!deleted) {
        return jsonResponse(404, {
          error: "Nincs ilyen vélemény (id nem található).",
        });
      }
      return new Response(null, { status: 204 });
    }

    // Ha egyik sem
    return jsonResponse(405, { error: "Nem támogatott HTTP metódus." });
  } catch (err) {
    console.error("Function error:", err);
    return jsonResponse(500, { error: "Szerver hiba", details: err.message });
  }
};
