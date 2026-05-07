// netlify/functions/_cross_duplicate.mjs
//
// Marks rows in job_posts as is_cross_duplicate = true when the same
// (normalized title, normalized company) pair appears under more than
// one `source` within the last N days.
//
// Idempotent: only flips rows currently false → true. Never resets true → false.

export async function flagCrossDuplicates(client, { days = 2, label = "" } = {}) {
  const tag = label ? `[${label}] ` : "";
  try {
    const { rowCount } = await client.query(
      `
      WITH groups AS (
        SELECT
          LOWER(REGEXP_REPLACE(TRIM(title), '\\s+', ' ', 'g'))   AS t,
          LOWER(REGEXP_REPLACE(TRIM(company), '\\s+', ' ', 'g')) AS c,
          ARRAY_AGG(DISTINCT source) AS sources,
          ARRAY_AGG(id)              AS ids
        FROM job_posts
        WHERE first_seen >= NOW() - ($1 || ' days')::interval
          AND company IS NOT NULL
          AND TRIM(company) <> ''
        GROUP BY 1, 2
        HAVING ARRAY_LENGTH(ARRAY_AGG(DISTINCT source), 1) > 1
      )
      UPDATE job_posts jp
         SET is_cross_duplicate = TRUE
        FROM groups g
       WHERE jp.id = ANY(g.ids)
         AND jp.is_cross_duplicate = FALSE
      `,
      [String(days)]
    );
    console.log(`${tag}cross-dup: flagged ${rowCount} new row(s) in last ${days} day(s)`);
    return rowCount;
  } catch (err) {
    console.error(`${tag}cross-dup flagging failed: ${err.message}`);
    return 0;
  }
}
