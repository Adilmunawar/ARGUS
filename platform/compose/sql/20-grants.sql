-- ============================================================================
--  20-grants.sql -- who may reach what, and the one table this platform owns.
--
--  Runs last, on every boot, as the superuser. GRANT and REVOKE are naturally
--  idempotent -- re-granting an existing privilege is a no-op, not an error --
--  so the whole file is safe to re-run, and it is written to converge rather
--  than to assume: it repairs a privilege somebody removed by hand instead of
--  noticing nothing is wrong.
--
--  ── THE FAILURE THIS FILE EXISTS TO PREVENT ────────────────────────────────
--
--  pg_monitor DOES NOT IMPLY CONNECT.
--
--  It is a role holding pg_read_all_settings, pg_read_all_stats and
--  pg_stat_scan_tables -- permission to READ a database's statistics once you
--  are inside it. It says nothing about being let in. Every database below has
--  CONNECT revoked from PUBLIC (see the next section), so a console granted
--  pg_monitor and nothing else authenticates perfectly, then fails at the door
--  of every database with
--
--      FATAL:  permission denied for database "argus_geo"
--      DETAIL:  User does not have CONNECT privilege.
--
--  which names neither pg_monitor nor the grant that is missing. What the
--  operator sees is a console that logged in and lists no databases, no
--  extensions and no activity -- a cluster that looks empty rather than one
--  that refused. So both are granted here, explicitly, and asserted at the
--  bottom of this file: if either one ever stops being true, pg-init fails the
--  boot instead of handing over a console full of blanks.
--
--  ── WHAT IS DELIBERATELY NOT GRANTED ───────────────────────────────────────
--
--  No role here gets SELECT on a single application table. Not argus_console,
--  not argus_exporter. That is not caution for its own sake: guacamole_db holds
--  the credentials Guacamole injects into remote sessions, and the grafana
--  database holds datasource secrets, so a monitoring role with table-level
--  read across this cluster IS a credential store with a web front end. The
--  console shows sizes, connections, locks and query timings -- all of which
--  pg_monitor provides without touching a row of data.
--
--  No ALTER DEFAULT PRIVILEGES either. Objects argus_app creates later stay
--  readable by argus_app alone, on purpose: a default privilege is a decision
--  taken now about tables nobody has designed yet.
--
--  HONEST LIMIT: pg_monitor carries
--  pg_read_all_stats, and pg_read_all_stats can read QUERY TEXT -- in
--  pg_stat_activity, and in pg_stat_statements. argus_console and
--  argus_exporter therefore see the SQL every other role runs, including any
--  literal embedded in it. They cannot read table contents; they can read
--  anything a query carries in its text. This is a property of pg_monitor, not
--  a choice made here, and there is no version of "postgres-exporter that
--  reports slow queries" without it. The consequence is a rule for everything
--  else that touches this cluster: a secret is never a literal in a statement.
--  00-roles-and-databases.sql obeys that rule for the passwords it sets, and it
--  had to be built a particular way to do so -- see its header.
-- ============================================================================

\set ON_ERROR_STOP on
\c postgres

-- ── the monitoring roles ────────────────────────────────────────────────────
--
-- Granting a role membership twice is a no-op with a NOTICE, so this converges.
-- It only works because both roles were created with INHERIT: a NOINHERIT role
-- holds this membership without holding its privileges until it issues SET
-- ROLE, which no exporter and no connection pool ever does. That is asserted at
-- the bottom of this file with pg_has_role(..., 'USAGE'), not 'MEMBER' --
-- 'MEMBER' would pass in exactly the broken case.
GRANT pg_monitor TO argus_console;
GRANT pg_monitor TO argus_exporter;

-- ── how read-only the read-only roles actually are ──────────────────────────
--
-- default_transaction_read_only makes an accidental write fail with a sentence
-- an operator can act on ("cannot execute INSERT in a read-only transaction")
-- instead of a permission error that reads like a misconfiguration.
--
-- HONEST LIMIT: it is a DEFAULT, not a privilege. Any session may issue
-- `BEGIN READ WRITE` and undo it. The actual guarantee that the console cannot
-- change anything in this cluster is that it holds no INSERT, UPDATE or DELETE
-- privilege on any object -- pg_monitor grants none -- backed by the API
-- refusing every non-GET verb with 405 while ARGUS_ALLOW_WRITES is 0. Two real
-- layers; this setting is a third thing entirely, a good error message.
ALTER ROLE argus_console SET default_transaction_read_only = on;
ALTER ROLE argus_exporter SET default_transaction_read_only = on;

-- A monitoring query that never finishes holds its snapshot open, and an open
-- snapshot stops vacuum from removing dead rows ACROSS THE WHOLE CLUSTER.
-- 30 s is above ARGUS_UPSTREAM_TIMEOUT_MS (8000), so any query that
-- reaches this limit is one the console already gave up waiting for.
ALTER ROLE argus_console SET statement_timeout = '30s';
ALTER ROLE argus_console SET idle_in_transaction_session_timeout = '60s';

-- The exporter gets the idle-in-transaction guard for the same reason, but NO
-- statement_timeout: a scrape query killed mid-flight produces a series that
-- silently stops existing, which is the failure mode hardest to notice on a
-- dashboard. It already has its own per-scrape deadline, and a slow scrape is
-- visible as a slow scrape.
ALTER ROLE argus_exporter SET idle_in_transaction_session_timeout = '60s';

-- ── who may open a connection to what ───────────────────────────────────────
--
-- A database created with no ACL grants CONNECT and TEMPORARY to PUBLIC, which
-- means every role in this cluster can open every database by default --
-- guacamole_user could read Grafana's session tokens, grafana could read
-- Guacamole's connection parameters. Revoking PUBLIC is what makes the grants
-- below mean something.
--
-- The OWNERS are not listed in the GRANT and do not need to be. Revoking
-- PUBLIC's CONNECT materialises the default ACL as
-- {owner=CTc/owner,=T/owner}: the owner keeps CREATE, TEMP and CONNECT through
-- its own entry. That is asserted at the bottom of this file rather than
-- assumed, because if it were ever untrue Grafana and Guacamole would both fail
-- to start with a message about the database rather than about a privilege.
--
-- TEMPORARY is left alone. It is only reachable by a role that can already
-- connect, and revoking it breaks ordinary owner tooling (pg_dump with
-- temp-table workspaces, any migration that stages into a temp table) in
-- exchange for closing nothing the CONNECT revocation left open.
REVOKE CONNECT ON DATABASE postgres, argus_geo, argus_ml, guacamole_db, grafana, argus_parity FROM PUBLIC;

-- The console and the exporter both need every database: the console renders
-- the estate, and postgres-exporter runs --auto-discover-databases, which
-- enumerates pg_database and then opens each one it is allowed to.
--
-- NOTE FOR WHOEVER WRITES THE CONSOLE'S POSTGRES READER: docker-compose.yml
-- gives the console ARGUS_PG_HOST, ARGUS_PG_USER and ARGUS_PG_PASSWORD and no
-- database at all. Both libpq and node-postgres default an unset database name
-- to the USER name, so a client that does not name one will try to open a
-- database called "argus_console" -- which does not exist here and is not going
-- to. Connect to `postgres` explicitly; everything cluster-wide (pg_database,
-- pg_stat_activity, pg_database_size, sizes and connection counts for every
-- other database) is visible from there, and the per-database grants above are
-- for the queries that genuinely have to run inside one.
GRANT CONNECT ON DATABASE postgres, argus_geo, argus_ml, guacamole_db, grafana, argus_parity
  TO argus_console, argus_exporter;

-- argus_parity connects to exactly one database, which it does not own.
GRANT CONNECT ON DATABASE argus_parity TO argus_parity;

-- ── argus_app and the EPSG catalogue ────────────────────────────────────────
--
-- spatial_ref_sys belongs to the postgis extension, so it is owned by the
-- superuser and argus_app cannot write it even in a database argus_app owns. A
-- survey flown on a project-specific grid needs its SRID inserted before a
-- single geometry can be loaded, and that request always arrives mid-import,
-- out of hours, from somebody who does not have a superuser password.
--
-- INSERT only. No UPDATE and no DELETE: editing a row that is already in use
-- silently changes the meaning of every geometry ever stored against that SRID,
-- and nothing in the data records that it happened. Adding a new SRID is
-- additive and reversible; changing an existing one is neither.
\c argus_geo
GRANT INSERT ON TABLE public.spatial_ref_sys TO argus_app;

\c argus_ml
GRANT INSERT ON TABLE public.spatial_ref_sys TO argus_app;

-- ── the restart canary ──────────────────────────────────────────────────────
--
-- This table is created here, in the grants file, because pg-init runs
-- exactly three files (see the header of
-- 00-roles-and-databases.sql) and a 30-*.sql would never execute until
-- docker-compose.yml changes. It sits next to the grant that is its entire
-- purpose.
--
-- WHAT IT PROVES. parity-pg writes a row every 900 s and asks one question that
-- no health check can answer: did the bytes this cluster acknowledged actually
-- survive the process that wrote them? A row whose server_started_at is EARLIER
-- than the current pg_postmaster_start_time() was written by a postmaster that
-- has since died -- so the data outlived the process, on this volume, with
-- these fsync settings. A row younger than that proves only that the database
-- accepts writes.
--
-- THE CONTRACT WITH parity-pg, both halves of it.
--
--   Every column has a default, so the whole row is
--       INSERT INTO public.restart_canary DEFAULT VALUES;
--   and the prover never has to know the column list. Adding a column with a
--   default is compatible; renaming one is not.
--
--   The prover must NOT try to create this table. Measured, because the
--   opposite is the natural thing to write: CREATE TABLE IF NOT EXISTS checks
--   CREATE on the schema BEFORE it notices the table is already there, so as
--   argus_parity it fails with "permission denied for schema public" -- an
--   error about creating a table that exists, raised against a role that only
--   ever needed to insert into it. The table is created here, once, by the
--   superuser, and 20-grants.sql runs before anything that uses it.
\c argus_parity

CREATE TABLE IF NOT EXISTS public.restart_canary (
  -- GENERATED ALWAYS AS IDENTITY, not serial. An identity column's sequence is
  -- owned by the column and needs no privilege of its own, whereas serial needs
  -- a separate GRANT USAGE ON SEQUENCE -- the classic reason a role that was
  -- granted INSERT still gets "permission denied for sequence" on its first
  -- write, months after the grant was reviewed.
  id                bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  -- clock_timestamp(), not now(): now() is the transaction start time, and two
  -- rows written in one transaction would carry an identical timestamp while
  -- claiming to be separate observations.
  written_at        timestamptz NOT NULL DEFAULT clock_timestamp(),
  -- The whole point of the table. Recorded at write time, so a later reader can
  -- compare it against pg_postmaster_start_time() without having kept any state
  -- of its own.
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

-- USAGE on the schema is granted explicitly even though PUBLIC already holds it
-- on this server (public.nspacl is {pg_database_owner=UC/...,=U/...}). If a
-- later hardening pass revokes USAGE from PUBLIC -- a normal thing to do -- the
-- canary keeps working, and the reason it may reach this schema is written down
-- rather than inherited from a default that has changed twice in five major
-- versions.
GRANT USAGE ON SCHEMA public TO argus_parity;

-- SELECT, INSERT, DELETE. Deliberately NO UPDATE: a canary row is evidence, and
-- a prover that can rewrite its own evidence proves nothing. DELETE is granted
-- because parity-pg writes a row every 900 s forever and something has to prune
-- it -- roughly 3500 rows a month, which is small but not bounded.
--
-- THE PRUNING RULE, which cannot be expressed as a privilege: never delete the
-- oldest row of a generation. Keep at least one row for each distinct
-- server_started_at, or the first prune after a restart deletes the only row
-- that proved anything.
GRANT SELECT, INSERT, DELETE ON TABLE public.restart_canary TO argus_parity;

-- ── assertions ──────────────────────────────────────────────────────────────
--
-- Everything above is a statement that succeeds whether or not it achieved
-- anything: GRANT on a database that a later REVOKE undoes, a membership that
-- does not inherit, an owner that quietly lost CONNECT. These blocks re-read
-- the catalogue and fail the boot if the intent did not land -- which is the
-- difference between a broken cluster discovered here, in pg-init's exit code,
-- and one discovered by an operator staring at an empty console.

DO $$
DECLARE bad text;
BEGIN
  SELECT string_agg(format('%s cannot CONNECT to %s', t.who, t.db), chr(10) || '  ' ORDER BY t.who, t.db)
    INTO bad
  FROM (VALUES
    -- the two monitoring roles: everywhere
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
    -- the owners, through their own ACL entry and nothing else
    ('argus_app',      'argus_geo'),
    ('argus_app',      'argus_ml'),
    ('guacamole_user', 'guacamole_db'),
    ('grafana',        'grafana'),
    -- and the canary, which owns nothing at all
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
  -- 'USAGE', not 'MEMBER'. MEMBER is true for a NOINHERIT role that holds the
  -- membership but none of its privileges -- exactly the case that produces a
  -- console which authenticates and then sees nothing.
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
  -- Both directions. The negatives matter as much as the positives: they are
  -- the invariants that would otherwise erode one convenient grant at a time.
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

-- The connect matrix, in the pg-init log, so the answer to "can the console see
-- argus_ml" is a line an operator can read rather than a thing to go and test.
SELECT p.datname AS database,
       pg_get_userbyid(p.datdba) AS owner,
       has_database_privilege('argus_console', p.datname, 'CONNECT') AS console,
       has_database_privilege('argus_exporter', p.datname, 'CONNECT') AS exporter,
       has_database_privilege('argus_app', p.datname, 'CONNECT') AS app,
       has_database_privilege('argus_parity', p.datname, 'CONNECT') AS parity
FROM pg_database p
WHERE p.datname IN ('postgres', 'argus_geo', 'argus_ml', 'guacamole_db', 'grafana', 'argus_parity')
ORDER BY 1;
