console.log("CRON_JOBS DEBUG LOADED");

export const config = {
  schedule: "5 4,10,16 * * *", // éles cron
};

// Polyfill
globalThis.File ??= class File {};
globalThis.Blob ??= class Blob {};
globalThis.FormData ??= class FormData {};

import https from "node:https";
import http from "node:http";
import zlib from "node:zlib";
import { load as cheerioLoad } from "cheerio";
import pkg from "pg";
const { Pool } = pkg;

// =====================
// DB
// =====================
const connectionString = process.env.NETLIFY_DATABASE_URL;
if (!connectionString) throw new Error("NETLIFY_DATABASE_URL is not set");

const pool = new Pool({
  connectionString,
  ssl: { rejectUnauthorized: false },
});

// =====================
// Helpers
// =====================
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function fetchTextDebug(url, redirectLeft = 5) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const lib = u.protocol === "https:" ? https : http;

    const req = lib.request(u, {
      method: "GET",
      headers: { "User-Agent": "JobWatcher/1.0" },
      timeout: 30000
    }, res => {
      const code = res.statusCode || 0;
      console.log(`[FETCH] ${code} ${url}`);

      if ([301,302,303,307,308].includes(code)) {
        const loc = res.headers.location;
        if (!loc) return reject(new Error(`Redirect without Location: ${url}`));
        if (redirectLeft <= 0) return reject(new Error(`Too many redirects for ${url}`));
        res.resume();
        return resolve(fetchTextDebug(new URL(loc, url).toString(), redirectLeft - 1));
      }

      let stream = res;
      const enc = String(res.headers["content-encoding"] || "").toLowerCase();
      if (enc.includes("gzip")) stream = res.pipe(zlib.createGunzip());
      else if (enc.includes("deflate")) stream = res.pipe(zlib.createInflate());
      else if (enc.includes("br")) stream = res.pipe(zlib.createBrotliDecompress());

      let data = "";
      stream.setEncoding("utf8");
      stream.on("data", chunk => data += chunk);
      stream.on("end", () => {
        if (code >= 200 && code < 300) resolve(data);
        else reject(new Error(`HTTP ${code} for ${url}`));
      });
      stream.on("error", reject);
    });

    req.on("timeout", () => req.destroy(new Error(`Timeout for ${url}`)));
    req.on("error", reject);
    req.end();
  });
}

// =====================
// Cron runner
// =====================
export async function handler(event, context) {
  console.log("[CRON] START", new Date().toISOString());

  const SOURCES = [
    { key: "profession-intern", label: "Profession – Intern", url: "https://www.profession.hu/allasok/it-programozas-fejlesztes/budapest/1,10,23,intern" },
  ];

  const stats = [];

  for (const s of SOURCES) {
    console.log(`[CRON] Processing ${s.label} - ${s.url}`);
    try {
      const html = await fetchTextDebug(s.url);
      console.log(`[CRON] Fetched ${html.slice(0,100).replace(/\n/g," ")}...`);
      stats.push({ source: s.key, ok: true, length: html.length });
    } catch (err) {
      console.error(`[CRON] ERROR fetching ${s.url}`, err.stack);
      stats.push({ source: s.key, ok: false, error: err.message });
    }

    await sleep(200); // Netlify throttling
  }

  console.log("[CRON] DONE", stats);

  return {
    statusCode: 200,
    body: JSON.stringify({ ranAt: new Date().toISOString(), stats })
  };
}
