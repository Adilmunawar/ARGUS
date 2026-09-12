#!/bin/sh

set -eu

HOST="${GARNET_HOST:-garnet}"
PORT=6379
CONSOLE_USER=console

ATTEMPTS=20
DELAY=2

say()  { printf 'garnet-init: %s\n' "$*"; }
fail() { printf 'garnet-init: FAILED: %s\n' "$*" >&2; exit 1; }

anon() {
  valkey-cli -h "$HOST" -p "$PORT" "$@" 2>&1 || true
}

as_console() {
  REDISCLI_AUTH="$GARNET_CONSOLE_PASSWORD" \
    valkey-cli -h "$HOST" -p "$PORT" --user "$CONSOLE_USER" "$@" 2>&1 || true
}

if [ -z "${GARNET_CONSOLE_PASSWORD:-}" ]; then
  fail "GARNET_CONSOLE_PASSWORD is empty. Run bootstrap.ps1 in platform/compose,
             which generates it into .env and renders secrets/garnet/users.acl from it."
fi

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

say "checking that services/cache/garnet.conf is the configuration in force"

config_get_reply=$(as_console CONFIG GET logdir databases expired-key-deletion-scan-freq | tr -d '\r')
case "$config_get_reply" in
  *NOPERM*)
    fail "'$CONSOLE_USER' may not run CONFIG GET, so nothing here can prove which
             configuration Garnet actually loaded. Add +config|get to the
             '$CONSOLE_USER' rule in secrets/garnet/users.acl. +config|set stays
             denied and the check below is the reason +config|get is not optional."
    ;;
esac

config_value() {
  printf '%s\n' "$config_get_reply" \
    | awk -v want="$1" 'NR % 2 == 1 { name = $0; next } name == want { print; exit }'
}

log_dir=$(config_value logdir)
databases=$(config_value databases)
expiry_scan=$(config_value expired-key-deletion-scan-freq)

if [ -z "$log_dir" ]; then
  fail "CONFIG GET logdir came back with no value. Garnet drops parameter names it
             does not recognise from the request instead of erroring, so an empty
             reply here means this server has no 'logdir' parameter at all and is
             not the Garnet this stack pins (GARNET_TAG, default 2.1.5)."
fi

if [ "$log_dir" != "/data" ]; then
  fail "the server reports logdir='$log_dir', not /data.
             services/cache/garnet.conf was not the configuration that loaded, so
             none of the memory, compaction or ACL settings in it are in force
             either. Check the ./services/cache:/etc/garnet/conf mount and:
             docker compose logs garnet"
fi

if [ "$databases" != "1" ]; then
  fail "the server reports databases='${databases:-<empty>}', and garnet.conf
             declares MaxDatabases 1. A server with more than one database accepts
             SELECT, so a client that picks db1 writes into a database nothing else
             reads and no backup covers. Check the same mount as above."
fi

if [ "$expiry_scan" != "3600" ]; then
  fail "the server reports expired-key-deletion-scan-freq='${expiry_scan:-<empty>}',
             and garnet.conf declares ExpiredKeyDeletionScanFrequencySecs 3600. The
             Garnet default is -1, which is OFF: expired keys are then reclaimed only
             when something happens to touch them, so a write-once cache grows
             without bound on a server that has no eviction to fall back on. Check
             the same mount as above."
fi

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

log_max=$(field 'Log[.]MaxMemorySizeBytes')
log_now=$(field 'Log[.]CurrentMemorySizeBytes')
addr_begin=$(field 'Log[.]BeginAddress')
addr_head=$(field 'Log[.]HeadAddress')
addr_tail=$(field 'Log[.]TailAddress')

say ""
say "─────────────────────────────────────────────────────────────────────────"
say "cache is up and the console credential is correctly constrained."
say ""
say "  spill directory      $log_dir  (argus_garnet_data volume)"
say "  databases            $databases   expired-key scan every ${expiry_scan}s"
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
