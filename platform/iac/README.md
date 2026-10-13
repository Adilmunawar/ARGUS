# Infrastructure as code

Declarative definitions for the Argus virtual machines and host configuration, applied only by the reconciler.

* `tofu/`: OpenTofu with the Hyper V provider, one module per VM class (`shielded-vm`), with inputs from `platform/gitops/clusters/*/vms/*.yaml`.
* `dsc/`: PowerShell DSC v3 configurations per host role (`hyperv-node`, `sf-node`, `sql-node`, `dc`, `ca`, `runner`). Each pins Windows features, the WDAC policy id, GPO membership, WinSW services with hash pinned binaries, exporters, the Wazuh agent and Sysmon.

The reconciler runs `tofu plan/apply` and `dsc config set` from the desired model; humans do not run them against production.
