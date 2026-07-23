// netlify/functions/admin-verify.js
//
// Does this bearer token match ADMIN_SECRET? Nothing else — no data in, no data
// out. It exists so the UI can confirm admin status UP FRONT (one prompt on
// entry) instead of discovering a wrong password later, mid-action, after an
// optimistic update already flipped on screen.
//
//   GET, Header: Authorization: Bearer $ADMIN_SECRET  → 200 {ok:true} | 401
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || "https://bakan7.netlify.app";

function corsHeaders(extra = {}) {
  return {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
    "Access-Control-Allow-Methods": "GET,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    // Never let a shared cache hold on to an authorization verdict.
    "Cache-Control": "private, no-store",
    ...extra,
  };
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: corsHeaders(), body: "" };
  }

  const expected = (process.env.ADMIN_SECRET || process.env.CRON_SECRET || "").trim();
  const hdr =
    (event.headers && (event.headers.authorization || event.headers.Authorization)) || "";
  const token = hdr.replace(/^Bearer\s+/i, "").trim();

  const ok = expected.length > 0 && token.length > 0 && token === expected;
  return {
    statusCode: ok ? 200 : 401,
    headers: corsHeaders(),
    body: JSON.stringify(ok ? { ok: true } : { error: "Unauthorized" }),
  };
};
