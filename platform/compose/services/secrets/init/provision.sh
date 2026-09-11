#!/bin/sh
# ═══════════════════════ Argus secrets: initialise and provision OpenBao
# Runs as the `bao-init` one-shot on every `docker compose up -d`, which is the
# single most important fact about it: THIS SCRIPT IS RE-RUN AGAINST A LIVE
# VAULT HOLDING REAL SECRETS, every boot, forever. Every branch below is written
# on the assumption that it is the second run, not the first.
#
# What that costs if it is got wrong, in order of severity:
#   * `bao operator init` on an initialised raft does not fail harmlessly -- it
#     is the one command that can destroy an estate. It is gated on a MEASURED
#     Initialized=false and nothing else.
#   * `bao secrets enable` and `bao auth enable` are NOT upserts. A second run
#     returns "path is already in use" and exit 2, so an ungated enable makes
#     every boot after the first report failure while nothing is actually wrong.
#   * `bao write auth/approle/role/*/secret-id` IS idempotent in the worst way:
#     it succeeds every time and mints a NEW credential, so an ungated call
#     leaves a pile of live, never-revoked SecretIDs growing by one per boot.
#
# ── THE TWO UNSEAL MODES ──────────────────────────────────────────────────
#
# ARGUS_UNSEAL_MODE=sandbox   1-of-1. This script initialises the vault, writes
#                             the single unseal key AND the root token to
#                             /run/argus/seal (the argus_openbao_seal volume),
#                             and unseals. The key sits on the same disk as the
#                             data it opens, which is exactly the arrangement
#                             ADR-0013 exists to prevent. It ships anyway so
#                             that one command gives a working system, and
#                             everything below goes out of its way to make sure
#                             nobody can be in this mode without knowing.
#
# ARGUS_UNSEAL_MODE=ceremony  5 shares, 3 to unseal, TWO PASSES, and NO KEY AT
#                             REST. This script will not initialise: it prints
#                             the command for the key holders to run themselves
#                             and stops. The shares are never seen by this
#                             container, never written to a volume, and never
#                             printed into `docker compose logs` -- which is a
#                             file on disk that Alloy ships to Loki, so a
#                             "temporary" print there is a permanent copy.
#                             Pass two provisions the vault once humans have
#                             unsealed it, and is described in full below.
#
# ── NO CREDENTIAL IN THIS FILE, AND NO ARGUMENT TO PASS ONE IN ────────────
# Everything comes from the environment or from a file this script itself
# wrote. The one credential a human ever hands to this script is the ceremony
# root token, and that arrives as BAO_TOKEN in the environment for exactly one
# run of pass two.

set -u
# `set -e` is deliberately absent. This script is built on commands whose
# NON-ZERO exit is a normal, expected state: `bao status` exits 2 when the vault
# is sealed and 1 when it is unreachable, `bao read` exits 2 when a path does
# not exist, and both of those are questions this script asks on purpose. Under
# `set -e` the first such answer would kill the run at the point where it had
# just learnt something, with no message. Every command that matters is checked
# explicitly instead.

umask 077                      # anything created here is 0600 until stated otherwise

MODE="${ARGUS_UNSEAL_MODE:-sandbox}"
ADDR="${BAO_ADDR:-http://openbao:8200}"

SEAL_DIR=/run/argus/seal
POLICY_DIR=/etc/argus/policies

KEY_FILE="$SEAL_DIR/unseal.key"
ROOT_FILE="$SEAL_DIR/root.token"
STATUS_FILE="$SEAL_DIR/status.json"
APPROLE_FILE="$SEAL_DIR/console-approle.env"
SANDBOX_MARK="$SEAL_DIR/SANDBOX-UNSEAL-KEY-IS-ON-THIS-DISK.txt"

CEREMONY_SHARES=5
CEREMONY_THRESHOLD=3

# Everything the status file reports. `null` is the honest value until something
# has actually been measured -- a zero here would be indistinguishable from a
# real 0-of-0 seal, and "unknown" and "zero" lead to opposite decisions.
S_REACHABLE=false
S_VERSION=null
S_INITIALIZED=null
S_SEALED=null
S_SHARES=null
S_THRESHOLD=null
S_PROVISIONED=false
S_ENGINES=""
S_POLICIES=""
S_DB="not configured"
S_APPROLE="not issued"
S_NOTES=""

# ───────────────────────────────────────────────────────────────── logging ───
log()  { echo "[bao-init] $*"; }
warn() { echo "[bao-init] WARNING: $*"; }
err()  { echo "[bao-init] ERROR: $*"; }

# Notes end up in status.json AND in the log, because the console cannot read
# the log and a human reading the log should not have to find the file.
note() {
  log "$*"
  esc=$(printf '%s' "$*" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g')
  if [ -z "$S_NOTES" ]; then S_NOTES="\"$esc\""; else S_NOTES="$S_NOTES, \"$esc\""; fi
}

# The sandbox banner. Printed at the start and the end of a sandbox run, and by
# the unseal sidecar on every unseal, because a warning that scrolls past once
# during a boot storm has not warned anybody.
sandbox_banner() {
  cat <<'BANNER'
[bao-init] ╔══════════════════════════════════════════════════════════════════╗
[bao-init] ║  ARGUS_UNSEAL_MODE=sandbox  --  THIS IS NOT A SECURE DEPLOYMENT  ║
[bao-init] ╠══════════════════════════════════════════════════════════════════╣
[bao-init] ║  The vault is sealed with ONE Shamir share, and that share is    ║
[bao-init] ║  stored on THIS MACHINE, in the argus_openbao_seal volume, next  ║
[bao-init] ║  to the raft it opens. So is the root token. Anybody who can     ║
[bao-init] ║  read that volume -- which is anybody with the Docker socket --  ║
[bao-init] ║  owns every secret in this estate, with no ceremony and nobody   ║
[bao-init] ║  to notice. A backup of this laptop is a backup of the keys.     ║
[bao-init] ║                                                                  ║
[bao-init] ║  ADR-0013 requires 3-of-5 held by three named people. This mode  ║
[bao-init] ║  exists ONLY so that one command produces a working system on a  ║
[bao-init] ║  laptop. It must never reach a real host, and the GitOps         ║
[bao-init] ║  reconciler is required to refuse a plan that sets it there.     ║
[bao-init] ║                                                                  ║
[bao-init] ║  To leave it: destroy argus_openbao_data AND argus_openbao_seal, ║
[bao-init] ║  set ARGUS_UNSEAL_MODE=ceremony and boot again. Flipping the     ║
[bao-init] ║  variable ALONE changes nothing -- an existing vault keeps the   ║
[bao-init] ║  seal it was born with.                                          ║
[bao-init] ╚══════════════════════════════════════════════════════════════════╝
BANNER
}

# ───────────────────────────────────────────────────────────── json helpers ──
# `bao ... -format=json` pretty-prints one field per line, so a scalar field is
# one grep and one sed away. That is the whole reason there is no jq here: this
# image does not ship one, and adding it means a second image or a build step
# to parse four numbers.
jf() {
  printf '%s\n' "$1" | grep -m1 "\"$2\":" \
    | sed -e 's/^[^:]*: *//' -e 's/,$//' -e 's/^"//' -e 's/"$//'
}

# The first element of a JSON array field, for `unseal_keys_b64`.
jarray1() {
  printf '%s\n' "$1" | sed -n "/\"$2\": \[/,/\]/p" | sed -n '2p' \
    | sed -e 's/^ *//' -e 's/,$//' -e 's/^"//' -e 's/"$//'
}

json_str() { printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g'; }

# ─────────────────────────────────────────────────────── the sandbox verdict ─
# "Is this estate protected by a single secret sitting on this machine?"
#
# Answered from what was MEASURED -- the seal the server reports, and whether a
# key file actually exists here -- and never from ARGUS_UNSEAL_MODE. The
# variable is an intention; the seal is the estate. They disagree in exactly the
# case that matters: a vault initialised in sandbox mode and later booted with
# ARGUS_UNSEAL_MODE=ceremony reports "ceremony" while one share on this disk
# still opens everything. A console that trusted the variable would draw that
# deployment green.
#
# When the seal could not be read at all the answer is `null`, not `false`.
# "We could not check" and "we checked and it is safe" are opposite facts.
sandbox_verdict() {
  if [ -f "$KEY_FILE" ] || [ "$S_SHARES" = 1 ]; then echo true
  elif [ "$S_SHARES" = null ]; then echo null
  else echo false
  fi
}

sandbox_reason() {
  if [ -f "$KEY_FILE" ] && [ "$S_SHARES" = 1 ]; then
    echo "the seal is 1-of-1 and its single share is stored at $KEY_FILE, on the same machine as the data"
  elif [ -f "$KEY_FILE" ]; then
    echo "an unseal key is stored at $KEY_FILE, on the same machine as the data"
  elif [ "$S_SHARES" = 1 ]; then
    echo "the seal is 1-of-1: one share opens this estate, whatever ARGUS_UNSEAL_MODE says"
  elif [ "$S_SHARES" = null ]; then
    echo "unknown: the seal could not be read, so nothing here has been verified"
  else
    echo "no: the seal is $S_THRESHOLD-of-$S_SHARES and this project stores no unseal key"
  fi
}

# ────────────────────────────────────────────────────────────── status file ──
# Written on EVERY exit path, including the failures, because "no status file"
# and "status file that says it could not reach the server" are different
# problems and only one of them is this script's fault.
#
# It holds no secret. It is deliberately 0644 while everything else here is
# 0600, so that a future read-only mount of this volume into the console is a
# compose edit and not a permissions puzzle.
write_status() {
  tmp="$STATUS_FILE.tmp"
  {
    printf '{\n'
    printf '  "at": "%s",\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    printf '  "mode": "%s",\n' "$(json_str "$MODE")"
    printf '  "modeSource": "ARGUS_UNSEAL_MODE in the bao-init container: what was ASKED FOR, not what is",\n'
    printf '  "sandbox": %s,\n' "$(sandbox_verdict)"
    printf '  "sandboxReason": "%s",\n' "$(json_str "$(sandbox_reason)")"
    printf '  "server": { "addr": "%s", "reachable": %s, "version": %s },\n' \
      "$(json_str "$ADDR")" "$S_REACHABLE" "$([ "$S_VERSION" = null ] && echo null || echo "\"$S_VERSION\"")"
    printf '  "seal": {\n'
    printf '    "initialized": %s,\n' "$S_INITIALIZED"
    printf '    "sealed": %s,\n' "$S_SEALED"
    printf '    "shares": %s,\n' "$S_SHARES"
    printf '    "threshold": %s,\n' "$S_THRESHOLD"
    printf '    "measured": %s,\n' "$([ "$S_SHARES" = null ] && echo false || echo true)"
    printf '    "keyAtRest": %s,\n' "$([ -f "$KEY_FILE" ] && echo true || echo false)"
    printf '    "keyFile": %s\n' "$([ -f "$KEY_FILE" ] && echo "\"$KEY_FILE\"" || echo null)"
    printf '  },\n'
    printf '  "provisioned": %s,\n' "$S_PROVISIONED"
    printf '  "engines": [%s],\n' "$S_ENGINES"
    printf '  "policies": [%s],\n' "$S_POLICIES"
    printf '  "databaseConnection": "%s",\n' "$(json_str "$S_DB")"
    printf '  "consoleApprole": "%s",\n' "$(json_str "$S_APPROLE")"
    printf '  "adr": "ADR-0013",\n'
    printf '  "check": "%s",\n' \
      'GET /v1/sys/seal-status is unauthenticated and works while sealed. n=1,t=1 is the sandbox 1-of-1 seal; n=5,t=3 is the ceremony seal. Trust those numbers over this file and over ARGUS_UNSEAL_MODE: they are measured from the seal itself.'
    printf '  "notes": [%s]\n' "$S_NOTES"
    printf '}\n'
  } > "$tmp" 2>/dev/null || { err "could not write $tmp"; return 1; }
  mv -f "$tmp" "$STATUS_FILE" && chmod 0644 "$STATUS_FILE"
  sync 2>/dev/null
}

finish() {
  write_status
  log "status: $STATUS_FILE  (read it with: docker compose exec openbao-unseal cat $STATUS_FILE)"
  exit "$1"
}

# ─────────────────────────────────────────────────────────── seal status ─────
# Sets the S_* globals from the SERVER, never from the environment. The
# distinction is the whole point: ARGUS_UNSEAL_MODE says what somebody asked
# for, `bao status` says what the seal actually is, and when a vault initialised
# in sandbox mode is later booted with ARGUS_UNSEAL_MODE=ceremony those two
# disagree and only one of them is true.
read_status() {
  st=$(bao status -format=json 2>/dev/null)
  rc=$?
  if [ -z "$st" ]; then
    S_REACHABLE=false
    return 1
  fi
  S_REACHABLE=true
  S_INITIALIZED=$(jf "$st" initialized)
  S_SEALED=$(jf "$st" sealed)
  S_SHARES=$(jf "$st" n)
  S_THRESHOLD=$(jf "$st" t)
  S_VERSION=$(jf "$st" version)
  # Before `bao operator init` there is no seal, so n and t are 0. Zero shares
  # is not a fact about a seal, it is the absence of one -- and a console
  # rendering "0 of 0" would be stating something false with great confidence.
  [ "$S_INITIALIZED" = true ] || { S_SHARES=null; S_THRESHOLD=null; }
  return "$rc"
}

# ────────────────────────────────────────────────────────────── wait for it ──
# depends_on for this container is `service_started`, not `service_healthy`, and
# that is correct: a sealed vault is a HEALTHY vault, and gating on health would
# deadlock the whole stack behind a human with three key shares. The cost is
# that this script can start before the listener binds, so it waits here.
wait_for_server() {
  i=0
  while [ "$i" -lt 30 ]; do
    read_status
    if [ "$S_REACHABLE" = true ]; then return 0; fi
    i=$((i + 1))
    [ "$i" = 1 ] && log "waiting for OpenBao at $ADDR ..."
    sleep 3
  done
  return 1
}

# ─────────────────────────────────────────────────────── idempotency probes ──
# `bao secrets enable` and `bao auth enable` return exit 2 and "path is already
# in use" on a second run. Gating on the mount list turns that into a no-op with
# a truthful log line instead of a red error on every boot after the first.
mount_present() { bao secrets list -format=json 2>/dev/null | grep -q "^  \"$1/\":"; }
auth_present()  { bao auth    list -format=json 2>/dev/null | grep -q "^  \"$1/\":"; }

engine_note() {
  esc=$(json_str "$1")
  if [ -z "$S_ENGINES" ]; then S_ENGINES="\"$esc\""; else S_ENGINES="$S_ENGINES, \"$esc\""; fi
}
policy_note() {
  esc=$(json_str "$1")
  if [ -z "$S_POLICIES" ]; then S_POLICIES="\"$esc\""; else S_POLICIES="$S_POLICIES, \"$esc\""; fi
}

ensure_kv() {
  if mount_present argus-kv; then
    log "kv v2 at argus-kv/ : already enabled"
  else
    bao secrets enable -path=argus-kv -version=2 kv >/dev/null 2>&1 \
      && log "kv v2 at argus-kv/ : enabled" \
      || { warn "could not enable kv at argus-kv/"; return 1; }
  fi
  engine_note "argus-kv (kv v2)"
}

ensure_transit() {
  # ADR-0013 buys the transit engine for PII field encryption: the application
  # sends plaintext and gets ciphertext back, and the key never leaves this
  # process. No key is CREATED here -- a transit key is a per-application
  # decision with a rotation policy attached, and one created blindly at boot
  # would be one nobody owns.
  if mount_present transit; then
    log "transit/ : already enabled"
  else
    bao secrets enable transit >/dev/null 2>&1 \
      && log "transit/ : enabled" \
      || { warn "could not enable transit/"; return 1; }
  fi
  engine_note "transit"
}

ensure_database() {
  if mount_present database; then
    log "database/ : already enabled"
  else
    bao secrets enable database >/dev/null 2>&1 \
      && log "database/ : enabled" \
      || { warn "could not enable database/"; return 1; }
  fi
  engine_note "database"

  # ── the connection, which is the part that usually is not configured ──────
  #
  # Configuring it needs a PostgreSQL superuser password, and there is no
  # credential in this file and no argument to pass one in: it must arrive in
  # this container's environment. docker-compose.yml does not put it there
  # today, so on this stack the normal, expected answer is "not configured",
  # said out loud rather than skipped in silence.
  #
  # And it is written ONCE. `bao write database/rotate-root/...` -- the whole
  # point of this engine -- changes the password in PostgreSQL to one only
  # OpenBao knows. After that, re-writing this config from an environment
  # variable holding the OLD password replaces a working connection with a
  # broken one, on a boot where nothing else changed. So: only if absent.
  if [ -z "${ARGUS_PG_BOOTSTRAP_PASSWORD:-}" ]; then
    S_DB="not configured: ARGUS_PG_BOOTSTRAP_PASSWORD is not set in the bao-init container. \
Dynamic PostgreSQL credentials (ADR-0013) are therefore not available; the engine is mounted and empty."
    note "database/ has no connection configured. $S_DB"
    return 0
  fi
  if bao read database/config/argus-postgres >/dev/null 2>&1; then
    S_DB="configured (left untouched: rotate-root may already have changed this password)"
    log "database/config/argus-postgres : already configured, not rewritten"
    return 0
  fi

  pg_host="${ARGUS_PG_HOST:-postgres}"
  pg_user="${ARGUS_PG_BOOTSTRAP_USER:-postgres}"
  # The password reaches bao through a K=V value read FROM A FILE (`@path`), so
  # it never appears in this container's argv where `ps` and any process in the
  # same PID namespace can read it.
  pw_file=$(mktemp)
  printf '%s' "$ARGUS_PG_BOOTSTRAP_PASSWORD" > "$pw_file"
  if bao write database/config/argus-postgres \
        plugin_name=postgresql-database-plugin \
        allowed_roles="*" \
        connection_url="postgresql://{{username}}:{{password}}@$pg_host:5432/postgres?sslmode=disable" \
        username="$pg_user" \
        password="@$pw_file" >/dev/null 2>&1; then
    S_DB="configured against $pg_host as $pg_user"
    log "database/config/argus-postgres : configured"
  else
    S_DB="configure failed: OpenBao could not connect to $pg_host as $pg_user"
    warn "$S_DB"
  fi
  rm -f "$pw_file"
}

apply_policies() {
  if [ ! -d "$POLICY_DIR" ]; then
    note "no policy directory at $POLICY_DIR. Nothing was applied; every token this vault issues carries only \
the built-in default policy."
    return 0
  fi
  n=0
  for f in "$POLICY_DIR"/*.hcl; do
    [ -e "$f" ] || continue
    name=$(basename "$f" .hcl)
    # CR-stripped first, for the same reason docker-compose.yml strips CR from
    # this script: the repository is cloned on Windows, and a policy whose
    # capability list ends in \r is accepted by the parser and then never
    # matches anything at request time. That failure has no error message at
    # all -- it presents as "permission denied" on a policy that looks correct.
    tr -d '\r' < "$f" > /tmp/policy.hcl
    if bao policy write "$name" /tmp/policy.hcl >/dev/null 2>&1; then
      log "policy $name : applied"
      policy_note "$name"
      n=$((n + 1))
    else
      warn "policy $name : REJECTED. 'bao policy write' refused $f -- the vault is running without it."
    fi
  done
  rm -f /tmp/policy.hcl
  if [ "$n" = 0 ]; then
    note "$POLICY_DIR holds no .hcl policies, so none were applied. Until platform/gitops/identity/\
openbao-policies is populated, no application identity can be authorised here and no AppRole is issued."
  fi
}

ensure_console_approle() {
  # Gated on the POLICY existing, not on the mode. An AppRole with no policy can
  # authenticate and then do nothing, which is a credential that exists, must be
  # rotated and audited, and buys nobody anything -- and it would look, in the
  # console, exactly like a working one.
  if ! bao policy read argus-console >/dev/null 2>&1; then
    S_APPROLE="not issued: there is no argus-console policy in this vault, so there is nothing to bind a role to"
    log "console AppRole : skipped ($S_APPROLE)"
    return 0
  fi

  if ! auth_present approle; then
    bao auth enable approle >/dev/null 2>&1 \
      && log "approle auth : enabled" \
      || { warn "could not enable the approle auth method"; S_APPROLE="not issued: approle auth could not be enabled"; return 1; }
  fi

  # An upsert, and safe to repeat: this is the role DEFINITION, so re-writing it
  # every boot is what keeps the TTLs in this file authoritative over anything
  # somebody changed by hand in the UI.
  bao write auth/approle/role/argus-console \
      token_policies=argus-console \
      token_ttl=1h token_max_ttl=4h \
      secret_id_num_uses=0 secret_id_ttl=0 \
      bind_secret_id=true >/dev/null 2>&1 \
    || { warn "could not write the argus-console AppRole"; S_APPROLE="not issued: role write failed"; return 1; }

  # ── minting is gated on the FILE, and this is the gate that matters ────────
  # `.../secret-id` succeeds every single time it is called and returns a new
  # live credential. Ungated, every boot adds one more valid SecretID that
  # nothing revokes and nothing tracks -- a slow leak that looks like nothing at
  # all until an audit asks how many credentials can read the estate.
  if [ -f "$APPROLE_FILE" ]; then
    stored=$(sed -n 's/^ARGUS_OPENBAO_SECRET_ID=//p' "$APPROLE_FILE")
    if [ -n "$stored" ]; then
      sid_file=$(mktemp)
      printf '%s' "$stored" > "$sid_file"
      # THE EXIT CODE OF THIS LOOKUP IS ALWAYS 0. Measured on 2.6.2: an unknown
      # SecretID answers 204 No Content and the CLI prints "Success! Data
      # written" and exits 0, exactly as it does for a valid one. Only the
      # RESPONSE BODY distinguishes them: a real SecretID returns its accessor.
      #
      # `secret_id=@file` keeps the credential out of argv (verified: the CLI
      # reads the value from the file).
      look=$(bao write -format=json auth/approle/role/argus-console/secret-id/lookup \
               secret_id="@$sid_file" 2>/dev/null)
      if printf '%s' "$look" | grep -q secret_id_accessor; then
        rm -f "$sid_file"
        S_APPROLE="issued (existing credential still valid)"
        log "console AppRole : existing SecretID still accepted, not re-minted"
        return 0
      fi
      rm -f "$sid_file"
      # The stored credential is not valid here. The usual cause is a rebuilt
      # vault beside a surviving seal volume, and leaving the stale file in
      # place would mean the console fails to authenticate forever with a file
      # sitting there that looks like the answer.
      note "the stored console SecretID is not valid in this vault (the vault was probably rebuilt while \
argus_openbao_seal survived). Minting a replacement."
    fi
  fi

  role_id=$(bao read -field=role_id auth/approle/role/argus-console/role-id 2>/dev/null)
  secret_id=$(bao write -f -field=secret_id auth/approle/role/argus-console/secret-id 2>/dev/null)
  if [ -z "$role_id" ] || [ -z "$secret_id" ]; then
    S_APPROLE="not issued: OpenBao returned no credential"
    warn "console AppRole : $S_APPROLE"
    return 1
  fi
  # env-file shaped on purpose, so wiring it into the console later is an
  # `env_file:` line in docker-compose.yml rather than a parser.
  {
    echo "# Argus console AppRole. Written by services/secrets/init/provision.sh."
    echo "# In ceremony mode this is the ONLY credential this project leaves at rest, and"
    echo "# it is deliberately not an unseal key: losing it costs a re-issued SecretID,"
    echo "# not the estate. Revoke with:"
    echo "#   bao write -f auth/approle/role/argus-console/secret-id-accessor/destroy ..."
    echo "ARGUS_OPENBAO_ROLE_ID=$role_id"
    echo "ARGUS_OPENBAO_SECRET_ID=$secret_id"
  } > "$APPROLE_FILE"
  chmod 0600 "$APPROLE_FILE"
  S_APPROLE="issued (new credential written to $APPROLE_FILE)"
  log "console AppRole : issued -> $APPROLE_FILE"
}

write_mode_marker() {
  # The one thing in the vault that names the seal posture, for any client that
  # holds a token. It records the MEASURED shares and threshold, never the
  # requested mode alone, and it is rewritten only when it would change -- kv v2
  # keeps a version per write, and a new version on every boot would bury the
  # one write that meant something.
  verdict=$(sandbox_verdict)
  want="$MODE/$S_SHARES/$S_THRESHOLD/$verdict"
  have=$(bao kv get -field=fingerprint argus-kv/platform/unseal-mode 2>/dev/null)
  [ "$want" = "$have" ] && { log "kv marker argus-kv/platform/unseal-mode : unchanged"; return 0; }

  # The warning follows the VERDICT, not the mode. Chosen by mode, this record
  # would have said "no unseal key is stored" on a vault whose key was sitting
  # in the next file along, purely because somebody edited a variable.
  if [ "$verdict" = true ]; then
    w="SANDBOX: $(sandbox_reason). ADR-0013 forbids this on any real host, and the console must show a \
permanent warning while it is true."
  elif [ "$verdict" = null ]; then
    w="UNKNOWN: the seal could not be read when this was written. Do not read this as safe."
  else
    w="Ceremony seal: $(sandbox_reason)."
  fi
  bao kv put argus-kv/platform/unseal-mode \
      fingerprint="$want" \
      mode="$MODE" \
      sandbox="$verdict" \
      shares="$S_SHARES" \
      threshold="$S_THRESHOLD" \
      key_at_rest="$([ -f "$KEY_FILE" ] && echo true || echo false)" \
      adr=ADR-0013 \
      warning="$w" \
      at="$(date -u +%Y-%m-%dT%H:%M:%SZ)" >/dev/null 2>&1 \
    && log "kv marker argus-kv/platform/unseal-mode : written" \
    || warn "could not write the kv mode marker"
}

# ═══════════════════════════════════════════════════════════════════ run ═════

case "$MODE" in
  sandbox|ceremony) ;;
  *)
    err "ARGUS_UNSEAL_MODE is '$MODE'. The only values are 'sandbox' and 'ceremony'."
    err "Refusing to guess: one of those two choices puts an unseal key on this disk and the other"
    err "does not, and a typo must never silently pick either. Fix ARGUS_UNSEAL_MODE in"
    err "platform/compose/.env and boot again."
    finish 1 ;;
esac

log "OpenBao provisioning starts. mode=$MODE addr=$ADDR"
[ "$MODE" = sandbox ] && sandbox_banner

if ! wait_for_server; then
  err "OpenBao at $ADDR did not answer within 90 s."
  err "This container starts on service_started, not on health, so this is genuinely 'not up yet' or"
  err "'not up at all'. Look at: docker compose logs openbao"
  finish 1
fi
log "OpenBao $S_VERSION answered. initialized=$S_INITIALIZED sealed=$S_SEALED"

# ─────────────────────────────────────────────────────── not initialised yet ─
if [ "$S_INITIALIZED" != true ]; then

  if [ "$MODE" = ceremony ]; then
    cat <<CEREMONY
[bao-init]
[bao-init] ── ARGUS_UNSEAL_MODE=ceremony: THIS SCRIPT WILL NOT INITIALISE THE VAULT ──
[bao-init]
[bao-init] Initialising prints five key shares and a root token. Whatever prints them owns
[bao-init] the estate for as long as that output exists -- and this container's output is a
[bao-init] json-file on disk that Alloy ships to Loki, so printing them here would put the
[bao-init] shares in two permanent places instead of none. \`docker compose exec\` output goes
[bao-init] to the operator's terminal and is not written to any container log, which is why
[bao-init] the ceremony is run by a human, from a terminal, with the key holders present.
[bao-init]
[bao-init] PASS 1 -- the ceremony ($CEREMONY_THRESHOLD of $CEREMONY_SHARES, one share to each holder):
[bao-init]
[bao-init]   docker compose exec openbao bao operator init \\
[bao-init]       -key-shares=$CEREMONY_SHARES -key-threshold=$CEREMONY_THRESHOLD
[bao-init]
[bao-init]   Record each share with its holder and record the root token. Then unseal,
[bao-init]   three times, each holder entering their own share at the hidden prompt:
[bao-init]
[bao-init]   docker compose exec openbao bao operator unseal
[bao-init]
[bao-init] PASS 2 -- provisioning, once the vault is unsealed:
[bao-init]
[bao-init]   docker compose --profile secrets run --rm -e BAO_TOKEN bao-init
[bao-init]
[bao-init]   with BAO_TOKEN set to the root token in the shell you run it from. It applies
[bao-init]   the policies, mounts and roles, and it stores no credential of any kind.
[bao-init]
[bao-init] AFTERWARDS: revoke the root token -- \`bao token revoke -self\` -- so that no token
[bao-init] outlives the ceremony. Three holders can mint a new one with
[bao-init] \`bao operator generate-root\` whenever one is needed again.
[bao-init]
CEREMONY
    note "ceremony mode: the vault is uninitialised and this script will not initialise it. A human must run \
the ceremony; see the bao-init log for the exact commands."
    finish 0
  fi

  # ── sandbox: initialise ────────────────────────────────────────────────────
  #
  # Everything below is ordered so that the vault is never initialised before
  # its key can be stored. `bao operator init` is irreversible and its output is
  # the only copy of the key that will ever exist: if it succeeds and the write
  # fails, the raft is sealed forever with nothing to open it. So the writable
  # check comes first, and the init writes STRAIGHT into the seal volume -- the
  # shell creates that file before bao runs, so a volume that cannot be written
  # fails before anything irreversible has happened.
  if ! mkdir -p "$SEAL_DIR" 2>/dev/null || ! : > "$SEAL_DIR/.writable" 2>/dev/null; then
    err "$SEAL_DIR is not writable, so an unseal key could not be stored."
    err "Refusing to initialise: an initialised vault whose key was never saved is unopenable,"
    err "and this check is the only thing standing between that and one command."
    err "Check the argus_openbao_seal volume mount on the bao-init service."
    finish 1
  fi
  rm -f "$SEAL_DIR/.writable"

  if [ -f "$KEY_FILE" ]; then
    # A key beside an uninitialised raft: the data volume was destroyed and this
    # one survived. The old key cannot open the new vault -- but it can still
    # open an old SNAPSHOT of the raft, so it is moved aside rather than
    # overwritten. Deleting it here would be this script destroying the only
    # thing that could ever read a backup somebody has.
    keep="$KEY_FILE.superseded-$(date -u +%Y%m%dT%H%M%SZ)"
    mv "$KEY_FILE" "$keep"
    [ -f "$ROOT_FILE" ] && mv "$ROOT_FILE" "$ROOT_FILE.superseded-$(date -u +%Y%m%dT%H%M%SZ)"
    note "an unseal key was already on this volume but the vault is uninitialised, so the raft was rebuilt \
without it. The old key is kept at $keep because it is still the only thing that could open an older \
snapshot; delete it yourself once you are certain no such snapshot exists."
  fi

  log "initialising: 1 share, threshold 1 (sandbox)"
  if ! bao operator init -key-shares=1 -key-threshold=1 -format=json > "$SEAL_DIR/.init.json" 2>/dev/null; then
    err "bao operator init failed. The vault is NOT initialised; nothing was changed."
    rm -f "$SEAL_DIR/.init.json"
    finish 1
  fi
  init_json=$(cat "$SEAL_DIR/.init.json")
  unseal_key=$(jarray1 "$init_json" unseal_keys_b64)
  root_token=$(jf "$init_json" root_token)

  if [ -z "$unseal_key" ] || [ -z "$root_token" ]; then
    err "the vault WAS initialised but its key could not be read out of the init output."
    err "The raw output is at $SEAL_DIR/.init.json inside the argus_openbao_seal volume and it is the"
    err "only copy of that key. Recover it by hand before doing anything else:"
    err "  docker compose exec openbao-unseal cat $SEAL_DIR/.init.json"
    finish 1
  fi

  printf '%s' "$unseal_key" > "$KEY_FILE"; chmod 0600 "$KEY_FILE"
  printf '%s' "$root_token" > "$ROOT_FILE"; chmod 0600 "$ROOT_FILE"
  sync 2>/dev/null
  # The raw init output holds both, in one file, in a format that invites being
  # copied somewhere else. Two purpose-named files are what the rest of this
  # stack reads, so the combined one goes.
  rm -f "$SEAL_DIR/.init.json"

  # Read back rather than trusting the write, because this is the last moment at
  # which a bad key is recoverable: the vault is initialised and empty, so the
  # fix is still "delete two volumes" and not "restore a backup".
  if [ "$(cat "$KEY_FILE")" != "$unseal_key" ]; then
    err "$KEY_FILE does not contain the key that was just written. Do not trust this vault."
    finish 1
  fi

  cat > "$SANDBOX_MARK" <<'MARK'
This volume contains the OpenBao UNSEAL KEY and the ROOT TOKEN, in clear text,
on the same machine as the data they open.

That is ARGUS_UNSEAL_MODE=sandbox. It exists so that one command produces a
working system on a laptop. ADR-0013 requires 3-of-5 Shamir shares held by three
named people, and this is not that.

  unseal.key   the single Shamir share. Whoever has it can unseal this vault.
  root.token   unrestricted access to every secret, with no policy and no TTL.

If you are reading this on anything other than a development laptop, treat every
secret in this vault as compromised and re-key it. Copying this volume -- into a
backup, an image, or another machine -- copies the keys with it.
MARK
  chmod 0600 "$SANDBOX_MARK"

  log "initialised. unseal key and root token written to $SEAL_DIR (0600)"
  read_status
fi

# ─────────────────────────────────────────────────────────── initialised now ─
# The disagreement check. It is here rather than in the sandbox branch because
# the interesting case is precisely the one where this run did NOT initialise:
# somebody set ARGUS_UNSEAL_MODE=ceremony on a vault that was born in sandbox
# mode, and now believes they are protected by a ceremony that never happened.
if [ "$MODE" = ceremony ] && [ "$S_SHARES" = 1 ]; then
  warn "═══════════════════════════════════════════════════════════════════════"
  warn "ARGUS_UNSEAL_MODE says ceremony, but this vault is sealed with ONE share."
  warn "Changing the variable does not re-key an existing vault. This vault was"
  warn "initialised in sandbox mode and is still a 1-of-1 seal; if $KEY_FILE"
  warn "exists, its key is also still on this disk."
  warn "To actually leave sandbox mode: 'bao operator rekey -init -key-shares=5"
  warn "-key-threshold=3' with the current key, or destroy argus_openbao_data and"
  warn "argus_openbao_seal and start again. Until then, treat this as sandbox."
  warn "═══════════════════════════════════════════════════════════════════════"
  note "MODE/SEAL DISAGREEMENT: ARGUS_UNSEAL_MODE=ceremony but the seal is 1-of-1. The seal is the truth; \
this deployment is still a sandbox."
fi
if [ "$MODE" = sandbox ] && [ "$S_SHARES" != 1 ] && [ "$S_SHARES" != null ]; then
  note "ARGUS_UNSEAL_MODE=sandbox but this vault is sealed with $S_SHARES shares, threshold $S_THRESHOLD. \
It was initialised by a ceremony and is NOT auto-unsealable; the unseal sidecar has no key for it and will \
say so rather than pretending."
fi

# ─────────────────────────────────────────────────────────────────── unseal ──
if [ "$S_SEALED" = true ]; then
  if [ -f "$KEY_FILE" ] && [ "$S_SHARES" = 1 ] && [ "$S_THRESHOLD" = 1 ]; then
    # The key is passed as an argument because OpenBao 2.6 refuses every other
    # route: piping into `bao operator unseal` fails with "file descriptor 0 is
    # not a terminal", and its own help says to pass the key as the first
    # argument when there is no TTY. So it is briefly visible to `ps` inside
    # this container -- which is the container whose whole purpose is to hold
    # that key on disk, so it adds no exposure that mode has not already given
    # away.
    bao operator unseal "$(cat "$KEY_FILE")" >/dev/null 2>&1
    # And the exit code is NOT the answer: `bao operator unseal` reports on the
    # share it accepted, not on the seal. Only the seal is proof.
    read_status
    if [ "$S_SEALED" = true ]; then
      err "the stored key at $KEY_FILE did not unseal this vault."
      err "The usual cause is a rebuilt argus_openbao_data beside a surviving argus_openbao_seal."
      err "The secrets in the old raft cannot be recovered from here; to start clean, remove BOTH volumes."
      note "the stored unseal key was rejected by this vault."
      finish 1
    fi
    log "unsealed with the stored key"

  elif [ -f "$KEY_FILE" ]; then
    # One key, a multi-share seal. Submitting it would be ACCEPTED and counted
    # -- OpenBao only verifies shares at the threshold (measured on 2.6.2) --
    # and would leave the key holders' own ceremony failing against a poisoned
    # progress counter that only `bao operator unseal -reset` clears.
    err "SEALED with a $S_THRESHOLD-of-$S_SHARES seal, and this container holds ONE key."
    err "It will not submit it: a foreign share is accepted and counted, and would break the"
    err "real unseal ceremony rather than failing cleanly. Somebody re-keyed this vault, or"
    err "ARGUS_UNSEAL_MODE=sandbox is pointed at a ceremony vault."
    note "sealed with a $S_THRESHOLD-of-$S_SHARES seal while only one stored key exists; refusing to submit it."
    finish 1

  else
    log "the vault is sealed and there is no stored key, which is correct for ceremony mode."
    # $S_THRESHOLD, not the CEREMONY_THRESHOLD constant: this vault's seal is
    # known by now, and printing the number this file wishes for rather than the
    # one the vault has is how an operator ends up unsealing three times against
    # a seal that wanted five.
    log "Unseal it: docker compose exec openbao bao operator unseal   (x$S_THRESHOLD, one per holder)"
    note "sealed, waiting for the unseal ceremony. Nothing else can be provisioned until then."
    finish 0
  fi
fi

# ────────────────────────────────────────────────────────────────── the token ─
# Sandbox reads the root token it stored. Ceremony takes it from the
# environment for one run and never writes it anywhere -- which is the whole
# reason ceremony provisioning is a second, human-triggered pass.
if [ -n "${BAO_TOKEN:-}" ]; then
  log "authenticating with BAO_TOKEN from the environment"
elif [ -f "$ROOT_FILE" ]; then
  BAO_TOKEN=$(cat "$ROOT_FILE")
  export BAO_TOKEN
  log "authenticating with the stored root token (sandbox)"
else
  log "the vault is unsealed but this container holds no token, so it cannot provision anything."
  log "That is the expected state in ceremony mode. Run pass two:"
  log "  docker compose --profile secrets run --rm -e BAO_TOKEN bao-init"
  note "unsealed but not provisioned: no token available to this container. Run pass two with BAO_TOKEN set."
  finish 0
fi

if ! bao token lookup >/dev/null 2>&1; then
  err "the token this container holds was rejected by the vault."
  if [ -f "$ROOT_FILE" ]; then
    err "$ROOT_FILE is stale -- most likely the vault was rebuilt while argus_openbao_seal survived,"
    err "or the token was revoked. Mint a new one with three key shares: bao operator generate-root"
  fi
  note "the available token was rejected; nothing was provisioned."
  finish 1
fi

# ───────────────────────────────────────────────────────────── provisioning ──
# Everything from here is idempotent by construction and runs on every boot, so
# that what is in the repository is what is in the vault. Note what is NOT here:
# there is no `bao audit enable`. OpenBao 2.6 refuses to create an audit device
# over the API ("use declarative, config-based audit device management
# instead"), so the audit device lives in config/openbao.hcl and this script
# would only be able to fail at it.
ensure_kv
ensure_transit
ensure_database
apply_policies
ensure_console_approle
write_mode_marker

# ADR-0013 gives OpenBao the estate's secrets and AD CS the estate's
# certificates. There is deliberately no `bao secrets enable pki` here: two PKIs
# issuing into one trust store is how a certificate nobody can trace gets
# accepted by everything.

S_PROVISIONED=true
log "provisioning complete."
[ "$MODE" = sandbox ] && sandbox_banner
finish 0
