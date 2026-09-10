// DISPOSABLE — 2026-09-10. Runs prodiak's EXACT fetch call (postJson, same
// headers/timeout) from INSIDE Netlify's function environment (us-east-2
// Lambda), to check whether the site blocks/behaves differently for
// Netlify's outbound IPs than for a dev machine (same class of issue as
// startup.jobs' Cloudflare block). Delete after use.
import https from "https";

const TOKEN = "b7e2c904f6a183d5e07c9b4a1f6d8032e5c7a91b4f083d6e";
const BASE = "https://www.prodiak.hu";
const API = `${BASE}/api/adverts`;

function postJson(url, body, timeout = 25000) {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(url);
    const payload = JSON.stringify(body);
    const start = Date.now();
    const req = https.request(
      parsedUrl,
      {
        method: "POST",
        headers: {
          "User-Agent": "Mozilla/5.0",
          Accept: "application/json",
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload),
        },
        timeout,
      },
      (res) => {
        let data = "";
        res.setEncoding("utf8");
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          const ms = Date.now() - start;
          if (res.statusCode >= 200 && res.statusCode < 300) {
            try { resolve({ ok: true, ms, status: res.statusCode, parsed: JSON.parse(data) }); }
            catch (e) { resolve({ ok: false, ms, status: res.statusCode, parseError: e.message, dataSample: data.slice(0, 300) }); }
          } else {
            resolve({ ok: false, ms, status: res.statusCode, dataSample: data.slice(0, 300) });
          }
        });
        res.on("error", (e) => resolve({ ok: false, ms: Date.now() - start, networkError: e.message }));
      }
    );
    req.on("timeout", () => { req.destroy(); resolve({ ok: false, ms: Date.now() - start, timedOut: true }); });
    req.on("error", (e) => resolve({ ok: false, ms: Date.now() - start, requestError: e.message, code: e.code }));
    req.write(payload);
    req.end();
  });
}

export default async (request) => {
  const auth = (request.headers.get("authorization") || "").trim();
  if (auth !== `Bearer ${TOKEN}`) return new Response("unauthorized", { status: 401 });

  const params = new URL(request.url).searchParams;
  const pages = Number(params.get("pages") || 1);

  const results = [];
  for (let p = 1; p <= pages; p++) {
    const r = await postJson(`${API}?page=${p}`, {});
    const summary = { page: p, ok: r.ok, ms: r.ms, status: r.status ?? null };
    if (r.ok) {
      summary.rows = r.parsed?.adverts?.data?.length ?? null;
      summary.lastPage = r.parsed?.adverts?.last_page ?? null;
    } else {
      Object.assign(summary, r);
    }
    results.push(summary);
    if (p < pages) await new Promise((res) => setTimeout(res, 300));
  }

  return new Response(JSON.stringify({ region: process.env.AWS_REGION || null, results }, null, 2), {
    headers: { "content-type": "application/json" },
  });
};
