// DISPOSABLE — one-off fix, delete after use.
//
// Removes the bare-word job_filters denylist entry "kockazatkezelesi"
// (id 976), which was killing a genuine, non-senior IT posting from erste
// ("Rendszerszervező - Kockázatkezelési rendszerek Squad", id 8980 on the
// source) as a false positive — same bug class as the earlier munkatars/
// uzemeltetesi/Befektetesi fixes. The more specific risk-role words already
// in the list (kockazatelemzo, hitelkockazati elemzo, kockazatvallalo,
// mukodesi kockazatkezelo) still cover the actual non-IT risk-management
// job titles, so this bare adjective is redundant as well as overbroad.
//
// GET  -> dry run, shows the matching row(s) without writing.
// POST -> deletes the matching row(s) and returns what was removed.

import { readFilterState, writeFilterState } from "./_job_filters_store.mjs";

const TOKEN = "128c9a177a91d738fc4e41da0cef092ae46fb54fcb64ad08";
const TARGET_WORD = "kockazatkezelesi";

function authorized(request) {
  const token = (request.headers.get("authorization") || "").replace(/^Bearer\s+/i, "").trim();
  return token === TOKEN;
}

function json(status, body) {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

export default async (request) => {
  if (!authorized(request)) return json(401, { error: "Unauthorized" });

  const state = await readFilterState();
  const matches = state.words.filter((w) => w.word.toLowerCase() === TARGET_WORD);

  if (request.method === "GET") {
    return json(200, { dryRun: true, matches, totalWords: state.words.length });
  }

  if (request.method === "POST") {
    state.words = state.words.filter((w) => w.word.toLowerCase() !== TARGET_WORD);
    await writeFilterState(state);
    return json(200, { removed: matches, totalWordsAfter: state.words.length });
  }

  return json(405, { error: "GET or POST only" });
};
