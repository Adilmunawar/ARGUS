# ═════════════════════════════════════════════ Argus secrets: OpenBao server
# The Secrets Manager + KMS + dynamic-credential replacement (ADR-0013), as one
# node on one laptop. Site A runs three of these on the Service Fabric nodes;
# everything below is written so that the SHAPE is the same there and only the
# node count and the TLS termination differ.
#
# THERE IS NO CREDENTIAL IN THIS FILE AND THERE IS NOWHERE TO PUT ONE.
# OpenBao's own root of trust is the unseal key, and that key does not exist
# until `bao operator init` runs against a fresh raft -- see init/provision.sh.
# Nothing here can be pre-seeded, defaulted or committed, which is the one
# property that makes a secrets store worth having in a git repository at all.
#
# ── THIS FILE IS THE SAME IN BOTH UNSEAL MODES. THAT IS DELIBERATE, AND IT IS
#    ALSO THE ONE THING A READER OF THIS FILE MUST NOT FORGET ───────────────
#
# ARGUS_UNSEAL_MODE (sandbox | ceremony) decides how the vault is INITIALISED
# and how it is unsealed. Both of those are runtime acts performed by
# init/provision.sh and init/unseal-loop.sh against a running server, not
# settings a server reads at boot. The server has no idea which mode produced
# its seal, so this file cannot say, and any line in here claiming to would be
# a comment that goes stale the first time somebody flips the variable.
#
# So do not look here for the answer to "is this the insecure sandbox?". Ask
# the server, which is the only thing that actually knows:
#
#     GET /v1/sys/seal-status        (unauthenticated, works while SEALED)
#       "n": 1, "t": 1   -> the 1-of-1 sandbox seal. One share, one holder,
#                           and init/provision.sh wrote that single share to
#                           the argus_openbao_seal volume ON THIS MACHINE,
#                           beside the data it opens. That is precisely the
#                           arrangement ADR-0013 exists to forbid.
#       "n": 5, "t": 3   -> the ceremony seal. Five shares, three needed, none
#                           of them ever written to disk by anything in this
#                           repository.
#
# That number is MEASURED from the seal itself. It cannot drift from reality
# the way an environment variable can: a vault initialised in sandbox mode and
# later restarted with ARGUS_UNSEAL_MODE=ceremony is STILL 1-of-1 with its key
# on disk, because changing the variable does not re-key an existing vault.
# provision.sh detects exactly that disagreement and says so; the console is
# expected to trust `n`/`t` over its own ARGUS_UNSEAL_MODE for the same reason.
#
# ── OTHER FILES IN THIS DIRECTORY ARE NOT READ ─────────────────────────────
# docker-compose.yml passes `-config=/etc/argus/config/openbao.hcl`, a FILE and
# not a directory, so a second .hcl dropped in here is silently ignored -- it
# will not error, it will simply have no effect. The directory form is not used
# because the image's entrypoint ALWAYS appends `-config=/openbao/config` as
# well, multiple -config flags MERGE, and two listener stanzas on one port is a
# bind failure at startup rather than a config error anybody can read.

ui = true

# The name this node reports in `bao status` and /v1/sys/seal-status once it is
# unsealed. It names the DEPLOYMENT, never the seal posture: see the block
# above for why a "sandbox" in this string would be a lie waiting to happen.
cluster_name = "argus-compose"

# ─────────────────────────────────────────────────────────────────── storage
# Raft (integrated storage) on a NAMED VOLUME, single node.
#
# `file` storage would work for one node and is simpler, and it is still the
# wrong choice: it cannot take a snapshot (`bao operator raft snapshot save` is
# the only backup this estate has for its secrets), it cannot grow to the three
# nodes ADR-0013 requires, and moving from file to raft later is an offline
# export/import of every secret rather than an edit. The cost of raft here is a
# few MB of overhead. The cost of the migration is a maintenance window.
#
# The path is a Docker NAMED VOLUME (argus_openbao_data), never a bind mount to
# C:\. Raft fsyncs its log on every write and a 9p/virtiofs bind does not honour
# that, so a crash mid-write leaves a raft that will not open -- and a raft that
# will not open is every secret in the estate, not a cache you can rebuild.
storage "raft" {
  path = "/openbao/file"

  # Stable and boring, because raft identity is written INTO the raft on first
  # boot. Changing this string on an existing volume does not rename the node;
  # it makes the server think it is a different, unknown peer, and a single-node
  # cluster then has no quorum and will not start. If you ever need to change
  # it, that is a snapshot-restore, not an edit.
  node_id = "argus-openbao-1"
}

# ────────────────────────────────────────────────────────────────── listener
listener "tcp" {
  # 0.0.0.0, not 127.0.0.1: inside a container a loopback bind answers nothing
  # that arrives through the published port, and bao-init, the unseal sidecar
  # and the console all reach this over the `argus` bridge by DNS name. Host
  # exposure is confined by the `127.0.0.1:8200` publish in docker-compose.yml,
  # not by this bind address.
  address = "0.0.0.0:8200"

  # ── PLAINTEXT, AND HERE IS EXACTLY WHAT THAT COSTS ──────────────────────
  # Every request to this listener -- the initial root token, every unseal
  # share submitted by the sidecar, every secret read -- crosses the Docker
  # bridge in the clear. Anything that can read that bridge (another container
  # on the `argus` network, tcpdump inside the WSL2 VM, a compromised sidecar)
  # reads all of it. There is no mitigation for that in this file.
  #
  # It is accepted here and ONLY here because this is one laptop behind
  # loopback with no other tenant on it. At Site A this listener gets an AD CS
  # machine certificate (ADR-0013) and Caddy terminates external TLS in front
  # of it (ADR-0016) -- so if you are copying this file to a real host, this is
  # the line to change first, and `tls_disable` is not a default you inherit.
  tls_disable = true

  # X-Forwarded-For is NOT trusted. Nothing proxies this listener today, so any
  # such header would be attacker-supplied, and an audit log that records a
  # forged client address is worse than one that records the bridge address:
  # it looks authoritative. Restated explicitly so that putting Caddy in front
  # of this becomes a deliberate change with a comment attached.
  x_forwarded_for_authorized_addrs = []

  telemetry {
    # /v1/sys/metrics stays AUTHENTICATED. Opening it would publish the full
    # list of mounted paths, per-path request counts and lease counts to
    # anything that can reach port 8200 -- an inventory of what secrets exist
    # and which are being used, which is most of what an attacker wants before
    # they have a token.
    #
    # The honest consequence, stated rather than hidden: there is therefore NO
    # Prometheus scrape job for OpenBao in this stack, and adding one is two
    # changes, neither of which is flipping this to true -- a token carrying
    # `read` on sys/metrics, AND a top-level `telemetry { prometheus_retention_time
    # = "24h" }` stanza. Measured on 2.6.2: with no telemetry stanza,
    # /v1/sys/metrics?format=prometheus answers 400 on an unsealed server no
    # matter how the request is authenticated, so a scrape job added without it
    # fails in a way that looks like a permissions problem and is not.
    unauthenticated_metrics_access = false
  }
}

# ───────────────────────────────────────────────────────────────── addresses
# The addresses this node advertises to its peers, so they are the
# container-internal DNS name -- `openbao` on the `argus` network -- and NOT
# 127.0.0.1, which would advertise "me" to every peer that read it. There is one
# node today and nothing consumes the advertisement; getting it wrong now would
# only surface when a second node joined, which is the worst time to find out.
api_addr = "http://openbao:8200"

# https, even though the API listener above is plaintext, and that is not a
# typo. The cluster port speaks OpenBao's own mutual TLS with certificates it
# generates and rotates itself; `tls_disable` on the listener does not reach it.
# Written as http, the server silently rewrites it to https at startup and
# reports the rewritten value in its banner -- so a reader comparing this file
# with `docker compose logs openbao` would find a disagreement and have no way
# to tell which one was in force. This is the value the server actually uses.
cluster_addr = "https://openbao:8201"

# ─── memory locking: THERE IS NO SETTING HERE, AND THAT IS THE FINDING ─────
# OpenBao 2.6.2 answers `disable_mlock` with
#   [WARN] unknown or unsupported field disable_mlock
# and its own binary carries the string "has dropped support for mlock. Please
# remove". Vault's mlock stanza does not exist in this fork any more, so a
# `disable_mlock = true` copied from a Vault example is a line that does nothing
# while reading like a deliberate security decision -- which is why it is not in
# this file.
#
# The consequence is unchanged and worth stating where somebody will find it:
# decrypted secrets and the in-memory master key CAN be paged out by the kernel.
# Inside WSL2 that swap is a file on the Windows disk which nothing in this
# project encrypts. The answer at Site A is BitLocker on the volume and a swap
# policy on the host; there is no line in any config file that fixes it.

# ──────────────────────────────────────────────────────────────── lease TTLs
# The defaults are 768h/768h -- thirty-two days. ADR-0013 buys exactly one
# thing with OpenBao, dynamic credentials with a short life, and a "dynamic"
# database password that is valid for a month buys none of it. These are the
# ceiling and the fallback for every engine that does not set its own:
default_lease_ttl = "1h"

# Nothing may issue a lease longer than this without an explicit,
# per-mount max_lease_ttl -- which is a deliberate act with a review attached,
# and that is the point of a low global ceiling.
max_lease_ttl = "24h"

# ────────────────────────────────────────────────────────────────────── logs
# Standard (human) format, not JSON. These lines are read by a person running
# `docker compose logs openbao` far more often than by a parser, and the sandbox
# warning that init/unseal-loop.sh prints has to be legible there. The AUDIT log
# below is the machine-readable one. Do not confuse the two: this server log is
# not an audit trail and does not record who read what.
log_level  = "info"
log_format = "standard"

# ───────────────────────────────────────────────────────────────────── audit
# ADR-0013 requires an audit device, and on OpenBao 2.6 THIS FILE IS THE ONLY
# PLACE IT CAN BE CREATED. `bao audit enable file ...` -- the line every Vault
# tutorial and every previous generation of this script used -- is refused:
#
#   Code: 400. * cannot enable audit device via API; use declarative,
#   config-based audit device management instead
#
# Measured on 2.6.2, not assumed. So init/provision.sh deliberately does not
# try, and if this stanza is deleted the estate runs with NO record of who read
# which secret, silently and with nothing in any log to say so.
#
# WHAT AN AUDIT DEVICE COSTS, because it is not free and the failure is total:
# OpenBao refuses every request it cannot audit. If this file becomes
# unwritable -- the volume fills, or somebody replaces argus_openbao_logs with a
# bind mount that uid 100 cannot write -- the vault does not degrade, it stops
# answering. That is the correct trade for an audit log and it is the reason
# /openbao/logs is a named volume owned by the openbao user, and the reason
# there is exactly ONE device here: two devices mean BOTH must accept every
# request, so adding a second doubles the ways to lock the estate out.
#
# Values in an audit stanza cannot be changed by the API afterwards, and a
# stanza that disagrees with the device already recorded in the vault is a
# startup error ("differs: (table) vs (config)"). Editing this block on a live
# vault is therefore a planned change, not a tweak.
audit "file" {
  type        = "file"
  path        = "file"
  description = "Argus audit trail: every request and response, HMACed"
  local       = false

  options = {
    file_path = "/openbao/logs/audit.log"

    # log_raw = false is the default and is restated because turning it on is
    # the single most damaging line anybody could add to this file: it writes
    # secret VALUES in clear text into the audit log. Left false, sensitive
    # strings are HMAC-SHA256'd, which still answers "was this the value that
    # leaked?" without ever storing it.
    log_raw = "false"

    # Not world-readable. The audit log records every path and every actor;
    # 0640 keeps it to the openbao user and its group, which is as far as file
    # permissions can help inside a container anybody can `docker exec` into.
    mode = "0640"
  }
}
