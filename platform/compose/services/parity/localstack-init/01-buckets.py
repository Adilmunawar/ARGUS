import boto3

ENDPOINT = "http://127.0.0.1:4566"
REGION = "us-east-1"

client = boto3.client(
    "s3",
    endpoint_url=ENDPOINT,
    region_name=REGION,
    aws_access_key_id="test",
    aws_secret_access_key="test",
)

client.create_bucket(Bucket="argus-parity")

client.create_bucket(Bucket="argus-parity-worm", ObjectLockEnabledForBucket=True)

client.create_bucket(Bucket="argus-parity-forbidden")

client.put_bucket_versioning(
    Bucket="argus-parity",
    VersioningConfiguration={"Status": "Enabled"},
)
