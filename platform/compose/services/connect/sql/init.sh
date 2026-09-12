#!/bin/sh

set -eu

SEED_DIR=/seed
WORK_DIR=/tmp/argus-guac-seed
CLASS_DIR="$WORK_DIR/classes"
APPLIER_SOURCE="$WORK_DIR/SeedApply.java"
SCHEMA_SQL="$WORK_DIR/guacamole-schema.sql"
SCHEMA_PARTIAL="$WORK_DIR/guacamole-schema.sql.partial"
CONNECT_ERRORS="$WORK_DIR/connect-errors.txt"
BREAKGLASS_SQL="$WORK_DIR/10-breakglass-admin.sql"
RETIRE_SQL="$WORK_DIR/20-retire-default-admin.sql"
INITDB=/opt/guacamole/bin/initdb.sh
JDBC_GLOB=/opt/guacamole/postgresql/postgresql-*.jar
SCHEMA_PROBE_TABLE=public.guacamole_connection
BREAKGLASS_PASSWORD_FILE=platform/compose/secrets/guac_breakglass_password
CONNECT_ATTEMPTS=30
CONNECT_DELAY=2

say()  { printf 'guac-init: %s\n' "$*"; }
fail() { printf 'guac-init: FAILED: %s\n' "$*" >&2; exit 1; }

for required_name in PGHOST PGDATABASE PGUSER PGPASSWORD BREAKGLASS_USER BREAKGLASS_SALT_HEX BREAKGLASS_HASH_HEX; do
  eval "required_value=\${$required_name:-}"
  if [ -z "$required_value" ]; then
    fail "$required_name is empty in this container's environment.
             docker-compose.yml fills all seven of PGHOST PGDATABASE PGUSER PGPASSWORD
             BREAKGLASS_USER BREAKGLASS_SALT_HEX BREAKGLASS_HASH_HEX from
             platform/compose/.env. Run bootstrap.ps1 in platform/compose if that
             file does not exist yet."
  fi
done

is_sha256_hex() {
  printf '%s' "$1" | grep -Eq '^[0-9A-Fa-f]{64}$'
}

is_sha256_hex "$BREAKGLASS_SALT_HEX" || fail "GUAC_BREAKGLASS_SALT_HEX is not 64 hex characters.
             Guacamole salts are 32 bytes and this seed stores them as
             decode(hex). Re-run bootstrap.ps1: it generates the salt, the
             password and the hash together, and only the three together
             authenticate."

is_sha256_hex "$BREAKGLASS_HASH_HEX" || fail "GUAC_BREAKGLASS_HASH_HEX is not 64 hex characters.
             It must be a SHA-256 digest: SHA256(password_utf8 + UPPERCASE_HEX(salt)),
             computed by bootstrap.ps1 so that no plaintext ever reaches a SQL file
             or a container log."

if [ "$BREAKGLASS_USER" = "guacadmin" ]; then
  fail "GUAC_BREAKGLASS_USER is 'guacadmin', the account this seed exists to retire.
             Pick any other name in platform/compose/.env; the compose default is
             argus-breakglass."
fi

[ -x "$INITDB" ] || fail "$INITDB is missing from this image.
             This one-shot must run the SAME guacamole/guacamole tag as the
             guacamole service (GUAC_TAG), because that is where the JDBC schema
             matching the running extension lives."

command -v javac >/dev/null 2>&1 || fail "javac is not on PATH.
             guacamole/guacamole is built on tomcat:8.5-jdk8 and ships a full JDK
             but NO psql: the database client this seed uses is the PostgreSQL
             JDBC driver bundled beside the schema, compiled and run here."

command -v java >/dev/null 2>&1 || fail "java is not on PATH in the guacamole image."

JDBC_JAR=""
for candidate_jar in $JDBC_GLOB; do
  [ -f "$candidate_jar" ] || continue
  if [ -n "$JDBC_JAR" ]; then
    fail "more than one driver matches $JDBC_GLOB.
             Two PostgreSQL JDBC versions on one classpath resolve unpredictably.
             This image is expected to ship exactly one."
  fi
  JDBC_JAR="$candidate_jar"
done

[ -n "$JDBC_JAR" ] || fail "no PostgreSQL JDBC driver matches $JDBC_GLOB.
             That path is where guacamole-docker's build-guacamole.sh puts it, so
             its absence means this is not a guacamole/guacamole image."

mkdir -p "$CLASS_DIR"

for seed_file in SeedApply.java 10-breakglass-admin.sql 20-retire-default-admin.sql; do
  [ -f "$SEED_DIR/$seed_file" ] || fail "$SEED_DIR/$seed_file is missing.
             /seed is the ./services/connect/sql bind mount. An empty /seed means
             Docker created the directory because the host path does not exist."
  tr -d '\r' < "$SEED_DIR/$seed_file" > "$WORK_DIR/$seed_file"
done

if ! javac -d "$CLASS_DIR" "$APPLIER_SOURCE"; then
  fail "could not compile $APPLIER_SOURCE with the JDK in this image."
fi

seed_probe() {
  java -cp "$CLASS_DIR:$JDBC_JAR" SeedApply probe "$1"
}

seed_apply() {
  java -cp "$CLASS_DIR:$JDBC_JAR" SeedApply apply "$@"
}

say "waiting for $PGDATABASE on $PGHOST as $PGUSER"
attempt=1
ready=""
while [ "$attempt" -le "$CONNECT_ATTEMPTS" ]; do
  if ready=$(seed_probe "SELECT 'ready'" 2>"$CONNECT_ERRORS"); then
    break
  fi
  attempt=$((attempt + 1))
  sleep "$CONNECT_DELAY"
done

if [ "$ready" != "ready" ]; then
  fail "no usable connection to $PGDATABASE on $PGHOST after $((CONNECT_ATTEMPTS * CONNECT_DELAY))s.
             Last refusal: $(cat "$CONNECT_ERRORS")
             ARGUS_PG_GUAC_PASSWORD in .env and the password pg-init set on
             guacamole_user are written from one value by bootstrap.ps1; editing
             either one alone produces exactly this."
fi
say "connected"

schema_state=$(seed_probe "SELECT CASE WHEN to_regclass('$SCHEMA_PROBE_TABLE') IS NULL THEN 'absent' ELSE 'present' END")

case "$schema_state" in
  absent)
    say "$SCHEMA_PROBE_TABLE is absent -- exporting this image's JDBC schema"
    "$INITDB" --postgresql > "$SCHEMA_PARTIAL"
    mv "$SCHEMA_PARTIAL" "$SCHEMA_SQL"
    [ -s "$SCHEMA_SQL" ] || fail "$INITDB --postgresql produced an empty schema."
    grep -q 'CREATE TABLE guacamole_connection' "$SCHEMA_SQL" || fail "the exported schema has no CREATE TABLE guacamole_connection.
             $INITDB concatenates /opt/guacamole/postgresql/schema/*.sql; an export
             without that table is not the JDBC schema."
    seed_apply "$SCHEMA_SQL"
    say "schema applied"
    ;;
  present)
    say "$SCHEMA_PROBE_TABLE is present -- leaving the existing schema alone"
    ;;
  *)
    fail "the schema probe answered '$schema_state', which is neither absent nor present."
    ;;
esac

seed_apply "$BREAKGLASS_SQL" \
  argus.breakglass_user=BREAKGLASS_USER \
  argus.breakglass_salt_hex=BREAKGLASS_SALT_HEX \
  argus.breakglass_hash_hex=BREAKGLASS_HASH_HEX

seed_apply "$RETIRE_SQL"

say ""
say "─────────────────────────────────────────────────────────────────────────"
say "guacamole_db is seeded."
say ""
say "  break-glass login    $BREAKGLASS_USER"
say "  its password         the single line in $BREAKGLASS_PASSWORD_FILE"
say "  stock guacadmin      deleted, and deleted explicitly -- not disabled"
say ""
say "  THE PASSWORD IS NEVER RE-APPLIED. This seed creates the break-glass"
say "  account when it is absent and touches nothing when it is present, so a"
say "  password changed in the Guacamole UI survives every later boot -- and so"
say "  does an account an operator disabled mid-incident. Rotating"
say "  GUAC_BREAKGLASS_* in .env therefore does NOT reach a database that"
say "  already has the account; change it in the UI, or delete the row first."
say ""
say "  NO CONNECTION ROWS ARE SEEDED. Sessions are minted by the json extension"
say "  (EXTENSION_PRIORITY: json), which writes no guacamole_connection and no"
say "  guacamole_connection_history. The break-glass account is the only login"
say "  this database serves, and it exists for the day the console cannot mint."
say "─────────────────────────────────────────────────────────────────────────"

exit 0
