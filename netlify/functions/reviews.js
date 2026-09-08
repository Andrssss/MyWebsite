// netlify/functions/reviews.js
//
// subject_reviews lives in the "subject-reviews" Netlify Blob now, not
// Postgres (2026-09-08) — see _subject_reviews_store.js for the concurrency-
// safe read-modify-write helpers this file is built on, and CLAUDE.md's
// "Where data lives" for why (not derived data, not low-concurrency, unlike
// the earlier job-stats/ats-state blob migrations).
const {
  toPublicRow,
  listReviews,
  getReviewById,
  createReview,
  updateReview,
  deleteReview,
  toggleLike,
} = require("./_subject_reviews_store.js");

function jsonResponse(statusCode, body) {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
    },
    body: JSON.stringify(body),
  };
}

exports.handler = async (event) => {
  try {
    const method = event.httpMethod;
    const path = event.path || "";
    // pl. "/.netlify/functions/reviews/123" vagy ".../reviews/123/like"
    const parts = path.split("/");
    const last = parts[parts.length - 1];
    const secondLast = parts[parts.length - 2];
    const isLikeRoute = last === "like" && /^\d+$/.test(secondLast || "");
    const id = isLikeRoute
      ? parseInt(secondLast, 10)
      : /^\d+$/.test(last || "")
      ? parseInt(last, 10)
      : null;

    const viewerId = event.queryStringParameters?.viewer_id || null;

    if (method === "OPTIONS") {
      return {
        statusCode: 204,
        headers: {},
        body: "",
      };
    }

    // ───────────────── POST /reviews/:id/like ─────────────────
    if (method === "POST" && isLikeRoute && id) {
      const MAX_BODY_BYTES = 2048;
      const rawBody = event.body || "";
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

      const limitRaw = event.queryStringParameters?.limit;
      const limit = /^\d+$/.test(limitRaw || "") ? parseInt(limitRaw, 10) : null;

      const rows = await listReviews({ limit });
      return jsonResponse(200, rows.map((r) => toPublicRow(r, viewerId)));
    }

    // ───────────────── POST ─────────────────
    if (method === "POST") {
      const body = JSON.parse(event.body || "{}");

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

      const toIntOrNull = (v, fieldName) => {
        if (v === undefined || v === null || v === "") return null;
        const n = parseInt(v, 10);
        if (Number.isNaN(n)) {
          throw new Error(`Invalid integer value for ${fieldName}: ${v}`);
        }
        return n;
      };

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
      const body = JSON.parse(event.body || "{}");
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

      return {
        statusCode: 204,
        headers: {
          "Content-Type": "application/json; charset=utf-8",
        },
        body: "",
      };
    }

    // Ha egyik sem
    return jsonResponse(405, { error: "Nem támogatott HTTP metódus." });
  } catch (err) {
    console.error("Function error:", err);
    return jsonResponse(500, { error: "Szerver hiba", details: err.message });
  }
};
