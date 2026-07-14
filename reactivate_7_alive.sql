-- Reactivate the 7 profession-intern rows that are active=false but PROVEN STILL LIVE (2026-07-14).
-- Inverse of the 404-sweep: same checker (cron_404sweep-background's fetchFinal) and the same
-- REDIRECT_DEAD_SOURCES rule from _active_core.mjs, but looking for DEACTIVATED rows whose own url
-- still says the posting is open. Each verdict double-checked (a blip must not resurrect a dead row).
--
--   evidence: HTTP 200 at their OWN path, no 301 to a /allasok/ listing
--             (for profession-intern the redirect IS the death signal — listing absence proves
--              nothing, the site ages ads out of every category listing long before they close)
--   Budapest: re-verified with the scraper's own isBudapestLocation() + extractDetailLocation()
--             against the detail page's FULL city list (commit 84a6377 = Budapest-only policy).
--
-- WHY THIS NEEDS A HUMAN: nothing in the system will ever heal these. reviveSweepDead() only
-- revives STICKY_SWEEP_DEAD_SOURCES (talent, allasportal) — proven live today: the 14:00 UTC sweep
-- auto-revived 10 equally-alive TALENT rows the same hour, while these 7 stayed off. Generalizing
-- reviveSweepDead is FIX-4 in FALSE_DEACTIVATION_CHECK_2026-07-14.md; do that and this file becomes
-- the last manual heal of its kind.
--
-- It sticks: profession-intern reconciles reactivate-only (complete:false), so listing absence can
-- never re-deactivate them; the daily sweep will deactivate them when they ACTUALLY close (301).
--
-- NOT INCLUDED — 5 more profession-intern rows are alive but NOT Budapest (4x Debrecen + 1x Hagen, DE),
-- so they must stay off; in fact they should be DELETED (see FIX-2). Note the city slug LIES:
-- ...-szeged-2944697 is really a Debrecen ad.

BEGIN;

UPDATE job_posts SET active = true, sweep_dead = false
 WHERE source = 'profession-intern'
   AND active = false
   AND url IN (
     'https://www.profession.hu/allas/manual-tester-internal-systems-customer-journey-tresorit-kft-2943078',
     'https://www.profession.hu/allas/angular-developer-nix-tech-kft-2943319',
     'https://www.profession.hu/allas/careers-maxtel-consulting-rendszerfejlesztesi-kft-2931851',
     'https://www.profession.hu/allas/fejleszto-kollegak-bc-hu-informatikai-kft-2931848',
     'https://www.profession.hu/allas/medior-silent-signal-informaciobiztonsagi-informatikai-tanacsado-es-szolgaltato-kft-2928426',
     'https://www.profession.hu/allas/business-intelligence-engineer-mohu-mol-hulladekgazdalkodasi-zrt-2927610',
     'https://www.profession.hu/allas/junior-silent-signal-informaciobiztonsagi-informatikai-tanacsado-es-szolgaltato-kft-2925152'
   );

-- Expect: UPDATE 7
SELECT count(*) AS should_be_7
  FROM job_posts
 WHERE source = 'profession-intern' AND active = true
   AND url IN (
     'https://www.profession.hu/allas/manual-tester-internal-systems-customer-journey-tresorit-kft-2943078',
     'https://www.profession.hu/allas/angular-developer-nix-tech-kft-2943319',
     'https://www.profession.hu/allas/careers-maxtel-consulting-rendszerfejlesztesi-kft-2931851',
     'https://www.profession.hu/allas/fejleszto-kollegak-bc-hu-informatikai-kft-2931848',
     'https://www.profession.hu/allas/medior-silent-signal-informaciobiztonsagi-informatikai-tanacsado-es-szolgaltato-kft-2928426',
     'https://www.profession.hu/allas/business-intelligence-engineer-mohu-mol-hulladekgazdalkodasi-zrt-2927610',
     'https://www.profession.hu/allas/junior-silent-signal-informaciobiztonsagi-informatikai-tanacsado-es-szolgaltato-kft-2925152'
   );

COMMIT;
