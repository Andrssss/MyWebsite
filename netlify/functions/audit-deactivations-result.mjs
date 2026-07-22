// ONE-OFF temporary reader for the audit-deactivations-background blob — delete
// together with that file after use.
import { getStore } from "@netlify/blobs";

export default async (request) => {
  const auth = (request.headers.get("authorization") || "").trim();
  const token = auth.replace(/^Bearer\s+/i, "").trim();
  const expected = process.env.CRON_SECRET;
  if (!expected || token !== expected) {
    return new Response("Unauthorized", { status: 401 });
  }

  const store = getStore("job-audit");
  const data = await store.get("latest", { type: "json" }).catch(() => null);
  if (!data) {
    return new Response(JSON.stringify({ status: "not_found" }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    });
  }
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
};
