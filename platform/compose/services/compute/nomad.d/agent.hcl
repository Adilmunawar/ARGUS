region     = "global"
datacenter = "argus-compose"
name       = "argus-nomad-1"

data_dir = "/opt/argus/nomad/data"

log_level            = "INFO"
log_json             = true
disable_update_check = true

bind_addr = "0.0.0.0"

ports {
  http = 4646
  rpc  = 4647
  serf = 4648
}

addresses {
  http = "0.0.0.0"
  rpc  = "127.0.0.1"
  serf = "127.0.0.1"
}

advertise {
  rpc  = "127.0.0.1"
  serf = "127.0.0.1"
}

ui {
  enabled = false
}

acl {
  enabled    = true
  token_ttl  = "30s"
  policy_ttl = "60s"
  role_ttl   = "60s"
}

telemetry {
  prometheus_metrics         = true
  publish_allocation_metrics = true
  publish_node_metrics       = true
  collection_interval        = "10s"
  disable_hostname           = true
}
