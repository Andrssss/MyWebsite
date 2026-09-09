// DISPOSABLE — read-only debug peek at the like-ratelimit blob. Delete after use.
import { getStore } from "@netlify/blobs";

const TOKEN = "d3bf4c9a1e2b7f6053a8c4d9e7f1b2a6c8d0e4f5a7b9c1d3e5f7a9b1c3d5e7f9";

export default async (req) => {
  const auth = req.headers.get("authorization") || "";
  if (auth !== `Bearer ${TOKEN}`) return new Response("Unauthorized", { status: 401 });

  const store = getStore({ name: "subject-reviews", consistency: "strong" });
  const raw = await store.get("like-ratelimit.json", { type: "json" });
  return new Response(JSON.stringify({ now: Date.now(), raw }, null, 2), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
};
