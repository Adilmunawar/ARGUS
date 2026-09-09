-- ============================================================================
--  10-extensions.sql -- PostGIS and pg_stat_statements, in the databases that
--  need them and only those.
--
--  Runs second, on every boot, as the superuser. CREATE EXTENSION IF NOT EXISTS
--  is the whole idempotency story: on the second boot every statement here
--  prints "extension already exists, skipping" and changes nothing.
--
--  CREATE EXTENSION NEEDS A SUPERUSER, AND THAT IS WHY THIS FILE EXISTS.
--    Neither postgis nor pg_stat_statements is a trusted extension, so a
--    database owner cannot install one in a database it owns. argus_app is
--    deliberately not a superuser, so anything it might need has to be here,
--    installed once at boot, or it becomes a support request at the exact
--    moment somebody is mid-import.
--
--  IT MOVES BETWEEN DATABASES WITH \c, AND THAT IS LOAD-BEARING.
--    An extension is per-database. When \connect fails in a non-interactive
--    script psql stops immediately -- which is the behaviour wanted, because
--    the alternative is every remaining statement silently landing in the
--    PREVIOUS database, and a postgis installed into guacamole_db is very hard
--    to notice and annoying to undo.
-- ============================================================================

\set ON_ERROR_STOP on

-- ── pg_stat_statements ──────────────────────────────────────────────────────
--
-- Installed in EVERY database, including `postgres`. postgres-exporter runs
-- with --auto-discover-databases and --collector.stat_statements
-- (docker-compose.yml), so it opens a connection to each database it may reach
-- and queries pg_stat_statements THERE. A database without the view answers
-- every scrape with an error, once per 30 s, forever -- a permanently red row
-- that people learn to ignore, which is worse than a missing metric.
--
-- This costs nothing extra to track. The counters live in one block of shared
-- memory sized by pg_stat_statements.max for the whole cluster; the extension
-- in each database creates a view over that same block, not a second copy.
--
-- It depends on `shared_preload_libraries=pg_stat_statements` in
-- docker-compose.yml. Without that, this statement fails outright rather than
-- creating a view that returns nothing -- which is the correct failure, and the
-- reason this file does not try to be clever about the dependency.

\c postgres
CREATE EXTENSION IF NOT EXISTS pg_stat_statements;
SELECT current_database() AS database,
       string_agg(extname || ' ' || extversion, ', ' ORDER BY extname) AS extensions
FROM pg_extension;

-- ── argus_geo ───────────────────────────────────────────────────────────────
--
-- The reason this platform runs the postgis image at all. postgis brings the
-- geometry and geography types, the GiST operator classes the survey queries
-- index on, and spatial_ref_sys with the EPSG catalogue.
--
-- DELIBERATELY NOT INSTALLED, each for a stated reason:
--
--   postgis_raster -- PostGIS 3 split raster into its own extension and ships
--     it disabled because an out-db raster is a filesystem and network reach
--     from inside the database, through whatever GDAL drivers are enabled
--     (postgis.enable_outdb_rasters, postgis.gdal_enabled_drivers). The rasters
--     in this estate live in the argus-rasters bucket in object storage, not in
--     Postgres. If a raster catalogue is ever wanted here, it arrives with an
--     explicit decision about those two settings, not as a convenience.
--
--   postgis_topology -- unused, and it adds a topology schema plus its own
--     validation triggers to every table that references it.
--
--   postgis_tiger_geocoder -- a US-only address geocoder. It is present in this
--     image's template_postgis database, which is why 00-roles-and-databases.sql
--     builds from the default template instead.
--
--   pgcrypto, uuid-ossp, citext, btree_gist -- all available in this image,
--     none needed by anything committed. Add one here when a migration needs
--     it, in the same commit as that migration.
--
-- UPGRADES ARE NOT AUTOMATIC, ON PURPOSE. CREATE EXTENSION IF NOT EXISTS does
-- nothing to an extension that already exists, so after bumping POSTGIS_TAG
-- these databases keep the version they were created with and the library and
-- the catalogue disagree. The fix is deliberate and per database:
--     ALTER EXTENSION postgis UPDATE;  SELECT postgis_extensions_upgrade();
-- It rewrites catalogue entries and can invalidate indexes, which is not
-- something a container restart should do unattended at 3am.

\c argus_geo
CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS pg_stat_statements;
SELECT current_database() AS database,
       string_agg(extname || ' ' || extversion, ', ' ORDER BY extname) AS extensions
FROM pg_extension;

-- ── argus_ml ────────────────────────────────────────────────────────────────
--
-- PostGIS here too, and it is a judgement call worth stating. Nothing in
-- argus_ml holds a geometry column today. But every prediction this estate
-- makes is about a physical thing at a location -- a mill, a parcel, a survey
-- tile -- so a feature or result table with a geometry column is the expected
-- case, and argus_app CANNOT add the extension itself when that day comes
-- (see the header). The cost of being wrong in this direction is about 7 MB and
-- a spatial_ref_sys table nobody reads. The cost of being wrong in the other
-- direction is a blocked migration waiting on a superuser.
--
-- There is no vector extension in this image, so embeddings have nowhere to
-- live in Postgres here. That is a real limit of the postgis image and not
-- something this file can paper over: pgvector means a different base image,
-- which is an ADR.

\c argus_ml
CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS pg_stat_statements;
SELECT current_database() AS database,
       string_agg(extname || ' ' || extversion, ', ' ORDER BY extname) AS extensions
FROM pg_extension;

-- ── guacamole_db ────────────────────────────────────────────────────────────
--
-- Guacamole's JDBC schema is applied by guac-init, not here, and it needs no
-- extension at all. pg_stat_statements only, for the exporter.

\c guacamole_db
CREATE EXTENSION IF NOT EXISTS pg_stat_statements;
SELECT current_database() AS database,
       string_agg(extname || ' ' || extversion, ', ' ORDER BY extname) AS extensions
FROM pg_extension;

-- ── grafana ─────────────────────────────────────────────────────────────────
--
-- Grafana migrates its own schema on first boot and owns every table in here.
-- pg_stat_statements only.

\c grafana
CREATE EXTENSION IF NOT EXISTS pg_stat_statements;
SELECT current_database() AS database,
       string_agg(extname || ' ' || extversion, ', ' ORDER BY extname) AS extensions
FROM pg_extension;

-- ── argus_parity ────────────────────────────────────────────────────────────
--
-- The restart canary needs nothing but a table (created in 20-grants.sql, next
-- to the grant that is its entire purpose). pg_stat_statements is here for the
-- same reason as everywhere else: the exporter will visit this database too.

\c argus_parity
CREATE EXTENSION IF NOT EXISTS pg_stat_statements;
SELECT current_database() AS database,
       string_agg(extname || ' ' || extversion, ', ' ORDER BY extname) AS extensions
FROM pg_extension;
