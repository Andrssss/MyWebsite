const axios = require("axios");
const cheerio = require("cheerio");
const { Pool } = require("pg");


const connectionString = process.env.NETLIFY_DATABASE_URL;
if (!connectionString) throw new Error("NETLIFY_DATABASE_URL is not set");

const pool = new Pool({
  connectionString,
  ssl: { rejectUnauthorized: false },
});

function json(statusCode, body) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify(body),
  };
}

function absolutize(href, base) {
  try {
    return new URL(href, base).toString();
  } catch {
    return null;
  }
}

function normalizeWhitespace(s) {
  return String(s ?? "").replace(/\s+/g, " ").trim();
}

function dedupeByUrl(items) {
  const seen = new Set();
  return items.filter((x) => {
    if (!x.url) return false;
    if (seen.has(x.url)) return false;
    seen.add(x.url);
    return true;
  });
}

// TODO: ide tedd a konkrét listaoldalakat (nem főoldal)
const SOURCES = [
  { source: "melodiak", url: "https://melodiak.hu/" },
  { source: "minddiak", url: "https://minddiak.hu/" },
  { source: "muisz", url: "https://muisz.hu/" },
];

// TODO: oldal-specifikus szűrés/szelektor (ez most csak minta!)
function extractLinksCheerio(html, baseUrl) {
  const $ = cheerio.load(html);
  const items = [];

  $("a[href]").each((_, el) => {
    const title = normalizeWhitespace($(el).text());
    const href = $(el).attr("href");
    if (!title || !href) return;

    const url = absolutize(href, baseUrl);
    if (!url) return;

    // TODO: SZŰRÉS, hogy csak álláshirdetések legyenek
    // pl:
    // if (!url.includes("gyakornok") && !url.includes("allas")) return;

    items.push({ title: title.slice(0, 300), url, description: null });
  });

  return dedupeByUrl(items);
}

async function upsertJob(client, source, item) {
  await client.query(
    `INSERT INTO job_posts (source, title, url, description, first_seen, last_seen)
     VALUES ($1,$2,$3,$4,NOW(),NOW())
     ON CONFLICT (source, url)
     DO UPDATE SET
       title = EXCLUDED.title,
       description = COALESCE(EXCLUDED.description, job_posts.description),
       last_seen = NOW()`,
    [source, item.title, item.url, item.description]
  );
}

exports.handler = async () => {
  return {
    statusCode: 200,
    headers: { "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify({ ok: true, step: "handler-reached", node: process.version }),
  };
};

