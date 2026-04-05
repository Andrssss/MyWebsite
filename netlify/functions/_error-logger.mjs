import { getStore } from "@netlify/blobs";

const STORE_NAME = "fetch-error-logs";

/**
 * Log an HTTP/network fetch error to Netlify Blobs.
 *
 * @param {string} cronJob  – cron job identifier, e.g. "cron_jobs_3"
 * @param {object} opts
 * @param {string} opts.url     – the URL that was fetched
 * @param {string} opts.message – the error message
 * @param {object} [opts.extra] – any additional context
 */
export async function logFetchError(cronJob, { url, message, extra } = {}) {
  try {
    const store = getStore(STORE_NAME);
    const now = new Date();

    // Try to extract HTTP status code from error message (format: "HTTP 404 for ...")
    let statusCode = null;
    const httpMatch = String(message || "").match(/HTTP\s+(\d+)/i);
    if (httpMatch) statusCode = parseInt(httpMatch[1], 10);

    const ts = now.toISOString().replace(/[:.]/g, "-");
    const key = `${cronJob}/${ts}.json`;

    const entry = {
      cronJob,
      url: url || null,
      date: now.toISOString(),
      statusCode,
      message: message || "",
      extra: extra || null,
    };

    await store.set(key, JSON.stringify(entry, null, 2));
    console.log(`[error-logger] ${cronJob}: ${statusCode || "ERR"} – ${url}`);
  } catch (logErr) {
    console.error("[error-logger] failed to write log:", logErr.message);
  }
}
