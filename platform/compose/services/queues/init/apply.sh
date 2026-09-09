#!/bin/sh
# ══════════════════════════ Argus queues: streams, retry policy, dead letters
#
# Runs once per `docker compose up`, in nats-box (the `nats` CLI does not exist
# in the nats server image). It creates the JetStream streams, the durable
# consumers that carry the retry policy, the KV buckets, and the dead-letter
# path -- then PROVES the account can actually publish, and prints what it
# measured rather than what it intended.
#
# CREDENTIALS COME FROM THE ENVIRONMENT AND ARE NEVER PASSED AS ARGUMENTS.
# The `nats` CLI reads $NATS_URL, $NATS_USER and $NATS_PASSWORD itself. Passing
# --password on the command line would put the password in `ps` output inside
# this container and in the shell's own error messages when a command fails.
# There is no flag here to supply one, and nothing in this file prints one.
#
# IDEMPOTENT BY CONSTRUCTION. `docker compose up -d` re-runs exited one-shots,
# and `nats stream add` on an existing stream is an ERROR, not a no-op. Every
# create is therefore `info || add`, and the gate would otherwise fail on every
# second boot -- with a message about a stream that already exists, which reads
# like success and is reported as failure.
#
#
# ── WHAT A REDELIVERY ACTUALLY GUARANTEES ────────────────────────────────────
#
# Everything in this section was measured against nats-server 2.11.4 running
# the committed nats-server.conf, not taken from documentation.
#
# AT-LEAST-ONCE. NEVER EXACTLY-ONCE. A redelivery does not mean the work was
# not done. The common case is the opposite one: the worker finished, its ack
# was lost or arrived after ack_wait, and the same message comes back. Every
# consumer of these streams must be idempotent against its own side effects --
# for an ingest that means keying the insert on a job id, not appending rows.
#
# max_deliver COUNTS DELIVERIES, NOT FAILURES. An ack_wait expiry costs exactly
# what an explicit NAK costs. A worker that takes longer than ack_wait burns its
# entire retry budget while succeeding every time, and the job is dead-lettered
# having never once failed. This is the trap in the whole mechanism, and it is
# why ack_wait below is set from the p99 duration of the work rather than from a
# round number -- and why a long job must send in-progress acks, which reset
# ack_wait, instead of hoping.
#
# REDELIVERY IS PER-CONSUMER. The message is redelivered to the consumer whose
# ack was outstanding. Other consumers on the same stream are unaffected and
# see nothing.
#
# DEDUPLICATION IS A WINDOW, NOT A PROPERTY. JetStream drops a publish carrying
# an Nats-Msg-Id it has already seen within the stream's duplicate window (10m
# on the work streams here). A publisher that retries after that window creates
# a second job, and the window is per-stream state that a restart of a memory
# stream would lose. It is a real defence against a publisher retry storm; it is
# not exactly-once delivery and must not be described as such.
#
# ORDER IS NOT PRESERVED ACROSS A REDELIVERY. A redelivered message arrives
# after messages that were published later. Anything order-sensitive needs its
# own sequencing.
#
#
# ── THE DEAD-LETTER MECHANISM, AND WHAT IT DOES NOT DO ───────────────────────
#
# JETSTREAM SHIPS NO DEAD-LETTER QUEUE. There is no setting that moves a
# poisoned message anywhere. What the server does provide is an advisory, and
# what it provides is thinner than the name suggests:
#
#   subject  $JS.EVENT.ADVISORY.CONSUMER.MAX_DELIVERIES.<stream>.<consumer>
#   payload  {"type":"io.nats.jetstream.advisory.v1.max_deliver","id":"...",
#             "timestamp":"...","stream":"ARGUS_INGEST","consumer":"...",
#             "stream_seq":41,"deliveries":5}
#
# THAT IS A POINTER. It carries no body, no headers, and not even the subject
# the message was published to. So the mechanism here is two things, and the
# console must render them as two things:
#
#   1. ARGUS_DEADLETTER captures that advisory subject directly -- a stream may
#      consume $JS advisories like any other subject. This catches EVERY
#      exhausted message, including from a worker that crashed and could not
#      report anything. The record is a pointer, and reading the failed job
#      means fetching <stream>/<stream_seq> afterwards.
#
#   2. `argus.dlq.<stream>.<consumer>` is where an application republishes the
#      message body itself when it terminates a job it knows it cannot process.
#      That is a CONVENTION this file defines and nothing enforces. A worker
#      that just crashes leaves only the pointer from (1).
#
# THE POINTER IS ONLY USEFUL WHILE THE BODY STILL EXISTS. This is the invariant
# the script checks and refuses to run without: ARGUS_DEADLETTER's max_age must
# be SHORTER than every source stream's max_age. Get it the wrong way round and
# the console shows a dead letter whose body was evicted days ago, next to a
# Replay button that cannot work. The source streams therefore use `limits`
# retention and not `workqueue` -- workqueue deletes on ack, and a dead-letter
# pointer into a stream that deletes its messages is a pointer to nothing.
#
# AN EMPTY DEAD-LETTER STREAM IS NOT PROOF THAT NOTHING IS FAILING. Measured:
# after a message exhausted its deliveries, twenty seconds passed with no
# advisory; the advisory appeared only when a consumer next pulled. The server
# publishes it as it processes the redelivery attempt, so if every worker for a
# stream is down, messages pile up, nothing is dead-lettered, and this stream
# stays empty. Consumer lag -- num_pending and num_ack_pending -- is the signal
# for that case, not the dead-letter count. Any alert wired to dead letters
# alone will be silent during the outage it exists to catch.
#
# NEVER GIVE ARGUS_DEADLETTER A CONSUMER WITH A FINITE max_deliver. Its own
# exhausted messages would produce advisories that land back in it. That is why
# the console reads it with an ephemeral, ack-none consumer or a direct get, and
# why this script creates no durable on it.

set -eu

WARNINGS=0
FAILURES=0
say()  { printf '%s\n' "$*"; }
warn() { printf 'WARNING  %s\n' "$*" >&2; WARNINGS=$((WARNINGS + 1)); }
# A wrong policy that still runs. The estate is usable, so the script finishes
# its work -- and then exits non-zero, because a green one-shot next to a retry
# policy that is not the committed one is how the wrong policy becomes permanent.
fail() { printf 'FAILED   %s\n' "$*" >&2; FAILURES=$((FAILURES + 1)); }
die()  { printf 'FATAL    %s\n' "$*" >&2; exit 1; }

# Durations are written here the way an operator writes them ("5m") and read
# back from the server in nanoseconds. This converts so the two can be compared;
# an unrecognised unit returns nothing, which the caller treats as "unchecked"
# rather than as a match.
dur_ns() {
  v="$1"; n="${v%[smh]}"; u="${v#"$n"}"
  case "$u" in
    s) echo $((n * 1000000000)) ;;
    m) echo $((n * 60000000000)) ;;
    h) echo $((n * 3600000000000)) ;;
    *) echo '' ;;
  esac
}

# Every `nats` call reads from /dev/null. The stream and consumer tables below
# are here-documents piped into `while read`, and a CLI that decides to prompt
# would eat the rest of the table as its answer -- creating half the streams and
# reporting success.
nats_() { nats "$@" </dev/null; }

# ─────────────────────────────────────────────────────────────── preconditions
: "${NATS_URL:?nats-init needs NATS_URL (docker-compose.yml sets it)}"
: "${NATS_USER:?nats-init needs NATS_USER}"
: "${NATS_PASSWORD:?nats-init needs NATS_PASSWORD; bootstrap.ps1 generates it}"

# R1 here, R3 at Site A. An R1 stream on a three-node cluster reports itself
# perfectly healthy in every UI right up to the moment its one node dies, so the
# replica count is a deployment input and never a default written into a stream.
REPLICAS="${ARGUS_NATS_REPLICAS:-1}"

say "nats-init: $NATS_URL as $NATS_USER, replicas=$REPLICAS"

# ────────────────────────────────────────────────── wait for the JetStream API
# The container healthcheck this job is gated on proves the PROCESS is up and
# JetStream is enabled server-wide (/healthz?js-server-only=true). It does not
# prove the JetStream API answers for this account: the meta layer comes up
# after the listener, and stream creation in that window fails with a timeout
# that reads like a network fault. `account info` is the cheapest call that
# actually exercises $JS.API for this credential.
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

# ───────────────────────────────────── prove we are talking to OUR nats-server
# A server started without --config, or with a config that failed to mount, runs
# with JetStream limits sized against the whole WSL2 VM. Every stream below
# would still be created, the boot would be green, and the pin that stops
# JetStream filling the VHDX would simply not exist. The account-level
# max_bytes_required from nats-server.conf is the cheapest fingerprint of the
# committed configuration, so it is checked rather than assumed.
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

# ───────────────────────────────────────────────────────────────────── streams
#
# RETENTION IS `limits` EVERYWHERE, DELIBERATELY.
#   workqueue deletes a message the moment it is acked, which makes both replay
#   and the dead-letter pointer above impossible, and allows only one consumer
#   per subject. interest deletes it once every registered consumer has acked,
#   so a stream with no consumers -- which is every stream here until the
#   workers exist -- silently discards everything published to it.
#
# DISCARD IS THE HALF THAT ACTUALLY DECIDES WHAT IS LOST.
#   `new` refuses the publisher when the stream is full: the producer gets an
#   error it can retry or alert on. That is right for a job queue, where
#   silently dropping the oldest unprocessed job is the worst possible outcome.
#   `old` drops the oldest to make room, which is right for a telemetry-shaped
#   event stream where the newest is the useful one and the producer cannot
#   usefully retry.
#
# EVERY max_bytes IS EXPLICIT because the account requires it (see the conf),
# and their total -- 960 MB across these six -- is deliberately well under the
# account's 1536 MB. That ordering is load-bearing: a stream that hits its own
# limit applies its discard policy and affects only itself, while an ACCOUNT
# that hits its limit refuses publishes to every stream in it, including
# ARGUS_DEADLETTER.
#
# name|subjects|retention|discard|max_age|max_bytes|dupe|description

create_stream() {
  name="$1"; subjects="$2"; retention="$3"; discard="$4"
  max_age="$5"; max_bytes="$6"; dupe="$7"; desc="$8"

  if nats_ stream info "$name" >/dev/null 2>&1; then
    cfg="$(nats_ stream info "$name" -j)"
    have_ret="$(printf '%s' "$cfg" | jq -r '.config.retention')"
    have_dis="$(printf '%s' "$cfg" | jq -r '.config.discard')"
    have_byt="$(printf '%s' "$cfg" | jq -r '.config.max_bytes')"
    [ "$have_ret" = "$retention" ] || warn "$name has retention=$have_ret, this file declares $retention.
          Retention CANNOT be changed in place: the stream must be deleted and recreated, which destroys
          its messages. Nothing here does that silently."
    [ "$have_dis" = "$discard" ] || warn "$name has discard=$have_dis, this file declares $discard.
          Fix with: nats stream edit $name --discard $discard"
    [ "$have_byt" -gt 0 ] 2>/dev/null || warn "$name has no max_bytes. One runaway publisher on it fills
          the account limit and stops publishes to EVERY stream, including the dead-letter stream."
    say "  = $name exists"
    return 0
  fi

  # --allow-direct is what lets the console read one message by sequence without
  # creating a consumer -- exactly the dead-letter path, where the record is a
  # pointer and a consumer would be a side effect on somebody else's queue.
  set -- stream add "$name" \
    --storage file --retention "$retention" --discard "$discard" \
    --max-age "$max_age" --max-bytes "$max_bytes" --dupe-window "$dupe" \
    --replicas "$REPLICAS" --description "$desc" \
    --max-msgs=-1 --max-msgs-per-subject=-1 --max-msg-size=-1 --max-consumers=-1 \
    --allow-direct --no-allow-rollup --no-deny-delete --no-deny-purge --defaults
  # Subjects are added one flag at a time so a stream can own more than one, and
  # so a subject containing `>` never has to survive a shell that might glob it.
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

# ──────────────────────────────────── the invariant the whole mechanism rests on
# Measured from the server, not from the table above, because the table is what
# we asked for and this is what exists. A dead-letter pointer that outlives the
# body it points at is worse than no dead-letter record: it is a Replay button
# that fails, and an operator concluding the message was lost.
dlq_age="$(nats_ stream info ARGUS_DEADLETTER -j | jq -r '.config.max_age')"
for s in ARGUS_INGEST ARGUS_EXPORT ARGUS_PIPELINE ARGUS_AI ARGUS_SENTINEL; do
  src_age="$(nats_ stream info "$s" -j | jq -r '.config.max_age')"
  if [ "$dlq_age" -ge "$src_age" ]; then
    die "ARGUS_DEADLETTER keeps pointers for ${dlq_age}ns but $s keeps the bodies for only ${src_age}ns.
         Every dead letter older than $s's max_age would point at a message that no longer exists.
         Raise $s --max-age, or lower ARGUS_DEADLETTER --max-age. Do not ship it this way round."
  fi
done
say "nats-init: dead-letter pointers expire before the bodies they point at (checked against the server)"

# ─────────────────────────────────────────────────────────────────── consumers
#
# THESE CONSUMERS ARE THE DEAD-LETTER MECHANISM. A consumer created with the
# CLI's defaults has max_deliver = -1 -- measured -- which means it redelivers a
# poisoned message FOREVER, no advisory is ever published, and nothing is ever
# dead-lettered. Leaving consumer creation to each application therefore leaves
# the whole mechanism off by default in the most convincing way possible: it
# looks like it is working.
#
# ack_wait is the p99 of the WORK, not a round number, because an ack_wait
# expiry spends a delivery exactly like a failure does (see the header).
#
# ── --backoff-min SILENTLY OVERWRITES --wait. MEASURED, AND IT SHIPPED HERE ──
#
# `--wait 5m --backoff linear --backoff-min 30s --backoff-max 15m
#  --backoff-steps 5` produces, on 2.11.4:
#
#     ack_wait 30s   backoff [30s, 3m24s, 6m18s, 9m12s, 12m6s]
#
# The 5m was accepted, reported nowhere, and discarded: JetStream sets AckWait
# to the FIRST backoff step. That is not cosmetic. A shapefile ingest that takes
# four minutes would have been redelivered at thirty seconds, six times over,
# exhausting all five deliveries and dead-lettering a job that was succeeding --
# the exact failure the header warns about, introduced by the retry policy meant
# to prevent it. The first version of this table had it that way and the
# read-back below is what caught it.
#
# So the first backoff step IS the ack_wait, and the two columns must agree.
# create_consumer reads ack_wait back from the server after creating it and
# fails the run if they do not, because the next person to add a consumer here
# will not know this and the CLI will not tell them.
#
# stream|consumer|filter|ack_wait|max_deliver|backoff_min|backoff_max|steps|description

create_consumer() {
  stream="$1"; cname="$2"; filter="$3"; ackwait="$4"; maxdel="$5"
  bmin="$6"; bmax="$7"; bsteps="$8"; desc="$9"

  if nats_ consumer info "$stream" "$cname" >/dev/null 2>&1; then
    ccfg="$(nats_ consumer info "$stream" "$cname" -j)"
    have_md="$(printf '%s' "$ccfg" | jq -r '.config.max_deliver')"
    have_bo="$(printf '%s' "$ccfg" | jq -r 'if (.config.backoff // []) | length > 0 then "set" else "none" end')"
    if [ "$have_md" -lt 0 ] 2>/dev/null; then
      warn "$stream/$cname has max_deliver=$have_md (unlimited): it will retry a poisoned message forever
            and never dead-letter. Fix with: nats consumer edit $stream $cname --max-deliver $maxdel"
    fi
    if [ "$have_bo" = "none" ]; then
      warn "$stream/$cname has no backoff policy, so every retry is spaced exactly $ackwait apart. A failing
            upstream then gets $maxdel evenly-spaced hammerings instead of a widening gap. Not dangerous,
            but it is not what this file declares."
    fi
    verify_ack_wait "$stream" "$cname" "$ackwait"
    say "  = $stream/$cname exists"
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

# What the server ACTUALLY stored, against what this file asked for.
verify_ack_wait() {
  want="$(dur_ns "$3")"
  [ -n "$want" ] || return 0
  have="$(nats_ consumer info "$1" "$2" -j | jq -r '.config.ack_wait')"
  [ "$have" = "$want" ] && return 0
  fail "$1/$2 was declared with ack_wait=$3 (${want}ns) and the server stored ${have}ns.
         A consumer whose ack_wait is shorter than the work redelivers jobs that are still running and
         dead-letters them for succeeding slowly. The first backoff step sets ack_wait -- make
         backoff_min equal the ack_wait column in the table above. Note that \`nats consumer edit\` will
         NOT repair this one: it refuses with 'consumers with backoff policies do not support editing
         Ack Wait', so the consumer has to be removed and recreated -- which resets its delivery state."
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

# ARGUS_AI deliberately has no durable consumer. Nothing in this increment
# consumes argus.ai.>, and a durable nobody pulls from reports a lag that only
# ever grows -- a true number that means nothing, on a screen whose whole job is
# to mean something. Whoever adds the worker adds the consumer WITH an explicit
# --max-deliver, or it will never dead-letter.
#
# ARGUS_DEADLETTER deliberately has no consumer at all: see the header.

# ────────────────────────────────────────────────────────────────── kv buckets
# A KV bucket IS a stream (KV_<name>), so it counts against max_streams and the
# account's storage, and --max-bucket-size is not optional here: the account
# sets max_bytes_required, and `nats kv add` without it fails with
# "account requires a stream config to have max bytes set" (err 10113), which
# does not mention KV at all.
create_kv() {
  b="$1"; ttl="$2"; maxb="$3"; maxv="$4"; desc="$5"
  if nats_ kv status "$b" >/dev/null 2>&1; then say "  = kv $b exists"; return 0; fi
  nats_ kv add "$b" --history 1 --ttl "$ttl" --storage file \
    --max-bucket-size "$maxb" --max-value-size "$maxv" \
    --replicas "$REPLICAS" --description "$desc" >/dev/null || die "could not create kv bucket $b"
  say "  + kv $b created"
}

say "nats-init: kv buckets"
# Job status the UI polls after its 202. TTL'd because a job record nobody read
# in a day is not going to be read.
create_kv argus_jobs  24h 64MB 64KB "Async job status: one key per job id, written by the worker, polled by the console."
# Scheduler singleton locks. THE TTL IS THE POINT: a lock held by a worker that
# was killed must expire on its own, or the pipeline stops forever and the only
# symptom is that nothing runs.
create_kv argus_locks  5m  8MB  1KB "Singleton locks for schedulers. TTL 5m so a dead holder releases itself."

# ───────────────────────────────────────────────────────── prove it can publish
# The healthcheck proves the port answers; everything above proves the API
# accepts configuration. Neither proves a message can be stored, which is the
# one thing this service exists to do -- and the failure that is invisible until
# it matters is the JetStream store directory being unwritable on the volume.
# So: a real publish into a real stream, read back, and removed. It runs in its
# own stream so a self-test message can never appear in a work queue or be
# mistaken for a dead letter.
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

# ────────────────────────────────────────────────────────────────────── report
# EVERY NUMBER BELOW IS READ BACK FROM THE SERVER. None of it is echoed from the
# table above: the point of printing it is to show what exists, and a summary
# that prints its own inputs cannot tell you when the two disagree.
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

# ────────────────────────────────────────────────────────── what is still true
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
