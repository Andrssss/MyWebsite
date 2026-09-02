// netlify/functions/job-access.js
//
// "May this browser use /allasfigyelo at all?" — the ONE endpoint an ordinary
// visitor is still allowed to call on that page. It returns a verdict and
// nothing else (no jobs, no counts, no source list), because the answer can
// only come from the server: the credential is the visitor cookie matched
// against the ADMIN_* env vars, which the client cannot check for itself.
// Everything else under /allasfigyelo is admin-only now — ordinary visitors are
// redirected to pestidev.hu before a single data fetch fires.
//
//   GET → 200 { access: true,  tier: "admin" }
//         200 { access: false, tier: null }
//
// `tier` is kept in the payload even though "admin" is now its only non-null
// value (the read-only "little" tier was removed 2026-09-01): the client reads
// it, and a bare boolean would have to be re-widened if a second tier ever
// returns.
//
// Deliberately 200 + `access:false` rather than 401: "you are an ordinary
// visitor" is a normal answer here, not an error the client should retry or
// treat as a broken page. A 401 would also make the redirect indistinguishable
// from a transient auth failure.
const { resolveOwnerKey, hasAdminSecret } = require("./_admin_identity_core");

const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || "https://bakan7.netlify.app";

function corsHeaders(extra = {}) {
  return {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
    "Access-Control-Allow-Methods": "GET,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    // Per-visitor verdict — a shared cache must never hand one browser's
    // answer to another, or an ordinary visitor could inherit "access:true".
    "Cache-Control": "private, no-store",
    ...extra,
  };
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: corsHeaders(), body: "" };
  }

  // Cookie first (that is what a browser has); an ADMIN_SECRET bearer also
  // counts, so curl/script access keeps working.
  const tier = resolveOwnerKey(event) || (hasAdminSecret(event) ? "admin" : null);

  return {
    statusCode: 200,
    headers: corsHeaders(),
    body: JSON.stringify({ access: tier !== null, tier }),
  };
};
