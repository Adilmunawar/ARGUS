\set ON_ERROR_STOP on
\c postgres

GRANT pg_monitor TO argus_console;
GRANT pg_monitor TO argus_exporter;

ALTER ROLE argus_console SET default_transaction_read_only = on;
ALTER ROLE argus_exporter SET default_transaction_read_only = on;

ALTER ROLE argus_console SET statement_timeout = '30s';
ALTER ROLE argus_console SET idle_in_transaction_session_timeout = '60s';

ALTER ROLE argus_exporter SET idle_in_transaction_session_timeout = '60s';

REVOKE CONNECT ON DATABASE postgres, argus_geo, argus_ml, guacamole_db, grafana, argus_parity FROM PUBLIC;

GRANT CONNECT ON DATABASE postgres, argus_geo, argus_ml, guacamole_db, grafana, argus_parity
  TO argus_console, argus_exporter;

GRANT CONNECT ON DATABASE argus_parity TO argus_parity;

\c argus_geo
GRANT INSERT ON TABLE public.spatial_ref_sys TO argus_app;

\c argus_ml
GRANT INSERT ON TABLE public.spatial_ref_sys TO argus_app;

\c argus_parity

CREATE TABLE IF NOT EXISTS public.restart_canary (
  id                bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  written_at        timestamptz NOT NULL DEFAULT clock_timestamp(),
  server_started_at timestamptz NOT NULL DEFAULT pg_postmaster_start_time(),
  written_by        text        NOT NULL DEFAULT current_user,
  note              text
);

COMMENT ON TABLE public.restart_canary IS
  'Durability canary for parity-pg. A row whose server_started_at is older than the current pg_postmaster_start_time() proves data survived a postmaster restart. Created by platform/compose/sql/20-grants.sql; argus_parity may SELECT, INSERT and DELETE here and owns nothing.';
COMMENT ON COLUMN public.restart_canary.server_started_at IS
  'pg_postmaster_start_time() as it was when this row was written. Compare with the current value to tell a survived row from a fresh one.';
COMMENT ON COLUMN public.restart_canary.note IS
  'Free text for whoever wrote the row. Never parsed.';

GRANT USAGE ON SCHEMA public TO argus_parity;

GRANT SELECT, INSERT, DELETE ON TABLE public.restart_canary TO argus_parity;

DO $$
DECLARE bad text;
BEGIN
  SELECT string_agg(format('%s cannot CONNECT to %s', t.who, t.db), chr(10) || '  ' ORDER BY t.who, t.db)
    INTO bad
  FROM (VALUES
    ('argus_console',  'postgres'),
    ('argus_console',  'argus_geo'),
    ('argus_console',  'argus_ml'),
    ('argus_console',  'guacamole_db'),
    ('argus_console',  'grafana'),
    ('argus_console',  'argus_parity'),
    ('argus_exporter', 'postgres'),
    ('argus_exporter', 'argus_geo'),
    ('argus_exporter', 'argus_ml'),
    ('argus_exporter', 'guacamole_db'),
    ('argus_exporter', 'grafana'),
    ('argus_exporter', 'argus_parity'),
    ('argus_app',      'argus_geo'),
    ('argus_app',      'argus_ml'),
    ('guacamole_user', 'guacamole_db'),
    ('grafana',        'grafana'),
    ('argus_parity',   'argus_parity')
  ) AS t(who, db)
  WHERE NOT has_database_privilege(t.who, t.db, 'CONNECT');

  IF bad IS NOT NULL THEN
    RAISE EXCEPTION E'CONNECT is missing where this file grants it:\n  %', bad;
  END IF;
END
$$;

DO $$
DECLARE bad text;
BEGIN
  SELECT string_agg(format('%s does not inherit pg_monitor', t.who), chr(10) || '  ' ORDER BY t.who)
    INTO bad
  FROM (VALUES ('argus_console'), ('argus_exporter')) AS t(who)
  WHERE NOT pg_has_role(t.who, 'pg_monitor', 'USAGE');

  IF bad IS NOT NULL THEN
    RAISE EXCEPTION E'pg_monitor was granted but does not take effect:\n  %', bad;
  END IF;
END
$$;

DO $$
DECLARE bad text;
BEGIN
  SELECT string_agg(format('%s on %s for %s should be %s', t.priv, t.rel, t.who, t.want), chr(10) || '  ')
    INTO bad
  FROM (VALUES
    ('argus_parity',   'public.restart_canary', 'SELECT', true),
    ('argus_parity',   'public.restart_canary', 'INSERT', true),
    ('argus_parity',   'public.restart_canary', 'DELETE', true),
    ('argus_parity',   'public.restart_canary', 'UPDATE', false),
    ('argus_console',  'public.restart_canary', 'SELECT', false),
    ('argus_exporter', 'public.restart_canary', 'SELECT', false)
  ) AS t(who, rel, priv, want)
  WHERE has_table_privilege(t.who, t.rel, t.priv) <> t.want;

  IF bad IS NOT NULL THEN
    RAISE EXCEPTION E'the canary table is not granted as intended:\n  %', bad;
  END IF;
END
$$;

SELECT p.datname AS database,
       pg_get_userbyid(p.datdba) AS owner,
       has_database_privilege('argus_console', p.datname, 'CONNECT') AS console,
       has_database_privilege('argus_exporter', p.datname, 'CONNECT') AS exporter,
       has_database_privilege('argus_app', p.datname, 'CONNECT') AS app,
       has_database_privilege('argus_parity', p.datname, 'CONNECT') AS parity
FROM pg_database p
WHERE p.datname IN ('postgres', 'argus_geo', 'argus_ml', 'guacamole_db', 'grafana', 'argus_parity')
ORDER BY 1;
