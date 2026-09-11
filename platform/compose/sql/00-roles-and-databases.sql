-- ============================================================================
--  00-roles-and-databases.sql -- every login role and every database, once.
--
--  WHERE THIS RUNS
--    platform/compose/docker-compose.yml, service `pg-init`. It mounts ./sql
--    read-only at /sql and runs, in this order and only these three:
--        psql -f /sql/00-roles-and-databases.sql
--     && psql -f /sql/10-extensions.sql
--     && psql -f /sql/20-grants.sql
--    as the superuser, with ON_ERROR_STOP=1. A fourth file in this directory
--    would never execute until that command changes, so everything this
--    platform needs from Postgres has to fit in these three.
--
--  IT RUNS ON EVERY BOOT, NOT ONCE
--    `docker compose up -d` restarts an exited one-shot, so this file executes
--    again on the second boot, the tenth, and after every Windows restart. A
--    bare CREATE ROLE or CREATE DATABASE fails the second time, pg-init exits
--    non-zero, and everything gated on service_completed_successfully --
--    guacamole, parity-pg -- never starts again. So nothing here may error on
--    a cluster where all of it already exists, and nothing here may undo work
--    a previous boot did.
--
--  IT MUST NOT RESET A PASSWORD SOMETHING IS ALREADY USING
--    An existing role keeps the password it has. Re-applying the .env value on
--    every boot looks harmless and is not: pg_exporter_password is ALSO a
--    Compose file-secret (postgres-exporter reads the file, this file reads the
--    environment), a human may have rotated a role by hand, and a half-applied
--    rotation presents as "password authentication failed" against a server
--    that is perfectly healthy. Rotation is therefore a deliberate act, never a
--    side effect of a reboot:
--
--        docker compose run --rm -e ARGUS_PG_ROTATE_PASSWORDS=1 pg-init
--
--    That flag is read below. It is passed at run time, so no file changes and
--    no password ever reaches a command line. After rotating, restart the
--    consumers so they pick the new value up from .env.
--
--    HONEST LIMIT: this file cannot TELL you that .env and the cluster have
--    drifted apart. Verifying a plaintext against a stored SCRAM verifier needs
--    PBKDF2, which no extension in this image exposes, so a role whose password
--    no longer matches .env is indistinguishable from one that does until
--    something tries to log in. The NOTICE printed per existing role is the
--    only warning there is.
--
--  ── HOW A PASSWORD GETS FROM THE ENVIRONMENT INTO A ROLE ──────────────────
--
--  Three constraints, and exactly one route satisfies all of them.
--
--   1. NOT ON A COMMAND LINE. argv is world-readable through /proc and lands in
--      shell history: `psql -c "CREATE ROLE ... PASSWORD 'x'"` publishes it to
--      every process on the box. This is why pg-init exports PGPASSWORD from a
--      file secret rather than passing it as an argument, and the same rule
--      applies to everything below.
--
--   2. NOT AS A LITERAL IN THE SQL TEXT. Measured on this stack, not assumed.
--      pg_stat_statements.track_utility is on (the default), and utility
--      statements are NOT normalised, so
--          CREATE ROLE zz LOGIN PASSWORD 'canary';
--      is stored VERBATIM and
--          SELECT query FROM pg_stat_statements WHERE query LIKE '%canary%';
--      returns it. argus_console and argus_exporter both hold pg_monitor, which
--      carries pg_read_all_stats, so both could read every password this file
--      sets by selecting from a monitoring view.
--
--   3. psql DOES NOT SUBSTITUTE :'var' INSIDE A DOLLAR-QUOTED BLOCK. Also
--      measured: `DO $$ BEGIN ... :'pw' ... END $$;` is a syntax error at ":",
--      because psql treats $$...$$ as a quoted string and interpolates nothing
--      inside it. The obvious "read it with \getenv, paste it into the DO
--      block" does not work at all.
--
--  The route that satisfies all three: \getenv into a psql variable, one
--  set_config() to park it in a session GUC, current_setting() inside the DO
--  block, and format(%L) to quote it into the CREATE ROLE. The only statement
--  whose text ever contains the plaintext is `SELECT set_config($1, $2, $3)` --
--  an ordinary SELECT, whose constants pg_stat_statements DOES normalise into
--  parameter placeholders. No password appears anywhere in pg_stat_statements.
--
--  HONEST LIMIT: the plaintext still crosses the connection and exists in the
--  statement text the server parses, so a log line that quotes a failing
--  statement could capture it. log_statement is `none` here and
--  log_min_duration_statement is 1000 ms while these complete in microseconds,
--  so nothing writes it to disk today -- but that is a configuration away from
--  being untrue. Removing even that means computing the SCRAM-SHA-256 verifier
--  in bootstrap.ps1 and sending that instead (CREATE ROLE accepts a verifier in
--  place of a password), which is a change to bootstrap, not to this file.
-- ============================================================================

-- Compose passes -v ON_ERROR_STOP=1. This line is for the human who runs the
-- file by hand and forgets it: without it psql prints the error, carries on to
-- the next statement, and exits 0 -- a boot that reports success having created
-- nothing.
\set ON_ERROR_STOP on

-- ── the six passwords, from the environment ─────────────────────────────────
--
-- Each variable is seeded empty first. \getenv leaves a psql variable UNCHANGED
-- when the environment variable does not exist (measured), and an undefined
-- psql variable is left in the query as the literal text :'pw_app', which fails
-- with a syntax error naming neither the variable nor the missing environment.
-- Seeded empty, the same mistake reaches the guard below and gets a sentence
-- that says which variable to set.
\set pw_app ''
\set pw_console ''
\set pw_exporter ''
\set pw_guac ''
\set pw_grafana ''
\set pw_parity ''
\set rotate ''

\getenv pw_app ARGUS_PG_APP_PASSWORD
\getenv pw_console ARGUS_PG_CONSOLE_PASSWORD
\getenv pw_exporter ARGUS_PG_EXPORTER_PASSWORD
\getenv pw_guac ARGUS_PG_GUAC_PASSWORD
\getenv pw_grafana ARGUS_PG_GRAFANA_PASSWORD
\getenv pw_parity ARGUS_PG_PARITY_PASSWORD
\getenv rotate ARGUS_PG_ROTATE_PASSWORDS

-- set_config() RETURNS the value it just set, and psql prints query results to
-- stdout -- which here is `docker compose logs pg-init`, retained by the json
-- file log driver. Printing six plaintext passwords into the container log
-- would undo everything the header just argued for, so each result is reduced
-- to a boolean and the value itself is never rendered.
--
-- `IS NOT NULL` rather than hiding the calls in a subquery whose columns
-- nothing selects: this form does not depend on how the planner treats an
-- output column no one reads. Each call is consumed by the expression around
-- it, so it is evaluated for certain. The failure it avoids: a set_config()
-- that never ran leaves the password empty, and the guard below then blames
-- the environment for something this statement did.
SELECT set_config('argus.pw_app', :'pw_app', false) IS NOT NULL AS app_read,
       set_config('argus.pw_console', :'pw_console', false) IS NOT NULL AS console_read,
       set_config('argus.pw_exporter', :'pw_exporter', false) IS NOT NULL AS exporter_read,
       set_config('argus.pw_guac', :'pw_guac', false) IS NOT NULL AS guacamole_read,
       set_config('argus.pw_grafana', :'pw_grafana', false) IS NOT NULL AS grafana_read,
       set_config('argus.pw_parity', :'pw_parity', false) IS NOT NULL AS parity_read,
       set_config('argus.rotate_passwords', :'rotate', false) IS NOT NULL AS rotate_flag_read;

-- Separately, and as its own truth: every column above says only that the
-- statement ran. This one says what the run will actually do, because a `t`
-- under a column called `rotate` in a boot log is exactly the kind of thing an
-- operator reads as "it rotated" at 3am.
SELECT coalesce(current_setting('argus.rotate_passwords', true), '') = '1' AS rotating_passwords;

-- ── the roles ───────────────────────────────────────────────────────────────
--
--   argus_app       owns argus_geo and argus_ml. The only role in this cluster
--                   that reads and writes application data.
--   argus_console   the console's read side. pg_monitor plus explicit CONNECT,
--                   default_transaction_read_only, and no privilege on a single
--                   user table anywhere (20-grants.sql).
--   argus_exporter  postgres-exporter. pg_monitor and nothing else at all.
--   guacamole_user  owns guacamole_db, where Guacamole keeps its own schema.
--   grafana         owns the grafana database, which Grafana migrates itself.
--   argus_parity    the restart canary. One table, in one database it does not
--                   own.
--
-- Attributes are spelled out rather than left to CREATE ROLE's defaults,
-- because two of them are load-bearing and one is a trap:
--
--   LOGIN     -- all six authenticate over TCP; NOLOGIN roles cannot.
--   INHERIT   -- the trap. With NOINHERIT, `GRANT pg_monitor TO argus_console`
--                grants nothing until the session issues SET ROLE, so the
--                console would authenticate, find pg_stat_activity empty of
--                everything but itself, and report a healthy database with no
--                connections. Same class of failure as the missing CONNECT.
--   the NO*   -- no superuser, no CREATEDB, no CREATEROLE, no replication, no
--                RLS bypass. These are the defaults today; written out so that
--                a future default change cannot quietly widen them.
DO $$
DECLARE
  spec   record;
  rotate boolean := coalesce(current_setting('argus.rotate_passwords', true), '') = '1';
  pw     text;
BEGIN
  FOR spec IN
    SELECT * FROM (VALUES
      ('argus_app',      'argus.pw_app',      'ARGUS_PG_APP_PASSWORD'),
      ('argus_console',  'argus.pw_console',  'ARGUS_PG_CONSOLE_PASSWORD'),
      ('argus_exporter', 'argus.pw_exporter', 'ARGUS_PG_EXPORTER_PASSWORD'),
      ('guacamole_user', 'argus.pw_guac',     'ARGUS_PG_GUAC_PASSWORD'),
      ('grafana',        'argus.pw_grafana',  'ARGUS_PG_GRAFANA_PASSWORD'),
      ('argus_parity',   'argus.pw_parity',   'ARGUS_PG_PARITY_PASSWORD')
    ) AS t(role_name, pw_setting, env_var)
  LOOP
    pw := coalesce(current_setting(spec.pw_setting, true), '');

    -- Compose already refuses to start pg-init with any of these unset
    -- (${VAR:?run bootstrap.ps1}), so this fires only when the file is run by
    -- hand. An empty password would otherwise create a role that authenticates
    -- with the empty string, which is worse than not booting.
    IF pw = '' THEN
      RAISE EXCEPTION '% is empty, so role % cannot be created. Run bootstrap.ps1, or export it before running this file by hand.',
        spec.env_var, spec.role_name;
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = spec.role_name) THEN
      EXECUTE format(
        'CREATE ROLE %I LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD %L',
        spec.role_name, pw);
      RAISE NOTICE 'created role % (password from %)', spec.role_name, spec.env_var;

    ELSIF rotate THEN
      -- Opt-in, and only ever opt-in. See the header.
      EXECUTE format('ALTER ROLE %I PASSWORD %L', spec.role_name, pw);
      RAISE NOTICE 'ROTATED the password of % to the current value of %. Restart every service that uses it.',
        spec.role_name, spec.env_var;

    ELSE
      RAISE NOTICE 'role % already exists; its password was NOT changed (set ARGUS_PG_ROTATE_PASSWORDS=1 to rotate)',
        spec.role_name;
    END IF;
  END LOOP;
END
$$;

-- ── the databases ───────────────────────────────────────────────────────────
--
-- One list, used twice: once to create what is missing, once to repair an
-- owner that drifted. Written to a temp table rather than repeated, because two
-- copies of a list like this diverge and the second copy is the one nobody
-- reads. The temp table lives as long as this psql session, which is as long as
-- this file.
--
-- OWNERSHIP IS THE PRIVILEGE MODEL HERE. Since PostgreSQL 15 the `public`
-- schema is owned by pg_database_owner and grants CREATE to nobody else
-- (measured on this server: nspacl is
-- {pg_database_owner=UC/pg_database_owner,=U/pg_database_owner}). So the owner
-- of a database can create tables in it and no other non-superuser can --
-- which is exactly the boundary wanted between argus_app, guacamole_user and
-- grafana, with no GRANT statements at all.
--
-- argus_parity is deliberately owned by the SUPERUSER, not by argus_parity. The
-- parity harness gets one table, granted explicitly in 20-grants.sql; making it
-- the database owner would hand it CREATE on the schema and turn "a canary"
-- into "anything it likes".
CREATE TEMP TABLE argus_database (name text PRIMARY KEY, owner text NOT NULL);
INSERT INTO argus_database (name, owner) VALUES
  ('argus_geo',    'argus_app'),
  ('argus_ml',     'argus_app'),
  ('guacamole_db', 'guacamole_user'),
  ('grafana',      'grafana'),
  ('argus_parity', 'postgres');

-- CREATE DATABASE has no IF NOT EXISTS and cannot run inside a transaction
-- block, which rules out both a DO block and a plain guard. \gexec is the
-- idiom: the SELECT produces zero rows on a cluster where everything exists,
-- and psql executes zero statements.
--
-- No TEMPLATE clause. This image ships a `template_postgis` database and
-- creating from it would be faster, but it carries postgis_tiger_geocoder --
-- a large US-only geocoding schema, its own search_path convention, and
-- thousands of catalogue rows -- into every database made that way. PostGIS is
-- added explicitly in 10-extensions.sql instead, so what is installed is what
-- was asked for.
SELECT format('CREATE DATABASE %I OWNER %I', d.name, d.owner)
FROM argus_database d
WHERE NOT EXISTS (SELECT 1 FROM pg_database p WHERE p.datname = d.name)
ORDER BY d.name
\gexec

-- Repair, not creation. A database created by hand (or by an older version of
-- this file) is owned by whoever ran the command, and an argus_geo owned by
-- postgres leaves argus_app unable to create a table in its own database. That
-- failure surfaces much later, inside application code, as a bare permission
-- error on the public schema. Zero rows when the owners are already right.
SELECT format('ALTER DATABASE %I OWNER TO %I', d.name, d.owner)
FROM argus_database d
JOIN pg_database p ON p.datname = d.name
WHERE pg_get_userbyid(p.datdba) <> d.owner
ORDER BY d.name
\gexec

-- ── what this file deliberately does NOT create ─────────────────────────────
--
-- The header of docker-compose.yml also names `argus_console_events` and
-- `pgstac`. Neither is created here, and that is a decision rather than an
-- oversight:
--
--   argus_console_events -- nothing writes it yet. There is no schema for it in
--     this repository, and argus_console is read-only by design, so an empty
--     database would appear on the console's own database screen as a real
--     store that has never been used. Add it here together with the migration
--     that gives it tables and the role that is allowed to write them.
--
--   pgstac -- needs the `pgstac` extension, which this image does not ship
--     (pg_available_extensions on postgis/postgis:17-3.5 lists postgis,
--     postgis_raster, postgis_topology, postgis_tiger_geocoder,
--     address_standardizer, fuzzystrmatch, btree_gist, citext, pgcrypto,
--     uuid-ossp, pg_stat_statements and nothing else). Creating the database
--     without the extension would produce a STAC catalogue that cannot answer a
--     single query. It needs a different image, which is an ADR.
--
-- Per-role work_mem is also deliberately absent. docker-compose.yml keeps the
-- global work_mem at 8MB and invites raising it per role, but no workload here
-- has been measured yet, and a number nobody measured is exactly what this
-- estate refuses to display. When there is a query to point at:
--     ALTER ROLE argus_app SET work_mem = '<measured>';

-- What the boot converged to, in the pg-init log, so an operator never has to
-- guess whether this ran.
SELECT p.datname AS database,
       pg_get_userbyid(p.datdba) AS owner,
       pg_encoding_to_char(p.encoding) AS encoding
FROM pg_database p
JOIN argus_database d ON d.name = p.datname
ORDER BY 1;

SELECT r.rolname AS role,
       r.rolcanlogin AS can_login,
       r.rolsuper AS superuser,
       r.rolcreatedb AS createdb,
       r.rolcreaterole AS createrole
FROM pg_roles r
WHERE r.rolname IN ('argus_app', 'argus_console', 'argus_exporter',
                    'guacamole_user', 'grafana', 'argus_parity')
ORDER BY 1;
