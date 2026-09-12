#!/bin/sh

set -u

MODE="${ARGUS_UNSEAL_MODE:-sandbox}"
ADDR="${BAO_ADDR:-http://openbao:8200}"
SEAL_DIR=/run/argus/seal
KEY_FILE="$SEAL_DIR/unseal.key"

POLL_BUSY=5
POLL_OK=15
POLL_BROKEN=60

HEARTBEAT=1800

log()  { echo "[unseal] $*"; }
warn() { echo "[unseal] WARNING: $*"; }
err()  { echo "[unseal] ERROR: $*"; }

trap 'log "stopping."; exit 0' TERM INT

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

state=start
fail_count=0
quiet_for=0

while true; do
  st=$(bao status -format=json 2>/dev/null)

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

  if [ "$initialized" != true ]; then
    if [ "$state" != uninitialised ]; then
      log "the vault is reachable but NOT initialised. bao-init handles that in sandbox mode;"
      log "in ceremony mode a human must run it. Nothing to unseal until then."
      state=uninitialised
    fi
    nap "$POLL_BUSY"
    continue
  fi

  if [ "$sealed" = false ]; then
    if [ "$state" != unsealed ]; then
      log "unsealed. seal is $threshold-of-$shares."
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

  if [ "$MODE" = ceremony ]; then
    if [ "$state" != sealed-waiting ]; then
      log "SEALED. $threshold of $shares key holders must unseal it; this sidecar holds no key."
      log "  docker compose exec openbao bao operator unseal      (once per holder)"
      state=sealed-waiting
    fi
    nap "$POLL_OK"
    continue
  fi

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

  bao operator unseal "$(cat "$KEY_FILE")" >/dev/null 2>&1

  if [ "$(jf "$(bao status -format=json 2>/dev/null)" sealed)" = false ]; then
    log "UNSEALED the vault with the stored key."
    sandbox_banner
    state=unsealed
    fail_count=0
    quiet_for=0
    nap "$POLL_OK"
    continue
  fi

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
