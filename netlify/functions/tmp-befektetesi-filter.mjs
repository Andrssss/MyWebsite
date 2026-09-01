/*
  DISPOSABLE one-off endpoint — delete right after use.

  A `job_filters` 166-os sora egy CSUPASZ "Befektetesi" szó. A denylist
  szóhatáros cím-egyezés, az Erste pedig a POZÍCIÓ mögé odaírja a jogi
  entitást is ("DevOps mérnök - Befektetési Zrt."), így ez a szó a CÉGNÉV-
  utótagon keresztül ölt meg valódi IT-hirdetéseket. Élő bizonyíték
  2026-09-01: a szűrt erste API visszaadja a 8967 (DevOps mérnök) és a 8972
  (Front alkalmazás üzemeltető és adatbázis kezelő munkatárs) sort is,
  a `job_posts`-ban egyik sincs benne — és a teljes DB-ben EGYETLEN sor
  sincs, aminek a címében szerepelne a szó, egyik forrásból sem.

  User-döntés 2026-09-01: a csupasz szó helyett MINŐSÍTETT formák jönnek,
  hogy a valódi (nem IT) befektetési szerepek továbbra is kiessenek, az
  IT-összetételek viszont átmenjenek:
      "Befektetesi"  →  "Befektetési tanácsadó" + "Befektetési ügyintéző"

  (A `befektetes elemzo` szó, id 1649, VÁLTOZATLAN marad.)

  Alapból SZÁRAZ futás; írni csak `&go=1`-gyel ír.
*/
import { Pool } from "pg";

const TOKEN = "66dc898eeb137c94982335ca020c239535ddd47af9b5a03f";

const DROP_WORD = "befektetesi";                                  // LOWER() egyezésre
const ADD_WORDS = ["Befektetési tanácsadó", "Befektetési ügyintéző"];

const pool = new Pool({
  connectionString: process.env.NETLIFY_DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

const json = (status, body) =>
  new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });

export default async (req) => {
  const u = new URL(req.url);
  if (u.searchParams.get("t") !== TOKEN) return new Response("nope", { status: 403 });
  const dry = u.searchParams.get("go") !== "1";

  const client = await pool.connect();
  try {
    const { rows: before } = await client.query(
      `SELECT id, word FROM job_filters WHERE LOWER(word) = $1 ORDER BY id`,
      [DROP_WORD]
    );
    const { rows: existingAdds } = await client.query(
      `SELECT id, word FROM job_filters WHERE LOWER(word) = ANY($1) ORDER BY id`,
      [ADD_WORDS.map((w) => w.toLowerCase())]
    );

    if (dry) {
      return json(200, {
        dryRun: true,
        wouldDelete: before,
        wouldInsert: ADD_WORDS.filter(
          (w) => !existingAdds.some((e) => e.word.toLowerCase() === w.toLowerCase())
        ),
        alreadyPresent: existingAdds,
      });
    }

    // Egy tranzakció: a denylist egy pillanatra se legyen olyan állapotban,
    // ahol MINDKÉT forma hiányzik (a scraperek 5 percenként újratöltik).
    await client.query("BEGIN");
    const inserted = [];
    for (const w of ADD_WORDS) {
      const { rows } = await client.query(
        `INSERT INTO job_filters (word) VALUES ($1)
         ON CONFLICT (LOWER(word)) DO NOTHING
         RETURNING id, word`,
        [w]
      );
      if (rows.length) inserted.push(rows[0]);
    }
    const del = await client.query(
      `DELETE FROM job_filters WHERE LOWER(word) = $1 RETURNING id, word`,
      [DROP_WORD]
    );
    await client.query("COMMIT");

    const { rows: after } = await client.query(
      `SELECT id, word FROM job_filters WHERE LOWER(word) LIKE '%befektet%' ORDER BY id`
    );

    return json(200, { dryRun: false, deleted: del.rows, inserted, nowMatching: after });
  } catch (err) {
    try { await client.query("ROLLBACK"); } catch {}
    return json(500, { error: err.message });
  } finally {
    client.release();
  }
};
