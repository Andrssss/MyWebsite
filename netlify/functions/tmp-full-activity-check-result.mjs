// DISPOSABLE — 2026-09-22. Reader for tmp-full-activity-check-background's
// blob result. Delete after use.
import { getStore } from "@netlify/blobs";

const TOKEN = "d43771cdebbfe2b14af4af055c4c497bad4b5564f69a8898";

export default async (request) => {
  const auth = (request.headers.get("authorization") || "").trim();
  if (auth !== `Bearer ${TOKEN}`) return new Response("unauthorized", { status: 401 });
  const store = getStore("tmp-full-activity-check-result");
  const data = await store.get("latest.json", { type: "json" });
  return new Response(JSON.stringify(data ?? { status: "not started" }, null, 2), {
    headers: { "content-type": "application/json; charset=utf-8" },
  });
};
