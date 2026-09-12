variable "name" {
  type = string

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{1,14}$", var.name))
    error_message = "name must be 2-15 lowercase characters, digits or hyphens, starting with a letter, because it becomes the Windows computer name."
  }
}

variable "cluster" {
  type = string

  validation {
    condition     = can(regex("^argus-hvc-[a-z]$", var.cluster))
    error_message = "cluster must name an Argus Hyper-V cluster, such as argus-hvc-a."
  }
}

variable "generation" {
  type    = number
  default = 2

  validation {
    condition     = var.generation == 2
    error_message = "generation must be 2. A shielded VM requires UEFI and a virtual TPM, neither of which a generation 1 VM has."
  }
}

variable "vcpu" {
  type = number

  validation {
    condition     = var.vcpu >= 2 && var.vcpu <= 128 && floor(var.vcpu) == var.vcpu
    error_message = "vcpu must be a whole number between 2 and 128."
  }
}

variable "memory_mb" {
  type = number

  validation {
    condition     = var.memory_mb >= 2048 && var.memory_mb % 1024 == 0
    error_message = "memory_mb must be at least 2048 and a whole number of gibibytes."
  }
}

variable "vlan" {
  type = number

  validation {
    condition     = var.vlan >= 1 && var.vlan <= 4094
    error_message = "vlan must be a valid 802.1Q identifier between 1 and 4094."
  }
}

variable "shielding" {
  type = object({
    enabled = bool
    hgs     = string
  })

  validation {
    condition     = var.shielding.enabled == false || can(regex("^[a-z0-9.-]+\\.argus\\.local$", var.shielding.hgs))
    error_message = "shielding.hgs must be a host guardian service inside argus.local when shielding is enabled."
  }
}

variable "disks" {
  type = list(object({
    name    = string
    size_gb = number
    tier    = string
  }))

  validation {
    condition     = length(var.disks) > 0 && contains([for d in var.disks : d.name], "os")
    error_message = "disks must include one named os."
  }

  validation {
    condition     = alltrue([for d in var.disks : contains(["nvme", "ssd", "hdd"], d.tier)])
    error_message = "every disk tier must be nvme, ssd or hdd."
  }

  validation {
    condition     = length(distinct([for d in var.disks : d.name])) == length(var.disks)
    error_message = "disk names must be unique within a virtual machine."
  }

  validation {
    condition     = alltrue([for d in var.disks : d.size_gb >= 40])
    error_message = "every disk must be at least 40 GB."
  }
}

variable "replica" {
  type = object({
    target_cluster    = string
    frequency_seconds = number
  })
  default = null

  validation {
    condition     = var.replica == null || contains([30, 300, 900], try(var.replica.frequency_seconds, 300))
    error_message = "Hyper-V Replica accepts a replication frequency of 30, 300 or 900 seconds only."
  }
}

variable "dsc_role" {
  type = string

  validation {
    condition     = contains(["hyperv-node", "sf-node", "sql-node", "dc", "ca", "runner"], var.dsc_role)
    error_message = "dsc_role must be one of the roles that has a configuration under platform/iac/dsc."
  }
}

variable "gmsa" {
  type = string

  validation {
    condition     = can(regex("^gmsa-[a-z0-9-]+\\$$", var.gmsa))
    error_message = "gmsa must name a group managed service account and end with a dollar sign, matching platform/gitops/identity/gmsa.yaml."
  }
}

variable "tags" {
  type = map(string)

  validation {
    condition     = contains(keys(var.tags), "tier")
    error_message = "tags must carry a tier, because backup policy and patch window are selected from it."
  }

  validation {
    condition     = contains(["0", "1", "2", "3"], try(var.tags.tier, ""))
    error_message = "tags.tier must be 0, 1, 2 or 3."
  }
}
