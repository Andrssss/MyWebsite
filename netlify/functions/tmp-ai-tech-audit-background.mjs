// DISPOSABLE — 2026-09-15. Read-only audit: samples last-7-days job_posts
// across every source, live-fetches each posting, and greps the raw page
// text for AI/LLM-tool candidate terms (Gemini, Anthropic, Mistral, ...)
// that are NOT yet in _tech_keywords.js, to decide which are worth adding.
// Writes results to the "tmp-ai-tech-audit" Blob store; read via the
// companion tmp-ai-tech-audit-result.mjs. Remove both once done.
import { Pool } from "pg";
import { getStore } from "@netlify/blobs";
import { fetchText } from "./_experience_core.mjs";

export const config = { background: true };

const TOKEN = "f3a9c2e7b6d1508f4a2c7e9b1d6f0a3c8e5b2d9f7a1c4e6b";

const PER_SOURCE_LIMIT = 8;
const TOTAL_CAP = 260;
const CONCURRENCY = 10;
const FETCH_TIMEOUT_MS = 9000;

// [key, label, note] — note flags candidates with known ambiguity risk so
// the review step can weigh hits against real snippet context.
const CANDIDATES = [
  ["gemini", "Gemini"],
  ["bard", "Google Bard", "ambiguous: everyday word (poet)"],
  ["anthropic", "Anthropic"],
  ["claude", "Claude", "ambiguous: could be a person's name"],
  ["mistral ai", "Mistral AI"],
  ["mistral", "Mistral", "check: wind name / could collide"],
  ["llama", "Llama", "ambiguous: animal"],
  ["grok", "Grok"],
  ["deepseek", "DeepSeek"],
  ["cohere", "Cohere", "ambiguous: everyday verb"],
  ["perplexity", "Perplexity", "ambiguous: everyday noun / ML metric"],
  ["ollama", "Ollama"],
  ["bedrock", "AWS Bedrock", "ambiguous: literal bedrock"],
  ["azure openai", "Azure OpenAI"],
  ["watsonx", "watsonx"],
  ["ibm watson", "IBM Watson"],
  ["palm", "Google PaLM", "ambiguous: hand/tree"],
  ["stable diffusion", "Stable Diffusion"],
  ["midjourney", "Midjourney"],
  ["dall-e", "DALL-E"],
  ["dalle", "DALL-E"],
  ["n8n", "n8n"],
  ["zapier", "Zapier"],
  ["crewai", "CrewAI"],
  ["autogen", "AutoGen", "ambiguous: 'auto-generated'"],
  ["semantic kernel", "Semantic Kernel"],
  ["pinecone", "Pinecone", "ambiguous: literal pinecone"],
  ["weaviate", "Weaviate"],
  ["qdrant", "Qdrant"],
  ["milvus", "Milvus"],
  ["faiss", "FAISS"],
  ["whisper", "OpenAI Whisper", "ambiguous: everyday verb"],
  ["gpt-4", "GPT-4"],
  ["gpt-5", "GPT-5"],
  ["langsmith", "LangSmith"],
  ["amazon q", "Amazon Q"],
  ["notebooklm", "NotebookLM"],
  ["replit", "Replit"],
  ["azure ai foundry", "Azure AI Foundry"],
  ["azure ai studio", "Azure AI Studio"],
];

function boundaryRegex(keyword) {
  const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^\\p{L}\\p{N}])${escaped}([^\\p{L}\\p{N}]|$|\\d)`, "iu");
}

function snippetAround(text, idx, len) {
  const start = Math.max(0, idx - 50);
  const end = Math.min(text.length, idx + len + 50);
  return text.slice(start, end).replace(/\s+/g, " ").trim();
}

async function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error("timeout")), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

async function runPool(items, worker, concurrency) {
  let i = 0;
  async function next() {
    while (i < items.length) {
      const idx = i++;
      await worker(items[idx], idx);
    }
  }
  await Promise.all(Array.from({ length: concurrency }, next));
}

export default async (request) => {
  const auth = (request.headers.get("authorization") || "").trim();
  if (auth !== `Bearer ${TOKEN}`) return new Response("unauthorized", { status: 401 });

  const store = getStore("tmp-ai-tech-audit");
  await store.setJSON("result", { status: "processing", startedAt: new Date().toISOString() });

  const connectionString = process.env.NETLIFY_DATABASE_URL;
  const pool = new Pool({ connectionString, ssl: { rejectUnauthorized: false } });

  try {
    const client = await pool.connect();
    let rows;
    try {
      const { rows: sourceRows } = await client.query(
        `SELECT DISTINCT source FROM job_posts WHERE first_seen >= now() - interval '7 days'`
      );
      const sources = sourceRows.map(r => r.source);

      rows = [];
      for (const source of sources) {
        const { rows: sample } = await client.query(
          `SELECT id, source, title, company, url FROM job_posts
           WHERE source = $1 AND first_seen >= now() - interval '7 days'
           ORDER BY random() LIMIT $2`,
          [source, PER_SOURCE_LIMIT]
        );
        rows.push(...sample);
      }
      if (rows.length > TOTAL_CAP) {
        // interleave-preserving shuffle-trim so no single source dominates the cap
        rows = rows.sort(() => Math.random() - 0.5).slice(0, TOTAL_CAP);
      }
    } finally {
      client.release();
    }

    const perCandidate = {};
    for (const [, label] of CANDIDATES) perCandidate[label] = { count: 0, examples: [] };

    let fetchedOk = 0;
    let fetchFailed = 0;
    const failuresBySource = {};

    await runPool(rows, async (row) => {
      let text;
      try {
        text = await withTimeout(fetchText(row.url), FETCH_TIMEOUT_MS);
        fetchedOk++;
      } catch (err) {
        fetchFailed++;
        failuresBySource[row.source] = (failuresBySource[row.source] || 0) + 1;
        return;
      }

      for (const [key, label] of CANDIDATES) {
        const re = boundaryRegex(key);
        const m = re.exec(text);
        if (m) {
          const bucket = perCandidate[label];
          bucket.count++;
          if (bucket.examples.length < 4) {
            bucket.examples.push({
              source: row.source,
              title: row.title,
              company: row.company,
              url: row.url,
              snippet: snippetAround(text, m.index, key.length),
            });
          }
        }
      }
    }, CONCURRENCY);

    const notesByLabel = Object.fromEntries(
      CANDIDATES.map(([, label, note]) => [label, note || null])
    );

    await store.setJSON("result", {
      status: "done",
      finishedAt: new Date().toISOString(),
      totalRows: rows.length,
      fetchedOk,
      fetchFailed,
      failuresBySource,
      perCandidate,
      notesByLabel,
    });
  } catch (err) {
    await store.setJSON("result", { status: "error", error: String(err && err.stack || err) });
  } finally {
    await pool.end().catch(() => {});
  }
};
