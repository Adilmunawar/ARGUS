ui = true

cluster_name = "argus-compose"

storage "raft" {
  path = "/openbao/file"

  node_id = "argus-openbao-1"
}

listener "tcp" {
  address = "0.0.0.0:8200"

  tls_disable = true

  x_forwarded_for_authorized_addrs = []

  telemetry {
    unauthenticated_metrics_access = false
  }
}

api_addr = "http://openbao:8200"

cluster_addr = "https://openbao:8201"

default_lease_ttl = "1h"

max_lease_ttl = "24h"

log_level  = "info"
log_format = "standard"

audit "file" {
  type        = "file"
  path        = "file"
  description = "Argus audit trail: every request and response, HMACed"
  local       = false

  options = {
    file_path = "/openbao/logs/audit.log"

    log_raw = "false"

    mode = "0640"
  }
}
