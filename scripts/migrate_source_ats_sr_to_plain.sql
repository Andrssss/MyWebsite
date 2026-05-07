-- Migrate SmartRecruiters source keys to plain names.
-- Old: ats-sr-wise, ats-sr-roland
-- New: wise, roland

BEGIN;

UPDATE job_posts
SET source = 'wise'
WHERE source = 'ats-sr-wise';

UPDATE job_posts
SET source = 'roland'
WHERE source = 'ats-sr-roland';

COMMIT;

-- Optional verification:
-- SELECT source, COUNT(*)
-- FROM job_posts
-- WHERE source IN ('wise', 'roland', 'ats-sr-wise', 'ats-sr-roland')
-- GROUP BY source
-- ORDER BY source;
