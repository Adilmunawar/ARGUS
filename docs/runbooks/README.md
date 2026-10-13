# Runbooks

Each operational procedure lives in its own file, in the format below.

```
---
id: sql-01-restore-drill
title: Monthly restore drill for umairv3_db
tier: 1
params:
  - name: Target
    type: string
    default: sql-drill-01
approval: none | operator | approver | security
---
## When
## Preconditions
## Steps          (numbered; each with the exact command and the expected output)
## Verification
## Rollback
## Report         (what to commit to docs/runbooks/drills/)
```

The console renders `params` as a form and executes `Steps` over a JEA endpoint with a transcript. See [the phases and runbooks plan](../06-PHASES-AND-RUNBOOKS.md) for the initial list.
