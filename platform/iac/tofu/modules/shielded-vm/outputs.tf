output "specification" {
  value       = terraform_data.specification.output
  description = "The resolved virtual machine specification the reconciler applies through Hyper-V and DSC."
}

output "name" {
  value = var.name
}

output "disk_paths" {
  value       = local.disk_paths
  description = "Cluster shared volume path for each declared disk, keyed by disk name."
}

output "dsc_file" {
  value       = local.specification.configuration.dscFile
  description = "The DSC v3 configuration this virtual machine is reconciled against."
}

output "total_disk_gb" {
  value = local.total_disk_gb
}
