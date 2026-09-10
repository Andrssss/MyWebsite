// netlify/functions/download-count.mjs
//
// Public download counter for subject file folders — see
// _download_count_store.mjs for the Blob/concurrency details. v2 (.mjs,
// `export default`) on purpose: v1 `exports.handler` functions on this site
// do NOT get Netlify's automatic Blobs context (see CLAUDE.md's Functions
// v1/v2 gotcha) — every Blob-backed HTTP endpoint in this repo is v2.
//
// GET  -> { counts: { [folderId]: number } }  (whole map, one request covers
//          every subject/subfolder so the frontend doesn't fetch per-folder)
// POST { folderId } -> { folderId, count }    (increments and returns the new count)
import { getCounts, incrementCount } from "./_download_count_store.mjs";

function jsonResponse(statusCode, body) {
  return new Response(JSON.stringify(body), {
    status: statusCode,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

export default async (request) => {
  try {
    const method = request.method;

    if (method === "OPTIONS") {
      return new Response(null, { status: 204 });
    }

    if (method === "GET") {
      const counts = await getCounts();
      return jsonResponse(200, { counts });
    }

    if (method === "POST") {
      const body = JSON.parse((await request.text()) || "{}");
      const folderId = typeof body.folderId === "string" ? body.folderId.trim() : "";
      if (!folderId || folderId.length > 128) {
        return jsonResponse(400, { error: "folderId kötelező mező." });
      }
      const count = await incrementCount(folderId);
      return jsonResponse(200, { folderId, count });
    }

    return jsonResponse(405, { error: "Nem támogatott HTTP metódus." });
  } catch (err) {
    console.error("Function error:", err);
    return jsonResponse(500, { error: "Szerver hiba", details: err.message });
  }
};
