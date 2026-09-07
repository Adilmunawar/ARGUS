# Infrastructure as code

`tofu/`, OpenTofu with the Hyper-V provider: one module per VM class (`shielded-vm`), inputs from `platform/gitops/clusters/*/vms/*.yaml`. `dsc/`; PowerShell DSC v3 configurations per host role (`hyperv-node`, `sf-node`, `sql-node`, `dc`, `ca`, `runner`), each pinning: Windows features, WDAC policy id, GPO membership, WinSW services with hash-pinned binaries, exporters, Wazuh agent, Sysmon.

The reconciler runs `tofu plan/apply` and `dsc config set` from the desired model; humans do not run them against production.
