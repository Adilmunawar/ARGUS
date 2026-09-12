\set ON_ERROR_STOP on

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

SELECT set_config('argus.pw_app', :'pw_app', false) IS NOT NULL AS app_read,
       set_config('argus.pw_console', :'pw_console', false) IS NOT NULL AS console_read,
       set_config('argus.pw_exporter', :'pw_exporter', false) IS NOT NULL AS exporter_read,
       set_config('argus.pw_guac', :'pw_guac', false) IS NOT NULL AS guacamole_read,
       set_config('argus.pw_grafana', :'pw_grafana', false) IS NOT NULL AS grafana_read,
       set_config('argus.pw_parity', :'pw_parity', false) IS NOT NULL AS parity_read,
       set_config('argus.rotate_passwords', :'rotate', false) IS NOT NULL AS rotate_flag_read;

SELECT coalesce(current_setting('argus.rotate_passwords', true), '') = '1' AS rotating_passwords;

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

CREATE TEMP TABLE argus_database (name text PRIMARY KEY, owner text NOT NULL);
INSERT INTO argus_database (name, owner) VALUES
  ('argus_geo',    'argus_app'),
  ('argus_ml',     'argus_app'),
  ('guacamole_db', 'guacamole_user'),
  ('grafana',      'grafana'),
  ('argus_parity', 'postgres');

SELECT format('CREATE DATABASE %I OWNER %I', d.name, d.owner)
FROM argus_database d
WHERE NOT EXISTS (SELECT 1 FROM pg_database p WHERE p.datname = d.name)
ORDER BY d.name
\gexec

SELECT format('ALTER DATABASE %I OWNER TO %I', d.name, d.owner)
FROM argus_database d
JOIN pg_database p ON p.datname = d.name
WHERE pg_get_userbyid(p.datdba) <> d.owner
ORDER BY d.name
\gexec

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
