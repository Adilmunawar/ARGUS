\set ON_ERROR_STOP on

\c postgres
CREATE EXTENSION IF NOT EXISTS pg_stat_statements;
SELECT current_database() AS database,
       string_agg(extname || ' ' || extversion, ', ' ORDER BY extname) AS extensions
FROM pg_extension;

\c argus_geo
CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS pg_stat_statements;
SELECT current_database() AS database,
       string_agg(extname || ' ' || extversion, ', ' ORDER BY extname) AS extensions
FROM pg_extension;

\c argus_ml
CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS pg_stat_statements;
SELECT current_database() AS database,
       string_agg(extname || ' ' || extversion, ', ' ORDER BY extname) AS extensions
FROM pg_extension;

\c guacamole_db
CREATE EXTENSION IF NOT EXISTS pg_stat_statements;
SELECT current_database() AS database,
       string_agg(extname || ' ' || extversion, ', ' ORDER BY extname) AS extensions
FROM pg_extension;

\c grafana
CREATE EXTENSION IF NOT EXISTS pg_stat_statements;
SELECT current_database() AS database,
       string_agg(extname || ' ' || extversion, ', ' ORDER BY extname) AS extensions
FROM pg_extension;

\c argus_parity
CREATE EXTENSION IF NOT EXISTS pg_stat_statements;
SELECT current_database() AS database,
       string_agg(extname || ' ' || extversion, ', ' ORDER BY extname) AS extensions
FROM pg_extension;
