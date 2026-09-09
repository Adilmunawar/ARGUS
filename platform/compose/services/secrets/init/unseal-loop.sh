#!/bin/sh
# ═════════════════════ Argus secrets: the unseal sidecar (openbao-unseal)
# A LONG-RUNNING watcher, not a one-shot, and the reason it exists is narrow:
# Docker restarts the `openbao` container after a Windows reboot or a Docker
# Desktop update, but it NEVER re-runs an exited init container. A vault comes
# back SEALED from every restart, so without something that outlives the boot,
# the estate returns permanently sealed and every dependent service fails with
# "Vault is sealed" -- an error that names the symptom and not the cause.
#
# WHAT IT DOES IN EACH MODE
#   sandbox   Watches, and unseals with the single key that provision.sh stored
#             in /run/argus/seal. That key is on the same machine as the data,
#             which is the sandbox bargain, and this loop is the part of it that
#             never stops being true -- so it prints the warning again on every
#             unseal and periodically while running. A warning that scrolled
#             past once during a boot storm has not warned anybody.
#   ceremony  Watches and reports, and NEVER unseals. There is no key for it to
#             use, deliberately. It exists in this mode so that
#             `docker compose logs openbao-unseal` answers "is it sealed, and
#             since when?" without anybody having to know a bao command.
#
# THIS SCRIPT NEVER EXITS, INCLUDING WHEN IT IS MISCONFIGURED.
# The service carries `restart: unless-stopped`, which turns a clean exit 0 into
# an immediate restart -- so "exit and let Docker deal with it" is an infinite
# container-churn loop that also destroys the log every few seconds. Every error
# path below therefore logs and keeps looping at a slower rate, which is the one
# behaviour that leaves the message where somebody can read it.
#
# It mounts the seal volume READ-ONLY. Nothing here writes a credential, moves
# one, or creates one; if this container is compromised it can unseal a vault
# that is already unsealable by anything on this host, and no more than that.

set -u
# No `set -e`, for the same reason as provision.sh: `bao status` exits 2 for
# "sealed" and 1 for "not reachable", and both are ordinary states this loop is
# built to observe. Under `set -e` the sidecar would die the first time it did
# its job.

MODE="${ARGUS_UNSEAL_MODE:-sandbox}"
ADDR="${BAO_ADDR:-http://openbao:8200}"
SEAL_DIR=/run/argus/seal
KEY_FILE="$SEAL_DIR/unseal.key"

# Two rates. Fast while something is wrong, slow while everything is fine: a
# 5-second poll that never changes its mind is 17,000 requests a day to learn
# nothing. What it does NOT cost is audit-log growth -- measured on 2.6.2, the
# unauthenticated sys/seal-status and sys/health endpoints produce no audit
# entries at all, so this loop cannot fill /openbao/logs and cannot bury the
# entries that matter. An authenticated probe would do both.
POLL_BUSY=5
POLL_OK=15
POLL_BROKEN=60

# The sandbox warning is re-printed this often (in seconds of steady state) so
# that it is always near the tail of the log, not only at the top of it.
HEARTBEAT=1800

log()  { echo "[unseal] $*"; }
warn() { echo "[unseal] WARNING: $*"; }
err()  { echo "[unseal] ERROR: $*"; }

trap 'log "stopping."; exit 0' TERM INT

# A stop that is actually a stop.
#
# A POSIX shell defers a trap until the command it is running finishes, and
# `sleep 15` is such a command -- so with a plain foreground sleep, SIGTERM from
# `docker compose stop` is simply queued, the container sits there until the
# grace period runs out, and Docker SIGKILLs it. Measured: exit 137, every time,
# with the "stopping" line never printed.
#
# Backgrounding the sleep and blocking on `wait` fixes it, because `wait` is
# interruptible: the trap runs the instant the signal arrives. It matters more
# than a tidy exit code -- a container that is always SIGKILLed is a container
# whose logs always end mid-sentence, which is exactly the wrong habit for the
# one process that reports on the seal.
nap() { sleep "$1" & wait $!; }

sandbox_banner() {
  cat <<'BANNER'
[unseal] ╔══════════════════════════════════════════════════════════════════╗
[unseal] ║  ARGUS_UNSEAL_MODE=sandbox  --  AUTO-UNSEAL WITH THE KEY ON DISK ║
[unseal] ╠══════════════════════════════════════════════════════════════════╣
[unseal] ║  This container just opened the estate's secrets using a key it  ║
[unseal] ║  read from a volume on this same machine. There is no ceremony,  ║
[unseal] ║  no second party, and nothing to stop anyone who can read that   ║
[unseal] ║  volume from doing exactly the same. ADR-0013 requires 3 of 5    ║
[unseal] ║  shares held by three named people; this is not that, and it     ║
[unseal] ║  must never run on a real host.                                  ║
[unseal] ╚══════════════════════════════════════════════════════════════════╝
BANNER
}

jf() {
  printf '%s\n' "$1" | grep -m1 "\"$2\":" \
    | sed -e 's/^[^:]*: *//' -e 's/,$//' -e 's/^"//' -e 's/"$//'
}

case "$MODE" in
  sandbox|ceremony) ;;
  *)
    # Not a reason to exit: see the header. Repeat it forever, slowly, because
    # this container restarting every second would bury it.
    while true; do
      err "ARGUS_UNSEAL_MODE is '$MODE'. The only values are 'sandbox' and 'ceremony'."
      err "Refusing to guess which one you meant: one of them auto-unseals this vault and the"
      err "other requires three people. Nothing will be unsealed until ARGUS_UNSEAL_MODE is"
      err "fixed in platform/compose/.env and this container is restarted."
      nap 300
    done ;;
esac

log "watching OpenBao at $ADDR. mode=$MODE"
if [ "$MODE" = ceremony ]; then
  log "ceremony mode: this sidecar will NEVER unseal. When the vault is sealed, three of the five"
  log "key holders unseal it themselves:  docker compose exec openbao bao operator unseal"
fi

# `state` is the last thing that was logged about, so that a steady state is
# silent. A loop that logs "still unsealed" every 15 seconds produces a log in
# which nothing can be found, and the interesting lines -- the transitions --
# are exactly what gets lost.
state=start
fail_count=0
quiet_for=0

while true; do
  st=$(bao status -format=json 2>/dev/null)

  # ── unreachable ────────────────────────────────────────────────────────────
  if [ -z "$st" ]; then
    if [ "$state" != unreachable ]; then
      log "OpenBao at $ADDR is not answering. Waiting; this is normal while it restarts."
      state=unreachable
    fi
    nap "$POLL_BUSY"
    continue
  fi

  initialized=$(jf "$st" initialized)
  sealed=$(jf "$st" sealed)
  shares=$(jf "$st" n)
  threshold=$(jf "$st" t)

  # ── not initialised ────────────────────────────────────────────────────────
  if [ "$initialized" != true ]; then
    if [ "$state" != uninitialised ]; then
      log "the vault is reachable but NOT initialised. bao-init handles that in sandbox mode;"
      log "in ceremony mode a human must run it. Nothing to unseal until then."
      state=uninitialised
    fi
    nap "$POLL_BUSY"
    continue
  fi

  # ── unsealed: the steady state ─────────────────────────────────────────────
  if [ "$sealed" = false ]; then
    if [ "$state" != unsealed ]; then
      log "unsealed. seal is $threshold-of-$shares."
      # Said once per transition, from MEASURED numbers rather than from the
      # mode variable, because a vault born in sandbox mode keeps its 1-of-1
      # seal no matter what ARGUS_UNSEAL_MODE says afterwards.
      if [ "$shares" = 1 ]; then
        warn "this vault is sealed with ONE share. Whatever ARGUS_UNSEAL_MODE says, that is a"
        warn "sandbox seal: one secret, on one machine, opens the whole estate."
      fi
      state=unsealed
      fail_count=0
      quiet_for=0
    fi
    quiet_for=$((quiet_for + POLL_OK))
    if [ "$MODE" = sandbox ] && [ "$quiet_for" -ge "$HEARTBEAT" ]; then
      sandbox_banner
      quiet_for=0
    fi
    nap "$POLL_OK"
    continue
  fi

  # ── sealed ─────────────────────────────────────────────────────────────────
  if [ "$MODE" = ceremony ]; then
    if [ "$state" != sealed-waiting ]; then
      log "SEALED. $threshold of $shares key holders must unseal it; this sidecar holds no key."
      log "  docker compose exec openbao bao operator unseal      (once per holder)"
      state=sealed-waiting
    fi
    nap "$POLL_OK"
    continue
  fi

  # "No key" is checked FIRST, and the order is not cosmetic: with the seal
  # check first, a keyless container facing a 3-of-5 vault announced that it was
  # holding a key it did not have. Both conditions are failures; the message has
  # to be about the one that is actually true.
  if [ ! -f "$KEY_FILE" ]; then
    if [ "$state" != no-key ]; then
      warn "SEALED ($threshold of $shares shares needed), and there is no key at $KEY_FILE."
      warn "In sandbox mode bao-init writes that file when it initialises the vault. If the vault"
      warn "is initialised and the file is missing, the argus_openbao_seal volume was removed while"
      warn "argus_openbao_data survived -- and then nothing on this machine can open this vault."
      warn "Check: docker compose logs bao-init"
      state=no-key
    fi
    nap "$POLL_BROKEN"
    continue
  fi

  # ── ONE KEY CANNOT OPEN A 3-OF-5 VAULT, AND TRYING IS NOT HARMLESS ────────
  # Measured on 2.6.2: `bao operator unseal <any syntactically valid share>`
  # against a multi-share seal returns SUCCESS and increments the unseal
  # progress, whether or not the share belongs to that vault. It is only at the
  # threshold that anything is verified. So a sandbox sidecar pointed at a
  # ceremony vault does not fail politely -- it silently poisons the progress
  # counter, the three key holders' correct shares then fail against a set
  # containing one bad one, and somebody has to work out that
  # `bao operator unseal -reset` is the cure for a ceremony this container
  # broke. Refusing is the only safe move, and it is loud.
  if [ "$shares" != 1 ] || [ "$threshold" != 1 ]; then
    if [ "$state" != wrong-seal ]; then
      err "SEALED with a $threshold-of-$shares seal, and this sidecar holds ONE key. It will not submit it."
      err "A single share cannot open this vault, and submitting one that does not belong to it would be"
      err "ACCEPTED and counted (OpenBao only verifies at the threshold), breaking the real ceremony."
      err "Either this vault was re-keyed, or ARGUS_UNSEAL_MODE=sandbox is pointed at a ceremony vault."
      err "Unseal it by hand: docker compose exec openbao bao operator unseal   (x$threshold)"
      state=wrong-seal
    fi
    nap "$POLL_BROKEN"
    continue
  fi

  # The key goes in argv because OpenBao 2.6 leaves no other option: piping it
  # into `bao operator unseal` is refused with "file descriptor 0 is not a
  # terminal", and the command's own help says to pass the key as the first
  # argument when there is no TTY. It is visible to `ps` inside this container
  # for the length of one call -- this container, whose entire purpose is to
  # hold that key. It buys no attacker anything they did not already have.
  bao operator unseal "$(cat "$KEY_FILE")" >/dev/null 2>&1

  # The EXIT CODE IS NOT THE ANSWER, and believing it was is how the previous
  # version of this loop reported "UNSEALED the vault" about a vault it had left
  # sealed. `bao operator unseal` reports on the SHARE it accepted, not on the
  # seal. The seal is the thing that matters, so the seal is what gets read.
  if [ "$(jf "$(bao status -format=json 2>/dev/null)" sealed)" = false ]; then
    log "UNSEALED the vault with the stored key."
    sandbox_banner
    state=unsealed
    fail_count=0
    quiet_for=0
    nap "$POLL_OK"
    continue
  fi

  # ── the stored key does not work ───────────────────────────────────────────
  # Almost always one specific accident: argus_openbao_data was recreated (a
  # `down -v`, a volume prune, a rebuild) while argus_openbao_seal survived, so
  # the key on disk belongs to a raft that no longer exists. Retrying that
  # forever at five-second intervals produces thousands of identical failures
  # and hides the one line that explains them.
  fail_count=$((fail_count + 1))
  if [ "$state" != unseal-failed ]; then
    err "the stored key at $KEY_FILE did NOT unseal this vault."
    err "The usual cause is that argus_openbao_data was recreated while argus_openbao_seal"
    err "survived, so this key belongs to a raft that no longer exists. Nothing here can"
    err "recover the old secrets. To start clean, remove BOTH volumes and boot again."
    err "Retrying every ${POLL_BROKEN}s so this message stays readable."
    state=unseal-failed
  elif [ $((fail_count % 30)) = 0 ]; then
    err "still failing to unseal with the stored key ($fail_count attempts)."
  fi
  nap "$POLL_BROKEN"
done
