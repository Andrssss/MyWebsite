-- Deactivate the 35 job_posts rows proven DEAD at their own URL (2026-07-14).
-- Verified twice each, using the repo's own fetchFinal + _isDeadResult rules,
-- so this is exactly what cron_404sweep-background would have done at 14:00 UTC.
--   talent(22)            200 + flight-payload system_status=2  -> BANNER_DEAD_SOURCES.talent
--   profession-intern(12) 200 -> 301 to a /allasok/ listing     -> REDIRECT_DEAD_SOURCES
--   nofluffjobs(1)        200 + nfj-posting-expired-breadcrumbs -> BANNER_DEAD_SOURCES.nofluffjobs
--
-- sweep_dead = true is what the sweep sets; for talent (STICKY_SWEEP_DEAD_SOURCES)
-- it also stops the hourly listing scrape from resurrecting these rows.

BEGIN;

-- talent (22)
UPDATE job_posts SET active = false, sweep_dead = true
 WHERE source = 'talent'
   AND active = true
   AND url IN (
     'https://hu.talent.com/view?id=623862821223204933',
     'https://hu.talent.com/view?id=627626637010600961',
     'https://hu.talent.com/view?id=603293898653441977',
     'https://hu.talent.com/view?id=618445425874770803',
     'https://hu.talent.com/view?id=625455388224006467',
     'https://hu.talent.com/view?id=624601607394958288',
     'https://hu.talent.com/view?id=619203651699355617',
     'https://hu.talent.com/view?id=624921416735267708',
     'https://hu.talent.com/view?id=626319706773070515',
     'https://hu.talent.com/view?id=623725226478012832',
     'https://hu.talent.com/view?id=571981520105314274',
     'https://hu.talent.com/view?id=625117120562530263',
     'https://hu.talent.com/view?id=602336000827073420',
     'https://hu.talent.com/view?id=623862802057791557',
     'https://hu.talent.com/view?id=620030589740326090',
     'https://hu.talent.com/view?id=619203680500592609',
     'https://hu.talent.com/view?id=623953611679738615',
     'https://hu.talent.com/view?id=625455362645109059',
     'https://hu.talent.com/view?id=600745571858780376',
     'https://hu.talent.com/view?id=614774751258748879',
     'https://hu.talent.com/view?id=601899910958751845',
     'https://hu.talent.com/view?id=607937165074895822'
   );

-- profession-intern (12)
UPDATE job_posts SET active = false, sweep_dead = true
 WHERE source = 'profession-intern'
   AND active = true
   AND url IN (
     'https://www.profession.hu/allas/service-hub-owner-ref-s-deutsche-telekom-tsi-hungary-kft-2947246',
     'https://www.profession.hu/allas/web-app-frontend-developer-ref-x-deutsche-telekom-tsi-hungary-kft-szeged-2943113',
     'https://www.profession.hu/allas/ai-engineer-hungary-deloitte-zrt-2943281',
     'https://www.profession.hu/allas/manual-tester-osr-ref-k-deutsche-telekom-tsi-hungary-kft-2943306',
     'https://www.profession.hu/allas/compiler-toolchain-engineer-high-tech-engineering-center-kft-2942002',
     'https://www.profession.hu/allas/wise-platform-enterprise-specialist-wise-payments-limited-magyarorszagi-fioktelepe-2935438',
     'https://www.profession.hu/allas/pl-sql-developer-pont-systems-zrt-2935465',
     'https://www.profession.hu/allas/software-engineer-java-mitigation-requirements-wise-payments-limited-magyarorszagi-fioktelepe-2935519',
     'https://www.profession.hu/allas/szoftver-architekt-agilexpert-szoftverfejleszto-es-tanacsado-kft-2924885',
     'https://www.profession.hu/allas/web-developer-general-mechatronics-kft-2924084/pro',
     'https://www.profession.hu/allas/szoftver-architekt-agilexpert-szoftverfejleszto-es-tanacsado-kft-2944170',
     'https://www.profession.hu/allas/embedded-software-engineer-functional-safety-adas-high-tech-engineering-center-kft-2941996'
   );

-- nofluffjobs (1)
UPDATE job_posts SET active = false, sweep_dead = true
 WHERE source = 'nofluffjobs'
   AND active = true
   AND url IN (
     'https://nofluffjobs.com/hu/job/openshift-platform-engineer-deutsche-telekom-tsi-hungary-kft--budapest'
   );

-- expect: 22 + 12 + 1 = 35 rows updated
SELECT source, count(*) FILTER (WHERE active) AS still_active, count(*) AS total
  FROM job_posts WHERE source IN ('talent','profession-intern','nofluffjobs') GROUP BY source;

COMMIT;
