client {
  enabled    = true
  servers    = ["127.0.0.1:4647"]
  node_class = "argus-compute"

  options = {
    "driver.allowlist" = "docker"
  }

  reserved {
    cpu            = 1000
    memory         = 2048
    disk           = 10240
    reserved_ports = "4646-4648"
  }
}
