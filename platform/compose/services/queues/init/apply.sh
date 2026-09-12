#!/bin/sh

set -eu

WARNINGS=0
FAILURES=0
say()  { printf '%s\n' "$*"; }
warn() { printf 'WARNING  %s\n' "$*" >&2; WARNINGS=$((WARNINGS + 1)); }
fail() { printf 'FAILED   %s\n' "$*" >&2; FAILURES=$((FAILURES + 1)); }
die()  { printf 'FATAL    %s\n' "$*" >&2; exit 1; }

dur_ns() {
  v="$1"; n="${v%[smh]}"; u="${v#"$n"}"
  case "$u" in
    s) echo $((n * 1000000000)) ;;
    m) echo $((n * 60000000000)) ;;
    h) echo $((n * 3600000000000)) ;;
    *) echo '' ;;
  esac
}

bytes_of() {
  v="$1"
  case "$v" in
    *GB) n="${v%GB}"; echo $((n * 1073741824)) ;;
    *MB) n="${v%MB}"; echo $((n * 1048576)) ;;
    *KB) n="${v%KB}"; echo $((n * 1024)) ;;
    *)   echo "$v" ;;
  esac
}

drift_of() {
  printf '%s' "$1" | jq -S -r --argjson want "$2" '
    . as $have
    | $want
    | to_entries[]
    | select($have[.key] != .value)
    | "\(.key): server=\($have[.key] | tojson) declared=\(.value | tojson)"'
}

merged_of() {
  printf '%s' "$1" | jq --argjson want "$2" '. * $want'
}

show_drift() {
  printf '%s\n' "$1" | sed 's/^/         /' >&2
}

STREAM_CFG=/tmp/nats-init-stream.json
CONSUMER_CFG=/tmp/nats-init-consumer.json

nats_() { nats "$@" </dev/null; }

: "${NATS_URL:?nats-init needs NATS_URL (docker-compose.yml sets it)}"
: "${NATS_USER:?nats-init needs NATS_USER}"
: "${NATS_PASSWORD:?nats-init needs NATS_PASSWORD; bootstrap.ps1 generates it}"

REPLICAS="${ARGUS_NATS_REPLICAS:-1}"

say "nats-init: $NATS_URL as $NATS_USER, replicas=$REPLICAS"

attempt=0
until nats_ account info >/dev/null 2>&1; do
  attempt=$((attempt + 1))
  if [ "$attempt" -ge 30 ]; then
    die "the JetStream API did not answer for $NATS_USER after 60s. Check \`docker compose logs nats\`: a
         wrong password is an Authorization Violation there, and an unset one stops the server booting at all."
  fi
  sleep 2
done
say "nats-init: JetStream API answered after $((attempt * 2))s"

limits="$(nats_ account info 2>/dev/null || true)"
case "$limits" in
  *"Stream Requires Max Bytes Set: true"*)
    say "nats-init: account limits are in force (max_bytes_required=true)" ;;
  *"Stream Requires Max Bytes Set: false"*)
    die "this server has NO account-level JetStream limits. It is not running the committed
         services/queues/nats-server.conf -- check the bind mount in docker-compose.yml." ;;
  *)
    warn "could not read the account limits from this nats CLI, so the server's configuration is
          UNVERIFIED here. The stream creates below still enforce their own bounds." ;;
esac

create_stream() {
  name="$1"; subjects="$2"; retention="$3"; discard="$4"
  max_age="$5"; max_bytes="$6"; dupe="$7"; desc="$8"

  subjects_json="$(printf '%s\n' $subjects | jq -R . | jq -s -c .)"
  want="$(jq -n -c \
    --argjson subjects "$subjects_json" \
    --arg retention "$retention" \
    --arg discard "$discard" \
    --arg desc "$desc" \
    --argjson max_age "$(dur_ns "$max_age")" \
    --argjson max_bytes "$(bytes_of "$max_bytes")" \
    --argjson dupe "$(dur_ns "$dupe")" \
    --argjson replicas "$REPLICAS" \
    '{ subjects: $subjects, retention: $retention, discard: $discard, storage: "file",
       max_age: $max_age, max_bytes: $max_bytes, duplicate_window: $dupe,
       num_replicas: $replicas, description: $desc }')"

  if nats_ stream info "$name" >/dev/null 2>&1; then
    have="$(nats_ stream info "$name" -j | jq -c '.config')"

    immutable="$(drift_of "$have" "$(printf '%s' "$want" | jq -c '{retention, storage}')")"
    if [ -n "$immutable" ]; then
      show_drift "$immutable"
      die "$name cannot be converged. retention and storage are the two fields JetStream refuses to
         update on a live stream, so matching this declaration means deleting the stream and
         recreating it, which destroys every message it still holds. Nothing here does that silently:
         decide deliberately, then \`nats stream rm $name\` and re-run this one-shot."
    fi

    drift="$(drift_of "$have" "$want")"
    if [ -z "$drift" ]; then
      say "  = $name matches this file"
      return 0
    fi

    show_drift "$drift"
    merged_of "$have" "$want" > "$STREAM_CFG"
    if converge_output="$(nats_ stream edit "$name" --config "$STREAM_CFG" -f 2>&1)"; then
      say "  ~ $name converged"
    else
      fail "$name drifted from this file and could not be converged: $converge_output
         Every field listed above is updatable in place on a live stream, so a refusal here is the
         client or the connection, not JetStream policy. The stream keeps its current configuration
         until this is resolved."
    fi
    return 0
  fi

  set -- stream add "$name" \
    --storage file --retention "$retention" --discard "$discard" \
    --max-age "$max_age" --max-bytes "$max_bytes" --dupe-window "$dupe" \
    --replicas "$REPLICAS" --description "$desc" \
    --max-msgs=-1 --max-msgs-per-subject=-1 --max-msg-size=-1 --max-consumers=-1 \
    --allow-direct --no-allow-rollup --no-deny-delete --no-deny-purge --defaults
  for s in $subjects; do set -- "$@" --subjects "$s"; done
  nats_ "$@" >/dev/null || die "could not create stream $name"
  say "  + $name created"
}

say "nats-init: streams"
while IFS='|' read -r name subjects retention discard max_age max_bytes dupe desc; do
  case "$name" in ''|'#'*) continue ;; esac
  create_stream "$name" "$subjects" "$retention" "$discard" "$max_age" "$max_bytes" "$dupe" "$desc"
done <<'STREAMS'
ARGUS_INGEST|argus.ingest.>|limits|new|168h|256MB|10m|Shapefile and survey ingest jobs (ADR-0010). Payloads are S3 keys, never files.
ARGUS_EXPORT|argus.export.>|limits|new|168h|256MB|10m|Export jobs. A refused publish is better than a silently dropped export.
ARGUS_PIPELINE|argus.pipeline.>|limits|new|168h|128MB|10m|Dagster and scheduler step events.
ARGUS_AI|argus.ai.>|limits|old|72h|128MB|2m|AI briefing requests and the audit trail. Loki holds the durable copy (90d at Site A); this is transport.
ARGUS_SENTINEL|argus.sentinel.>|limits|old|168h|128MB|2m|Sentinel scene notifications. Replayable from the scene itself, so the newest matters more than the oldest.
ARGUS_DEADLETTER|argus.dlq.> $JS.EVENT.ADVISORY.CONSUMER.MAX_DELIVERIES.>|limits|old|48h|64MB|2m|Dead letters: server max-delivery advisories (pointers) and bodies applications republished.
STREAMS

is_positive_int() {
  case "${1:-}" in
    ''|*[!0-9]*) return 1 ;;
    *) [ "$1" -gt 0 ] ;;
  esac
}

dlq_age="$(nats_ stream info ARGUS_DEADLETTER -j | jq -r '.config.max_age')"
is_positive_int "$dlq_age" || die "could not read ARGUS_DEADLETTER's max_age from the server; it answered
         '${dlq_age:-<nothing>}'. The dead-letter retention check below compares numbers, and a
         non-numeric answer would make it pass without comparing anything."
for s in ARGUS_INGEST ARGUS_EXPORT ARGUS_PIPELINE ARGUS_AI ARGUS_SENTINEL; do
  src_age="$(nats_ stream info "$s" -j | jq -r '.config.max_age')"
  is_positive_int "$src_age" || die "could not read $s's max_age from the server; it answered
         '${src_age:-<nothing>}'. See the note above: an unread max_age silently skips this check."
  if [ "$dlq_age" -ge "$src_age" ]; then
    die "ARGUS_DEADLETTER keeps pointers for ${dlq_age}ns but $s keeps the bodies for only ${src_age}ns.
         Every dead letter older than $s's max_age would point at a message that no longer exists.
         Raise $s --max-age, or lower ARGUS_DEADLETTER --max-age. Do not ship it this way round."
  fi
done
say "nats-init: dead-letter pointers expire before the bodies they point at (checked against the server)"

create_consumer() {
  stream="$1"; cname="$2"; filter="$3"; ackwait="$4"; maxdel="$5"
  bmin="$6"; bmax="$7"; bsteps="$8"; desc="$9"

  if nats_ consumer info "$stream" "$cname" >/dev/null 2>&1; then
    have="$(nats_ consumer info "$stream" "$cname" -j | jq -c '.config')"
    have_bo="$(printf '%s' "$have" | jq -r 'if (.backoff // []) | length > 0 then "set" else "none" end')"
    if [ "$have_bo" = "none" ]; then
      warn "$stream/$cname has no backoff policy, so every retry is spaced exactly $ackwait apart. A failing
            upstream then gets $maxdel evenly-spaced hammerings instead of a widening gap. Not dangerous,
            but it is not what this file declares."
    fi

    want="$(jq -n -c \
      --arg filter "$filter" \
      --arg desc "$desc" \
      --argjson ack "$(dur_ns "$ackwait")" \
      --argjson maxdel "$maxdel" \
      '{ filter_subject: $filter, description: $desc, ack_wait: $ack, max_deliver: $maxdel }')"

    drift="$(drift_of "$have" "$want")"
    if [ -z "$drift" ]; then
      say "  = $stream/$cname matches this file"
    else
      show_drift "$drift"
      merged_of "$have" "$want" \
        | jq 'if (.backoff // []) | length > 0 then .backoff[0] = .ack_wait else . end' > "$CONSUMER_CFG"
      if converge_output="$(nats_ consumer add "$stream" "$cname" --config "$CONSUMER_CFG" -f 2>&1)"; then
        say "  ~ $stream/$cname converged"
      else
        fail "$stream/$cname drifted from this file and could not be converged: $converge_output
         None of the fields above is in the set JetStream refuses to update on a live consumer
         (deliver policy, start sequence, start time, ack policy, replay policy, heartbeats, flow
         control, pull/push and max waiting), so a refusal here is the client or the connection.
         The consumer keeps its current configuration, and its ack and redelivery state, until this
         is resolved."
      fi
    fi
    verify_ack_wait "$stream" "$cname" "$ackwait"
    return 0
  fi

  nats_ consumer add "$stream" "$cname" \
    --pull --ack explicit --wait "$ackwait" --max-deliver "$maxdel" \
    --filter "$filter" --deliver all --replay instant \
    --max-pending 64 --max-waiting 128 \
    --backoff linear --backoff-min "$bmin" --backoff-max "$bmax" --backoff-steps "$bsteps" \
    --description "$desc" --defaults >/dev/null || die "could not create consumer $stream/$cname"
  verify_ack_wait "$stream" "$cname" "$ackwait"
  say "  + $stream/$cname created"
}

verify_ack_wait() {
  want_ns="$(dur_ns "$3")"
  [ -n "$want_ns" ] || return 0
  have_ns="$(nats_ consumer info "$1" "$2" -j | jq -r '.config.ack_wait')"
  [ "$have_ns" = "$want_ns" ] && return 0
  fail "$1/$2 was declared with ack_wait=$3 (${want_ns}ns) and the server stored ${have_ns}ns.
         A consumer whose ack_wait is shorter than the work redelivers jobs that are still running and
         dead-letters them for succeeding slowly.
         The cause is always the backoff policy: whenever one is set, the server OVERWRITES ack_wait
         with backoff[0] and reports no error, so an ack_wait and a backoff_min that disagree produce
         a consumer that silently does not match its declaration. Make the backoff_min column equal
         the ack_wait column in the table above; this script already writes backoff[0] from ack_wait
         when it converges an existing consumer.
         Repairing this does NOT require deleting the consumer and does NOT reset its delivery state.
         \`nats consumer edit\` refuses with 'consumers with backoff policies do not support editing
         Ack Wait', but that string is a natscli client-side guard, not a server rule: ack_wait is not
         among the fields JetStream refuses to update, and the full-config form used above --
         \`nats consumer add $1 $2 --config <file> -f\` -- applies it in place."
}

say "nats-init: consumers"
while IFS='|' read -r stream cname filter ackwait maxdel bmin bmax bsteps desc; do
  case "$stream" in ''|'#'*) continue ;; esac
  create_consumer "$stream" "$cname" "$filter" "$ackwait" "$maxdel" "$bmin" "$bmax" "$bsteps" "$desc"
done <<'CONSUMERS'
ARGUS_INGEST|mills-ingest-worker|argus.ingest.mills.>|5m|5|5m|20m|5|Shapefile ingest. ack_wait 5m because a large parcel set genuinely takes minutes; a longer job must send in-progress acks rather than raise this.
ARGUS_EXPORT|export-worker|argus.export.>|2m|4|2m|10m|4|Export generation.
ARGUS_PIPELINE|pipeline-runner|argus.pipeline.>|2m|4|2m|10m|4|Pipeline step execution.
ARGUS_SENTINEL|scene-indexer|argus.sentinel.scene.>|1m|3|1m|5m|3|STAC/pgstac indexing of a landed scene.
CONSUMERS

create_kv() {
  b="$1"; ttl="$2"; maxb="$3"; maxv="$4"; desc="$5"
  if nats_ kv status "$b" >/dev/null 2>&1; then say "  = kv $b exists"; return 0; fi
  nats_ kv add "$b" --history 1 --ttl "$ttl" --storage file \
    --max-bucket-size "$maxb" --max-value-size "$maxv" \
    --replicas "$REPLICAS" --description "$desc" >/dev/null || die "could not create kv bucket $b"
  say "  + kv $b created"
}

say "nats-init: kv buckets"
create_kv argus_jobs  24h 64MB 64KB "Async job status: one key per job id, written by the worker, polled by the console."
create_kv argus_locks  5m  8MB  1KB "Singleton locks for schedulers. TTL 5m so a dead holder releases itself."

nats_ stream rm ARGUS_SELFTEST -f >/dev/null 2>&1 || true
nats_ stream add ARGUS_SELFTEST --subjects 'argus.selftest.>' --storage file \
  --retention limits --discard old --max-age 5m --max-bytes 1MB --dupe-window 2m \
  --replicas "$REPLICAS" --max-msgs=-1 --max-msgs-per-subject=-1 --max-msg-size=-1 \
  --max-consumers=-1 --description 'Ephemeral: nats-init publish probe. Removed at the end of the run.' \
  --defaults >/dev/null || die "could not create the self-test stream"
nats_ pub argus.selftest.probe "nats-init $(date -u +%Y-%m-%dT%H:%M:%SZ)" >/dev/null 2>&1 \
  || die "publish to argus.selftest.probe failed: JetStream accepted the stream but cannot store a message.
          Check that /data is writable in the nats container and that the account is not already full."
stored="$(nats_ stream info ARGUS_SELFTEST -j | jq -r '.state.messages')"
[ "$stored" = "1" ] || die "published one message and the stream reports $stored stored."
nats_ stream rm ARGUS_SELFTEST -f >/dev/null 2>&1 || warn "could not remove ARGUS_SELFTEST; remove it by hand."
say "nats-init: publish probe stored and read back 1 message"

say ""
say "STREAM             RETENTION  DISCARD  MAX_BYTES     MAX_AGE  REPL  MSGS  CONSUMERS"
for s in ARGUS_INGEST ARGUS_EXPORT ARGUS_PIPELINE ARGUS_AI ARGUS_SENTINEL ARGUS_DEADLETTER; do
  nats_ stream info "$s" -j | jq -r '
    [ .config.name,
      .config.retention,
      .config.discard,
      ((.config.max_bytes / 1048576 | floor | tostring) + "MB"),
      ((.config.max_age / 60000000000 | floor | tostring) + "m"),
      (.config.num_replicas | tostring),
      (.state.messages | tostring),
      (.state.consumer_count | tostring)
    ] | @tsv' \
  | awk -F'\t' '{ printf "%-18s %-10s %-8s %-11s %8s  %4s %5s  %s\n", $1,$2,$3,$4,$5,$6,$7,$8 }'
done
say ""
say "CONSUMER                              ACK_WAIT  MAX_DELIVER  PENDING  ACK_PENDING"
nats_ stream ls -n | while read -r s; do
  [ -n "$s" ] || continue
  nats_ consumer ls "$s" -n 2>/dev/null | while read -r c; do
    [ -n "$c" ] || continue
    nats_ consumer info "$s" "$c" -j | jq -r '
      [ (.stream_name + "/" + .name),
        ((.config.ack_wait / 1000000000 | floor | tostring) + "s"),
        (.config.max_deliver | tostring),
        (.num_pending | tostring),
        (.num_ack_pending | tostring)
      ] | @tsv' \
    | awk -F'\t' '{ printf "%-37s %8s  %11s  %7s  %11s\n", $1,$2,$3,$4,$5 }'
  done
done
say ""
nats_ account info | sed -n '/Tier/,$p' | sed 's/^/  /'

if [ "$REPLICAS" = "1" ]; then
  say ""
  say "NOTE  Every stream above is R1 on a single node. There is no redundancy here and none is"
  say "      implied: if this container's volume is lost, every queued job is lost with it. Site A"
  say "      must create these R3 (ARGUS_NATS_REPLICAS=3) at first boot -- raising the replica count"
  say "      of an existing stream afterwards is a separate, deliberate operation."
fi

say ""
if [ "$FAILURES" -gt 0 ]; then
  say "nats-init FINISHED WITH $FAILURES FAILURE(S) and $WARNINGS warning(s). The queues exist and will"
  say "carry messages, but at least one policy above is not what this file declares -- exiting non-zero"
  say "so that a restart cannot turn it into the permanent configuration by being quiet about it."
  exit 1
fi
if [ "$WARNINGS" -gt 0 ]; then
  say "nats-init complete with $WARNINGS warning(s) above. The streams exist; read them."
else
  say "nats-init complete"
fi
