# Argus S3 parity harness

Runs a suite of S3 conformance legs against **Argus** (the SeaweedFS S3 gateway, the
*subject*) and, when one is configured, the identical suite against a **reference**
(LocalStack, or genuine AWS), then reports per-feature conformance.

The reference is optional by design. LocalStack's free Community edition was
discontinued on 2026-03-23 and the current unified image demands an auth token, so the
only reference image that runs unauthenticated is the final Community build,
`localstack/localstack:4.14.0`. With no reference configured the harness runs against
Argus alone, compares each case against the expectation recorded from the SeaweedFS 3.97
route table, and reports `reference: absent`. A missing reference never fails a run.

## Running it

```
docker compose --profile parity up -d
docker compose exec parity node src/runner.js
```

Or on the Windows host, with the console's dependencies installed
(`cd platform/console/server && npm ci`):

```
cd platform/compose/services/parity
node src/runner.js
```

`src/sdk.js` resolves `@aws-sdk/client-s3` from `NODE_PATH` first and falls back to
`platform/console/server/node_modules`, so a host run needs no environment at all.

| Flag | Effect |
| --- | --- |
| `--list` | print every leg id, file and title, then exit |
| `--only <ids>` | run only these legs, comma separated (`--only object-retention,legal-hold`) |
| `--report <path>` | write the JSON report here instead of `$ARGUS_PARITY_REPORT` |
| `--serve` | stay up, re-run every `ARGUS_PARITY_INTERVAL_MS`, and answer `/healthz` and `/latest.json` |
| `--once` | force a single run even when `ARGUS_PARITY_SERVE` is set |

## Output

A human-readable summary on stdout, and a machine-readable report at
`ARGUS_PARITY_REPORT` (default `/var/lib/argus/parity/latest.json`). The output directory
is created recursively before the write, and the write is `.tmp` + `rename()` so the
console can read `latest.json` while a run is in flight. A report the harness could not
write is reported on stderr; it never aborts the run.

### Verdicts

| Verdict | Meaning |
| --- | --- |
| `conform` | both sides behaved the same way, or the subject matched the recorded expectation |
| `diverge` | **both sides answered, differently.** An application written against one silently misbehaves on the other |
| `absent` | the route is not registered on the subject. Safe, because it fails loudly at the call site |
| `untestable` | could not be run: subject unreachable, no reference and no recorded expectation, or insufficient privilege |
| `error` | the harness itself failed. Never reported as a platform defect |

### Exit code

`0` when every testable leg conformed or was a recorded known-absence. Otherwise the
number of `diverge` findings, capped at 125. A missing reference, a missing credential and
an unreachable subject all exit `0` — they produce `untestable`, which is a finding about
the run, not about the platform. The single exception is exit `70`: `@aws-sdk/client-s3`
could not be resolved and `ARGUS_PARITY_SDK_REQUIRED` is set, which is a harness bootstrap
failure rather than a verdict.

A run in which checks failed is still a successful run. In `--serve` mode `/healthz`
reports whether the prover executed; the verdict lives only in `latest.json`.

## Identities

Three credentials, each doing as little as it can.

| Identity | Env | Used by |
| --- | --- | --- |
| standard | `ARGUS_PARITY_ACCESS_KEY` / `_SECRET_KEY` | the bulk of the suite, against `argus-parity` and `argus-parity-worm` |
| deny | `ARGUS_PARITY_DENY_ACCESS_KEY` / `_SECRET_KEY` | negative authorisation only, non-mutating operations only |
| admin | `ARGUS_PARITY_ADMIN_ACCESS_KEY` / `_SECRET_KEY` | bucket CRUD, bucket encryption, public access block, ownership controls |

SeaweedFS 3.97 gates `PutBucketHandler`, `Put/Get/DeleteBucketEncryption`,
`Put/Get/DeletePublicAccessBlock` and `Put/DeleteBucketOwnershipControls` on **global**
`Admin`, not on `Admin:bucket`. The existing `argus-parity` identity therefore cannot
create a bucket. The admin identity is separate so that the credential doing hundreds of
object operations is not the one holding global admin, and the buckets it creates are
per-run (`argus-parity-crud-<nonce>`) and destroyed in teardown. If the admin credential
is absent those legs report `untestable (insufficient privilege)` rather than failing.

## Cleanup, and the one object that survives

Every leg owns a unique key prefix, `run/<runId>/<legId>/`, and registers its own
teardown. Teardown aborts multipart uploads first (an orphaned upload keeps a bucket
un-deletable and is invisible to `ListObjectsV2`), then releases legal holds, then deletes
every object *version* and every delete marker with
`x-amz-bypass-governance-retention: true`.

That works for everything except COMPLIANCE. A COMPLIANCE-locked object cannot be deleted
before its retain-until date by anyone, with no bypass — that is the WORM guarantee, and
proving it is the point of the `object-retention` leg. So the harness makes a deliberate
trade:

- every fixture it can put under **GOVERNANCE** is put under GOVERNANCE and removed with
  bypass at the end of the leg;
- exactly **one** COMPLIANCE canary is written per run, with a retain-until of
  `ARGUS_S3_WORM_RETAIN_SECONDS` (default 120s) rather than a bucket default, so the
  residue is one small object that becomes deletable two minutes later;
- every run begins by sweeping `run/` in the WORM bucket, which collects the canaries of
  previous runs whose retention has since expired.

A bucket default of COMPLIANCE would instead pile up permanently undeletable objects on
the very volume the harness exists to prove is durable, with `docker compose down -v` as
the only exit.

## The checksum axis

The JS SDK v3 defaults `requestChecksumCalculation` to `when_supported`, which sends
`x-amz-checksum-crc32` on every `PutObject` and per-part `x-amz-checksum-crc32c` on
multipart. The harness does **not** pin this to `when_required` globally — that would hide
the exact difference it exists to find. `object-basics` and `multipart` each run twice,
once per mode, and report both cells.

## Presigned URLs

`@aws-sdk/s3-request-presigner` is not a dependency of `platform/console/server`, and the
parity container mounts that `node_modules` read-only, so the harness signs its own
presigned URLs in `src/presign.js` using `node:crypto` and nothing else. The
implementation was verified to produce byte-identical signatures to
`@smithy/signature-v4` for GET, for PUT, and for a key containing `+`, a space and a
non-ASCII character with an additional signed header.

## Adding a leg

Drop a file in `src/legs/`. It is discovered by filename order; the runner is not
touched. A leg exports `{ id, title, matrixRows, run(ctx) }`:

```js
'use strict';

module.exports = {
  id: 'my-feature',
  title: 'My feature',
  matrixRows: [14],
  async run(ctx) {
    const { GetObjectCommand } = ctx.sdk;
    ctx.cleanup(() => ctx.forEachSide((s3) => somethingTidy(s3)));
    await ctx.compare('reads-the-object', async (s3, side) => {
      const response = await s3.send(new GetObjectCommand({ Bucket: ctx.buckets.main, Key: ctx.key('probe') }));
      return { status: response.$metadata.httpStatusCode };
    }, { expected: { outcome: 'ok', detail: { status: 200 } } });
  },
};
```

`ctx.compare(id, fn, opts)` runs `fn` on the subject and, when configured, on the
reference, and produces the verdict. `opts` takes `identity` (`standard` | `deny` |
`admin`), `checksums` (`when_required` | `when_supported`), `expected` (a subset match
used when no reference is configured), `referenceApplicable: false` (for cases the
reference cannot answer — LocalStack Community does not enforce IAM, so every negative
authorisation case is subject-only), and `title`.

`ctx.expectAbsent(id, fn)` is for routes the recorded matrix says are not registered on
SeaweedFS: it runs the subject only, and reports `absent` when the call fails at the route
level or `diverge` when the subject unexpectedly answers.

Return only **stable** values from `fn`. Etags, dates and version ids differ between
implementations by design; comparing them would make every case diverge. Return shapes and
booleans instead — `etagShape(response.ETag)`, `matches: body === expected`.

## What is covered

23 legs over the 32-row S3 feature matrix. Rows 22-29, 31 and 32 are hard route-level
absences on SeaweedFS 3.97 and are reported as `absent by design` by the
`absent-by-design` leg, not as failures. Row 30, `SelectObjectContent`, is excluded: it is
absent on SeaweedFS and broken on LocalStack, so there is nothing to compare it against.

## The LocalStack reference

`localstack-init/` is mounted at `/etc/localstack/init/ready.d`. The scripts are `.py`,
not `.sh`, deliberately: the shell runner invokes scripts directly and needs the exec bit,
which does not survive a checkout on NTFS, while the Python runner uses `exec()` and does
not. On a Windows-first project that is the difference between the seed running and the
seed silently not running.

`01-buckets.py` creates `argus-parity` (versioned), `argus-parity-worm` (object lock
enabled, which implies versioning) and `argus-parity-forbidden`. `02-verify-seed.py`
asserts all three exist and are configured, so a partial seed fails the READY stage and the
reference never reports healthy with half a fixture. It does **not** create the Argus-side
buckets: those come from `storage-init` and `buckets.yaml`, and two sources of truth for
what the harness expects to exist is one too many.
