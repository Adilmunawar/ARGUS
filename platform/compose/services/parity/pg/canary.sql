\set ON_ERROR_STOP on

BEGIN;

INSERT INTO public.restart_canary DEFAULT VALUES;

DELETE FROM public.restart_canary
WHERE id IN (
  SELECT id
  FROM (
    SELECT id,
           row_number() OVER (PARTITION BY server_started_at
                              ORDER BY written_at, id) AS rank_in_generation,
           row_number() OVER (ORDER BY written_at DESC, id DESC) AS recency
    FROM public.restart_canary
  ) ranked
  WHERE rank_in_generation > 1
    AND recency > 500
);

COMMIT;

SELECT json_build_object(
  'generatedAt', to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
  'database', current_database(),
  'writtenBy', current_user,
  'serverStartedAt', to_char(pg_postmaster_start_time() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
  'serverVersion', current_setting('server_version'),
  'durability', json_build_object(
    'survivedRestart', EXISTS (
      SELECT 1 FROM public.restart_canary
      WHERE server_started_at < pg_postmaster_start_time()
    ),
    'generationsRecorded', (SELECT count(DISTINCT server_started_at) FROM public.restart_canary),
    'restartsProven', (
      SELECT count(DISTINCT server_started_at) FROM public.restart_canary
      WHERE server_started_at < pg_postmaster_start_time()),
    'oldestSurvivingWrite', (
      SELECT to_char(min(written_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
      FROM public.restart_canary
      WHERE server_started_at < pg_postmaster_start_time()),
    'latestWrite', (
      SELECT to_char(max(written_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
      FROM public.restart_canary),
    'rowsRetained', (SELECT count(*) FROM public.restart_canary)
  ),
  'settings', json_build_object(
    'fsync', current_setting('fsync'),
    'synchronousCommit', current_setting('synchronous_commit'),
    'fullPageWrites', current_setting('full_page_writes'),
    'walLevel', current_setting('wal_level'),
    'dataChecksums', current_setting('data_checksums')
  ),
  'extensions', COALESCE((
    SELECT json_agg(json_build_object('name', extname, 'version', extversion) ORDER BY extname)
    FROM pg_extension), '[]'::json)
)::text;
