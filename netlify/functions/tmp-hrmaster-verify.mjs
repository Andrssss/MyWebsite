// DISPOSABLE — 2026-09-22. Quick read-only check that the new hrmaster.hu
// DEAD_PHRASES entry catches the 2 user-confirmed-dead rows through the real
// production isDeadResult path. Plain (non-background) function — only 2
// fetches. Delete after use.
import { isDeadResult, sweepProbeFor } from "./_active_core.mjs";
import { fetchFinal } from "./cron_404sweep-background.mjs";

const TOKEN = "a9026d96f46e40acccd347aadcbac507f7b3f014a037e4d7";
const ROWS = [
  { url: "https://magicom.hrmaster.hu/Datacenter/Registration/JobAdvertisement/111/azure-devops-cloud-infrastructure-engineer/allasok", source: "AI-scraped", title: "Azure DevOps / Cloud Infrastructure Engineer", company: "Magicom Kft." },
  { url: "https://segelyszervezet.hrmaster.hu/Datacenter/Registration/JobAdvertisement/124/junior-rendszergazda/allasok", source: "AI-scraped", title: "Junior rendszergazda", company: "Magyar Ökumenikus Segélyszervezet" },
];

export default async (request) => {
  const auth = (request.headers.get("authorization") || "").trim();
  if (auth !== `Bearer ${TOKEN}`) return new Response("unauthorized", { status: 401 });

  const results = [];
  for (const row of ROWS) {
    const p = sweepProbeFor(row);
    const res = await fetchFinal(p.url, { wantBody: true, headers: p.headers });
    results.push({ company: row.company, title: row.title, url: row.url, status: res.status, dead: isDeadResult(row, res) });
  }
  return new Response(JSON.stringify({ results }, null, 2), {
    headers: { "content-type": "application/json; charset=utf-8" },
  });
};
