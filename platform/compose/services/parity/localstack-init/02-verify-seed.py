import sys

import boto3

ENDPOINT = "http://127.0.0.1:4566"
REGION = "us-east-1"

EXPECTED_VERSIONED = ("argus-parity", "argus-parity-worm")
EXPECTED_BUCKETS = EXPECTED_VERSIONED + ("argus-parity-forbidden",)

client = boto3.client(
    "s3",
    endpoint_url=ENDPOINT,
    region_name=REGION,
    aws_access_key_id="test",
    aws_secret_access_key="test",
)

present = {entry["Name"] for entry in client.list_buckets().get("Buckets", [])}
missing = [name for name in EXPECTED_BUCKETS if name not in present]
if missing:
    sys.exit("argus parity reference seed incomplete, missing: " + ", ".join(missing))

for name in EXPECTED_VERSIONED:
    status = client.get_bucket_versioning(Bucket=name).get("Status")
    if status != "Enabled":
        sys.exit("argus parity reference seed: %s versioning is %r, expected 'Enabled'" % (name, status))

lock = client.get_object_lock_configuration(Bucket="argus-parity-worm")
if lock["ObjectLockConfiguration"]["ObjectLockEnabled"] != "Enabled":
    sys.exit("argus parity reference seed: argus-parity-worm has no object lock")
