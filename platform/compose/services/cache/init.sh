#!/bin/sh
# ═══════════════════════════════════════════════════════════════════════════
# garnet-init — prove the cache is usable, and prove it is locked down.
#
# Runs once per `docker compose up` in a valkey/valkey container (Garnet's own
# image ships no client), on the `argus` network, after the garnet container
# reports healthy. It writes nothing and changes nothing, so re-running it is
# free -- which matters, because Compose re-runs every exited one-shot on every
# `up` and an init container that is not idempotent breaks the second boot.
#
# ── WHY THIS EXISTS AT ALL ────────────────────────────────────────────────
#
# A TCP port opening is not readiness, and the container healthcheck is weaker
# still. That probe speaks raw RESP to 127.0.0.1:6379 and passes if the answer
# contains PONG *or* NOAUTH -- it has to, because it runs before any credential
# exists to authenticate with. So it goes GREEN on a Garnet with
# authentication switched off entirely, which is the single worst state this
# service can be in and is invisible from every other signal in the stack.
#
# Garnet reaches that state quietly. Its ACL loader clears all users, imports
# the ACL file, and then creates `default` with +@all and NOPASS if -- and only
# if -- the file did not define one. Drop the `user default off` line from
# secrets/garnet/users.acl and every anonymous connection gets full rights,
# FLUSHALL included, while the healthcheck stays green and the console keeps
# drawing a healthy cache.
#
# This script is the thing that can see that. Four assertions, in the order
# that makes a failure diagnosable:
#
#   1. an UNAUTHENTICATED command is refused                (auth is on)
#   2. the console credential authenticates and works       (the ACL loaded,
#                                                            and .env agrees
#                                                            with the file)
#   3. the console cannot READ a value                      (no +get)
#   4. the console cannot WIPE or RECONFIGURE the cache     (no +flushall,
#                                                            no +config|set)
#
# ── THE DESTRUCTIVE PROBES ARE ARITY-GUARDED ON PURPOSE ───────────────────
#
# Asserting "FLUSHALL is denied" by sending FLUSHALL means that on the one day
# the assertion fails, the test IS the outage it was written to prevent. So the
# destructive probes are sent in a deliberately malformed form: Garnet checks
# ACL permission during dispatch and argument count inside the command handler,
# in that order, so a denied command still answers NOPERM, while a WRONGLY
# PERMITTED one is rejected on arity before it can flush anything.
#
#   FLUSHALL takes at most 3 arguments -> four arguments cannot reach the flush
#   CONFIG SET requires argument pairs  -> zero arguments cannot set anything
#
# GET needs no such guard: reading a key that does not exist returns nil.
#
# NOTE ON LINE ENDINGS: compose runs this as `/bin/sh /init.sh` with no CRLF
# stripping (unlike nats-init and bao-init, whose entrypoints pipe through
# `tr -d '\r'`). A CRLF checkout fails on the first line of real code with an
# error naming neither this file nor the cause, and no guard inside the script
# can help -- sh has already choked on the \r before it reads one. .gitattributes
# keeps this file LF; do not defeat it.
# ═══════════════════════════════════════════════════════════════════════════

set -eu

# The in-network name and port. GARNET_PORT in .env changes only the HOST-side
# publish (127.0.0.1:${GARNET_PORT}:6379); inside the argus network the port is
# always 6379. GARNET_HOST is overridable so this script can be pointed at a
# throwaway instance when it is being worked on, and for no other reason.
HOST="${GARNET_HOST:-garnet}"
PORT=6379
CONSOLE_USER=console

# The server is healthy before this container starts, so the wait is short by
# design: it covers the gap between "healthcheck passed" and "the ACL file has
# been parsed", not a cold boot.
ATTEMPTS=20
DELAY=2

say()  { printf 'garnet-init: %s\n' "$*"; }
fail() { printf 'garnet-init: FAILED: %s\n' "$*" >&2; exit 1; }

# Every probe returns the server's REPLY AS TEXT and never as an exit code.
# valkey-cli's exit status does not distinguish "the server said NOPERM" from
# "the connection was refused", so an assertion written against it reports a
# down cache as a correctly-denied command. Matching the reply cannot make that
# mistake. The `|| true` keeps `set -e` from killing the script on the error
# replies this script exists to provoke.
anon() {
  valkey-cli -h "$HOST" -p "$PORT" "$@" 2>&1 || true
}

# REDISCLI_AUTH, never -a or --pass: an argument is visible in `ps` inside this
# container and in `docker inspect` of it, and valkey-cli itself warns about
# exactly that. The password still reaches this process's environment -- that
# is the same exposure the compose file already accepts and documents -- but it
# does not additionally end up in a process table.
as_console() {
  REDISCLI_AUTH="$GARNET_CONSOLE_PASSWORD" \
    valkey-cli -h "$HOST" -p "$PORT" --user "$CONSOLE_USER" "$@" 2>&1 || true
}

# ─────────────────────────────────────────────────────────── preconditions ──

# Compose already refuses to start without this (${GARNET_CONSOLE_PASSWORD:?}),
# so reaching here empty means someone set it to the empty string, which would
# otherwise present as a confusing WRONGPASS three steps further down.
if [ -z "${GARNET_CONSOLE_PASSWORD:-}" ]; then
  fail "GARNET_CONSOLE_PASSWORD is empty. Run bootstrap.ps1 in platform/compose,
             which generates it into .env and renders secrets/garnet/users.acl from it."
fi

# ── 1. anonymous access is refused ──────────────────────────────────────────
#
# Doubles as the readiness wait: the loop ends when the server gives a RESP
# answer of any kind, which is strictly later than the port accepting.

say "waiting for $HOST:$PORT to answer RESP"
anon_reply=""
attempt=1
while [ "$attempt" -le "$ATTEMPTS" ]; do
  anon_reply=$(anon PING)
  case "$anon_reply" in
    *NOAUTH*)
      say "unauthenticated PING refused with NOAUTH -- authentication is on"
      break
      ;;
    *PONG*)
      # The state the healthcheck cannot see, named as precisely as it can be.
      fail "AUTHENTICATION IS OFF. An unauthenticated PING was answered with PONG,
             so this Garnet accepts anonymous connections -- and an anonymous
             connection Garnet created itself holds +@all, which includes FLUSHALL.
             The container healthcheck passes in this state; that is why this check
             exists. Two causes, in order of likelihood:
               * secrets/garnet/users.acl is missing its 'user default off' line.
                 Garnet recreates a passwordless, all-powerful 'default' user when
                 the ACL file does not define one. Re-run bootstrap.ps1.
               * services/cache/garnet.conf was not read, so AuthenticationMode
                 stayed NoAuth. Check the ./services/cache mount and look for the
                 config-import line in: docker compose logs garnet"
      ;;
    *)
      # Connection refused, empty reply, DNS not resolving yet: keep waiting.
      attempt=$((attempt + 1))
      sleep "$DELAY"
      ;;
  esac
done

case "$anon_reply" in
  *NOAUTH*) : ;;
  *) fail "$HOST:$PORT never returned a RESP reply after $((ATTEMPTS * DELAY))s.
             Last thing it said: ${anon_reply:-<nothing>}
             Check: docker compose ps garnet && docker compose logs garnet" ;;
esac

# ── 2. the console credential works ─────────────────────────────────────────
#
# THE READINESS GATE. This is the first point at which the cache is known to be
# usable by something holding a real credential; everything before it proves
# only that a socket and a parser are alive.

say "authenticating as '$CONSOLE_USER'"
ping_reply=""
attempt=1
while [ "$attempt" -le "$ATTEMPTS" ]; do
  ping_reply=$(as_console PING)
  case "$ping_reply" in
    *WRONGPASS*|*"invalid username"*|*"Invalid username"*)
      fail "the '$CONSOLE_USER' credential was rejected (WRONGPASS).
             GARNET_CONSOLE_PASSWORD in .env and the password in
             secrets/garnet/users.acl disagree, or that file has no
             '$CONSOLE_USER' rule at all. Both are written by bootstrap.ps1 from
             one value, so re-running it fixes the pair together; editing .env by
             hand does not, because Garnet reads no environment variables and only
             ever sees the ACL file."
      ;;
    *PONG*)
      break
      ;;
    *NOPERM*)
      fail "'$CONSOLE_USER' authenticated but may not even PING. Its rule in
             secrets/garnet/users.acl is missing +ping. The console's health tile
             and the container healthcheck's authenticated equivalent both depend
             on it."
      ;;
    *)
      attempt=$((attempt + 1))
      sleep "$DELAY"
      ;;
  esac
done

case "$ping_reply" in
  *PONG*) say "authenticated PING answered -- the cache is accepting real work" ;;
  *) fail "'$CONSOLE_USER' could not complete an authenticated PING after
             $((ATTEMPTS * DELAY))s. Last reply: ${ping_reply:-<nothing>}" ;;
esac

# ── 3. the console cannot read values ───────────────────────────────────────
#
# The console is a dashboard, not a client. If this assertion ever fails, the
# console process -- which is reachable from a browser -- has become able to
# read session tokens and survey data out of the cache.

say "checking that '$CONSOLE_USER' cannot read values"
read_reply=$(as_console GET argus:acl-probe:should-not-be-readable)
case "$read_reply" in
  *NOPERM*)
    say "  GET  -> NOPERM (denied)"
    ;;
  *)
    fail "'$CONSOLE_USER' CAN READ THE CACHE. GET was not denied; it answered:
             ${read_reply:-<empty>}
             Remove +get (and +mget, +getrange, +hgetall, +keys, +scan, and any
             '+@read' or '+@all' category grant) from the '$CONSOLE_USER' rule in
             secrets/garnet/users.acl. Categories are the usual cause: +@read and
             +@fast both carry GET."
    ;;
esac

# ── 4. the console cannot wipe or reconfigure the cache ─────────────────────
#
# Both probes are malformed on purpose; see the header. A NOPERM here is the ACL
# refusing the command outright. An arity error instead means the ACL PERMITTED
# it and only the bad argument count stopped it -- so an arity error is a
# FAILURE of this assertion, not a pass, and is reported as one.

say "checking that '$CONSOLE_USER' cannot wipe or reconfigure the cache"

flush_reply=$(as_console FLUSHALL ARGUS ACL PROBE GUARD)
case "$flush_reply" in
  *NOPERM*)
    say "  FLUSHALL   -> NOPERM (denied)"
    ;;
  *)
    fail "'$CONSOLE_USER' CAN FLUSH THE CACHE. FLUSHALL was not denied; it answered:
             ${flush_reply:-<empty>}
             (Nothing was flushed: the probe carried four arguments and FLUSHALL
             takes at most three, so Garnet rejected it on arity after allowing it.
             The grant is still wrong.)
             Remove +flushall / +flushdb / any '+@all' or '+@dangerous' grant from
             the '$CONSOLE_USER' rule in secrets/garnet/users.acl."
    ;;
esac

config_reply=$(as_console CONFIG SET)
case "$config_reply" in
  *NOPERM*)
    say "  CONFIG SET -> NOPERM (denied)"
    ;;
  *)
    fail "'$CONSOLE_USER' CAN RECONFIGURE THE SERVER. CONFIG SET was not denied;
             it answered: ${config_reply:-<empty>}
             (Nothing was changed: the probe carried no argument pairs.)
             This is not a cosmetic grant -- Garnet's CONFIG SET resizes the main
             log and the hash index at runtime, so it can push the store past the
             container memory limit and OOM the cache. Remove +config|set from the
             '$CONSOLE_USER' rule in secrets/garnet/users.acl. +config|get is the
             one the metrics exporter needs; +config|set is not."
    ;;
esac

# ── what the server actually reports ────────────────────────────────────────
#
# Measured, not restated from garnet.conf. LogDir is the useful one: it is the
# server telling us which directory it will spill to, which is also positive
# proof that this config file -- and not Garnet's defaults -- is the one in
# force. Everything here is read through INFO, the only window a user with no
# read privilege has.

store=$(as_console INFO STORE | tr -d '\r')
case "$store" in
  *NOPERM*)
    fail "'$CONSOLE_USER' may not run INFO. That is not a small gap: INFO is the
             ONLY window a user with no read privilege has, so the console's cache
             screen has nothing at all to draw. Add +info to the '$CONSOLE_USER'
             rule in secrets/garnet/users.acl."
    ;;
esac

field() { printf '%s\n' "$store" | sed -n "s|^$1:||p" | head -n 1; }

log_dir=$(field 'LogDir')
log_max=$(field 'Log[.]MaxMemorySizeBytes')
log_now=$(field 'Log[.]CurrentMemorySizeBytes')
addr_begin=$(field 'Log[.]BeginAddress')
addr_head=$(field 'Log[.]HeadAddress')
addr_tail=$(field 'Log[.]TailAddress')

if [ "$log_dir" != "/data" ]; then
  fail "the server reports LogDir='${log_dir:-<empty>}', not /data.
             services/cache/garnet.conf was not the configuration that loaded, so
             none of the memory, compaction or ACL settings in it are in force
             either. Check the ./services/cache:/etc/garnet/conf mount and:
             docker compose logs garnet"
fi

# ── the summary an operator needs, and the two limits it must not hide ──────

say ""
say "─────────────────────────────────────────────────────────────────────────"
say "cache is up and the console credential is correctly constrained."
say ""
say "  spill directory      $log_dir  (argus_garnet_data volume)"
say "  in-memory log        ${log_now:-unknown} of ${log_max:-unknown} bytes"
say "  log addresses        begin=${addr_begin:-unknown} head=${addr_head:-unknown} tail=${addr_tail:-unknown}"
say ""
say "  THERE IS NO maxmemory AND NO EVICTION. Those numbers are not a quota."
say "  Records between begin and head are ON DISK and still live; records"
say "  between head and tail are in memory. Past the in-memory log size Garnet"
say "  SPILLS, it does not evict, so the pressure signal is head moving away"
say "  from begin -- not a memory percentage, and never an eviction count,"
say "  which is a metric this server does not have. The container mem_limit"
say "  (GARNET_MEM_LIMIT) is the only backstop there is."
say ""
say "  GARNET ACLs HAVE NO KEY PATTERNS. The '~*' in users.acl is accepted and"
say "  then ignored; any narrower pattern ('~cache:*', '~session:*') is an"
say "  unknown operation and the SERVER REFUSES TO START. There is no per-prefix"
say "  key isolation on Garnet -- only credential and command separation. Two"
say "  tenants that must not see each other's keys need two Garnet instances,"
say "  not two ACL rules, and no amount of care in users.acl changes that."
say "─────────────────────────────────────────────────────────────────────────"

exit 0
