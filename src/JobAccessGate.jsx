// Access gate for everything under /allasfigyelo.
//
// Since 2026-08-25 the job board is admin-only: browsing new postings lives on
// https://pestidev.hu, and this site keeps only the admin side of it. An
// ordinary visitor who clicks "Állásfigyelő" is sent straight to pestidev.hu —
// the page itself never mounts, so not one of its data fetches ever fires.
//
// The verdict CANNOT be decided client-side: the credential is the visitor
// cookie matched against the ADMIN_* env vars, which only the
// server can see. So exactly one endpoint stays callable by everyone —
// `job-access`, which returns a boolean and no data at all — and every other
// job-board function is gated server-side too (_admin_identity_core.js →
// hasJobBoardAccess). The redirect here is the UX half; that is the real lock.
import React, { createContext, useContext, useEffect, useMemo, useState } from "react";

const ACCESS_API = "/.netlify/functions/job-access";
export const REROUTE_URL = "https://pestidev.hu/?fresh=today";

// tier: "admin" — the only granted value since the read-only "little" tier was
// removed 2026-09-01; kept as a string so a future second tier needs no reshape.
const JobAccessContext = createContext({ tier: null });

export const useJobAccess = () => useContext(JobAccessContext);

// Module-level memo. The four /allasfigyelo routes each mount their own gate,
// and the verdict can't change within a page load — without this, navigating
// between the board and the stats page would re-probe every time.
let cachedVerdict = null;
let inflight = null;

function fetchAccess() {
  if (cachedVerdict) return Promise.resolve(cachedVerdict);
  if (!inflight) {
    inflight = fetch(ACCESS_API, { credentials: "same-origin" })
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
      })
      .then((data) => {
        // Only a real answer is memoized; a failure must stay retryable.
        cachedVerdict = { tier: data && data.access ? data.tier : null };
        return cachedVerdict;
      })
      .finally(() => {
        inflight = null;
      });
  }
  return inflight;
}

const JobAccessGate = ({ children }) => {
  const [state, setState] = useState(() =>
    cachedVerdict ? { phase: "done", tier: cachedVerdict.tier } : { phase: "checking", tier: null }
  );

  useEffect(() => {
    if (state.phase !== "checking") return;
    let cancelled = false;
    fetchAccess()
      .then((v) => {
        if (!cancelled) setState({ phase: "done", tier: v.tier });
      })
      .catch(() => {
        // A dropped request is NOT a verdict: bouncing an admin off the site
        // over one network hiccup would be worse than showing a retry. The
        // endpoints stay gated server-side either way, so failing "open" here
        // exposes nothing.
        if (!cancelled) setState({ phase: "error", tier: null });
      });
    return () => {
      cancelled = true;
    };
  }, [state.phase]);

  // Non-admin → off to pestidev.hu. `replace` so Back doesn't bounce them
  // between the two sites.
  useEffect(() => {
    if (state.phase === "done" && state.tier === null) {
      window.location.replace(REROUTE_URL);
    }
  }, [state.phase, state.tier]);

  if (state.phase === "checking") {
    return <div className="job-access-gate">Betöltés…</div>;
  }

  if (state.phase === "error") {
    return (
      <div className="job-access-gate">
        <p>Nem sikerült ellenőrizni a hozzáférést.</p>
        <button className="job-btn" onClick={() => setState({ phase: "checking", tier: null })}>
          Újra
        </button>
      </div>
    );
  }

  if (state.tier === null) {
    return (
      <div className="job-access-gate">
        <p>Az állásböngészés átköltözött a pestidev.hu oldalra.</p>
        <p>
          Átirányítás… ha nem indul el magától:{" "}
          <a href={REROUTE_URL} rel="noopener noreferrer">
            pestidev.hu
          </a>
        </p>
      </div>
    );
  }

  return <GrantedProvider tier={state.tier}>{children}</GrantedProvider>;
};

// Split out so the context value is a stable object: an inline `{{ tier }}`
// literal is a new reference on every render and would re-render every
// consumer of the (huge) job board for nothing.
const GrantedProvider = ({ tier, children }) => {
  const value = useMemo(() => ({ tier }), [tier]);
  return <JobAccessContext.Provider value={value}>{children}</JobAccessContext.Provider>;
};

export default JobAccessGate;
