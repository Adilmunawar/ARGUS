# Argus Reconciler

The Service Fabric stateful reliable service that reads desired state from the GitOps repository, compares it with the actual state of the estate, and applies the difference in dependency order, as described in [the control plane design](../../../../docs/05-CONTROL-PLANE.md). Its contents are added in the phase that owns this directory; see [the phases and runbooks plan](../../../../docs/06-PHASES-AND-RUNBOOKS.md).
