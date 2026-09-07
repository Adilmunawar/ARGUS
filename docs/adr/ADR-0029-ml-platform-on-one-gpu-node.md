# ADR-0029 — ML platform on one GPU node

**Decision.** `gpu-01`: Ubuntu 24.04, 2 × NVIDIA L40S, Ray (head + workers on the same box), MLflow (artefacts to `argus-ml`), Dagster (asset graphs for the v5 classifier feature tables and the SegFormer/HRNet pipelines), JupyterHub with AD FS login. No Kubeflow, no KServe: inference endpoints are Ray Serve behind Caddy.

**Why.** The team's pipelines are Colab notebooks and Python scripts today; Ray + Dagster is the smallest step up that gives scheduling, lineage and resumability. Fractional GPU sharing is by Ray's resource accounting, not by the OS — adequate for a two-GPU box.

---
Index: [`docs/01-DECISIONS.md`](../01-DECISIONS.md)
