locals {
  vlan_names = {
    10 = "mgmt"
    20 = "app"
    31 = "data"
    40 = "dmz"
    50 = "backup"
  }

  disk_paths = {
    for disk in var.disks : disk.name => format(
      "C:\\ClusterStorage\\%s-%s\\%s\\%s.vhdx",
      var.cluster, disk.tier, var.name, disk.name
    )
  }

  total_disk_gb = sum([for disk in var.disks : disk.size_gb])

  specification = {
    name       = var.name
    cluster    = var.cluster
    generation = var.generation
    computeProfile = {
      vcpu               = var.vcpu
      memoryStartupBytes = var.memory_mb * 1024 * 1024
      dynamicMemory      = false
    }
    firmware = {
      secureBoot         = true
      secureBootTemplate = "MicrosoftWindows"
      virtualTpm         = var.shielding.enabled
    }
    shielding = {
      enabled          = var.shielding.enabled
      hostGuardian     = var.shielding.enabled ? var.shielding.hgs : null
      encryptState     = var.shielding.enabled
      encryptTraffic   = var.shielding.enabled
      allowConsole     = false
      allowIntegration = false
    }
    network = {
      vlan     = var.vlan
      zone     = lookup(local.vlan_names, var.vlan, "unclassified")
      switch   = format("%s-team", var.cluster)
      macSpoof = false
    }
    disks = [
      for disk in var.disks : {
        name     = disk.name
        sizeGb   = disk.size_gb
        tier     = disk.tier
        path     = local.disk_paths[disk.name]
        bootable = disk.name == "os"
      }
    ]
    replica = var.replica == null ? null : {
      targetCluster    = var.replica.target_cluster
      frequencySeconds = var.replica.frequency_seconds
      recoveryPoints   = 24
    }
    configuration = {
      dscRole  = var.dsc_role
      dscFile  = format("platform/iac/dsc/%s.dsc.yaml", var.dsc_role)
      identity = var.gmsa
    }
    tags = var.tags
  }
}

resource "terraform_data" "specification" {
  input = local.specification

  lifecycle {
    precondition {
      condition     = !var.shielding.enabled || var.generation == 2
      error_message = "A shielded virtual machine needs a generation 2 virtual TPM."
    }

    precondition {
      condition     = var.replica == null || var.replica.target_cluster != var.cluster
      error_message = "Replicating a virtual machine to the cluster it already runs on protects nothing."
    }

    precondition {
      condition     = local.total_disk_gb <= 16384
      error_message = "Total declared disk exceeds 16 TB for one virtual machine; split the workload or raise the ceiling deliberately."
    }
  }
}
