# sql-01 — SQL Server 2022 AG primary. Shielded Generation 2 VM on cluster argus-hvc-a.
module "sql_01" {
  source     = "./modules/shielded-vm"
  name       = "sql-01"
  cluster    = "argus-hvc-a"
  generation = 2
  vcpu       = 16
  memory_mb  = 131072
  vlan       = 31                                   # DATA
  shielding  = { enabled = true, hgs = "hgs-01.argus.local" }
  disks = [
    { name = "os",     size_gb = 100,  tier = "nvme" },
    { name = "data",   size_gb = 2048, tier = "nvme" },
    { name = "log",    size_gb = 512,  tier = "nvme" },
    { name = "tempdb", size_gb = 256,  tier = "nvme" },
  ]
  replica  = { target_cluster = "argus-hvc-b", frequency_seconds = 300 }
  dsc_role = "sql-node"
  gmsa     = "gmsa-sql$"
  tags     = { tier = "1", app = "mills,loan,console" }
}
