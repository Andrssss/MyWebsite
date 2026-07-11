process.env.NETLIFY_DATABASE_URL = "postgresql://neondb_owner:npg_gxcq7S8tbkLO@ep-raspy-bar-aepg18at-pooler.c-2.us-east-2.aws.neon.tech/neondb?sslmode=verify-full";
process.env.CRON_SECRET = "localtest";

const write = process.argv[2] === "write" ? 1 : 0;
const mod = await import("./netlify/functions/cron_jobs_DIAK_3-background.mjs");
const req = new Request(`http://localhost/.netlify/functions/cron_jobs_DIAK_3-background?debug=1&batch=1&size=5&write=${write}`, {
  headers: { authorization: "Bearer localtest" },
});
const res = await mod.default(req);
console.log("HTTP status:", res.status);
console.log(await res.text());
process.exit(0);
