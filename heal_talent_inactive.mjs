/*
  Egyszeri gyógyító futás (2026-07-10): MINDEN inaktív talent sor detail-oldalát
  megkérdezi a saját állapotáról (ugyanaz az id-horgonyzott system_status módszer,
  mint a sweep BANNER_DEAD_SOURCES.talent szabálya), és:
    • system_status=1 (élő)  → active=true  (a rotáció-churn korszak téves áldozatai)
    • 404 vagy system_status=2 → sweep_dead=true (marad inaktív, sticky — a listing
      nem támaszthatja fel)
    • minden más (fetch-hiba, nincs horgony, 403/5xx) → érintetlen
  A reactivate-only reconcile ezt magától csak a listára visszarotálódó sorokra
  végezné el — ami a keresésekből kiesett élő sorokra (pl. generikus című) SOHA.
  Futtatás:  NETLIFY_DATABASE_URL=... node heal_talent_inactive.mjs
  Deploy után érdemes még egyszer futtatni, ha a régi prod kód időközben
  visszadeaktivált párat. Utána törölhető.
*/
import { Pool } from "pg";
import https from "https";

const CONCURRENCY = 8;
const BODY_CAP = 1_500_000;

function fetchBody(url, redirectLeft = 5) {
  return new Promise((resolve) => {
    const req = https.request(new URL(url), {
      method: "GET",
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
        Accept: "text/html,application/xhtml+xml,*/*;q=0.8",
        "Accept-Language": "hu-HU,hu;q=0.9,en;q=0.8",
        "Accept-Encoding": "identity",
      },
      timeout: 20000,
    }, (res) => {
      const code = res.statusCode || 0;
      if ([301, 302, 303, 307, 308].includes(code) && res.headers.location && redirectLeft > 0) {
        res.resume();
        return resolve(fetchBody(new URL(res.headers.location, url).toString(), redirectLeft - 1));
      }
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (c) => { if (body.length < BODY_CAP) body += c; else res.destroy(); });
      res.on("end", () => resolve({ status: code, body }));
      res.on("close", () => resolve({ status: code, body }));
      res.on("error", () => resolve({ status: code, body }));
    });
    req.on("timeout", () => { req.destroy(); resolve({ status: -2, body: "" }); });
    req.on("error", () => resolve({ status: -3, body: "" }));
    req.end();
  });
}

// "live" | "dead" | "unknown" — pontosan a sweep-predikátum logikája, csak
// gyógyító iránnyal kiegészítve (élő-verdikt is csak pozitív bizonyítékra).
function classify(url, status, body) {
  if (status === 404) return "dead";
  if (status !== 200) return "unknown";
  if (/>\s*Már nem fogadnak jelentkezéseket\s*</i.test(body)) return "dead";
  const id = (url.match(/[?&]id=(\d+)/) || [])[1];
  if (!id) return "unknown";
  let i = body.indexOf(`\\"id\\":\\"${id}\\"`);
  if (i < 0) i = body.indexOf(`"id":"${id}"`);
  if (i < 0) return "unknown";
  const m = body.slice(i, i + 3000).match(/system_status\\?"\s*:\s*(\d+)/);
  if (!m) return "unknown";
  if (m[1] === "1") return "live";
  if (m[1] === "2") return "dead";
  return "unknown";
}

const pool = new Pool({
  connectionString: process.env.NETLIFY_DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});
const client = await pool.connect();
try {
  const { rows } = await client.query(
    `SELECT url FROM job_posts WHERE source = 'talent' AND active = false ORDER BY url`
  );
  console.log(`${rows.length} inaktív talent sor ellenőrzése...`);

  const verdicts = new Map();
  const lanes = Array.from({ length: CONCURRENCY }, (_, i) => rows.filter((_, x) => x % CONCURRENCY === i));
  let done = 0;
  await Promise.all(lanes.map(async (list) => {
    for (const { url } of list) {
      const { status, body } = await fetchBody(url);
      verdicts.set(url, { verdict: classify(url, status, body), status });
      done += 1;
      if (done % 50 === 0) console.log(`  ...${done}/${rows.length}`);
    }
  }));

  const live = [...verdicts].filter(([, v]) => v.verdict === "live").map(([u]) => u);
  const dead = [...verdicts].filter(([, v]) => v.verdict === "dead").map(([u]) => u);
  const unknown = [...verdicts].filter(([, v]) => v.verdict === "unknown");
  console.log(`élő=${live.length} halott=${dead.length} ismeretlen=${unknown.length}`);
  for (const [u, v] of unknown) console.log(`  ? ${u} (HTTP ${v.status})`);

  await client.query("BEGIN");
  const r1 = await client.query(
    `UPDATE job_posts SET active = true
      WHERE source = 'talent' AND active = false AND url = ANY($1::text[])`,
    [live]
  );
  const r2 = await client.query(
    `UPDATE job_posts SET sweep_dead = true
      WHERE source = 'talent' AND active = false AND url = ANY($1::text[])`,
    [dead]
  );
  await client.query("COMMIT");
  console.log(`reaktiválva: ${r1.rowCount}, sweep_dead-re flagelve: ${r2.rowCount}`);
} catch (e) {
  try { await client.query("ROLLBACK"); } catch {}
  throw e;
} finally {
  client.release();
  await pool.end();
}
