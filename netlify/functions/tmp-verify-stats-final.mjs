// Disposable read-only check: confirm the job-stats blob's generatedAt and
// row counts reflect the latest full-history rebuild (post dupe-cleanup).
import { getStore } from "@netlify/blobs";

const TOKEN = "f3b8a12d9c6e740158b3fa29d7c6e18042f9b3a6";

export default async (request) => {
  const auth = request.headers.get("authorization") || "";
  if (auth.replace(/^Bearer\s+/i, "").trim() !== TOKEN) {
    return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 });
  }
  const store = getStore("job-stats");
  const latest = await store.get("latest.json", { type: "json" });
  return new Response(
    JSON.stringify(
      {
        generatedAt: latest?.generatedAt,
        dailyStatsDays: (latest?.dailyStats || []).length,
        dailyCategoriesRows: (latest?.dailyCategories || []).length,
        dailyLanguagesRows: (latest?.dailyLanguages || []).length,
        dailyTechnologiesRows: (latest?.dailyTechnologies || []).length,
        lastDay: (latest?.dailyStats || [])[(latest?.dailyStats || []).length - 1],
      },
      null,
      2
    ),
    { status: 200, headers: { "Content-Type": "application/json" } }
  );
};
