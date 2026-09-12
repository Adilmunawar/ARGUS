path "database/creds/argus-app" {
  capabilities = ["read"]
}

path "transit/encrypt/argus-pii" {
  capabilities = ["update"]
}

path "transit/decrypt/argus-pii" {
  capabilities = ["update"]
}

path "transit/rewrap/argus-pii" {
  capabilities = ["update"]
}

path "transit/keys/*" {
  capabilities = ["deny"]
}

path "transit/export/*" {
  capabilities = ["deny"]
}

path "transit/byok-export/*" {
  capabilities = ["deny"]
}

path "transit/wrapping_key" {
  capabilities = ["deny"]
}

path "transit/datakey/*" {
  capabilities = ["deny"]
}

path "transit/*" {
  capabilities = ["deny"]
}

path "database/config/*" {
  capabilities = ["deny"]
}

path "database/roles/*" {
  capabilities = ["deny"]
}

path "database/rotate-root/*" {
  capabilities = ["deny"]
}

path "database/reset/*" {
  capabilities = ["deny"]
}

path "database/*" {
  capabilities = ["deny"]
}

path "argus-kv/data/*" {
  capabilities = ["deny"]
}

path "argus-kv/metadata/*" {
  capabilities = ["deny"]
}

path "argus-kv/detailed-metadata/*" {
  capabilities = ["deny"]
}

path "argus-kv/subkeys/*" {
  capabilities = ["deny"]
}

path "argus-kv/delete/*" {
  capabilities = ["deny"]
}

path "argus-kv/undelete/*" {
  capabilities = ["deny"]
}

path "argus-kv/destroy/*" {
  capabilities = ["deny"]
}

path "argus-kv/config" {
  capabilities = ["deny"]
}

path "cubbyhole/*" {
  capabilities = ["deny"]
}

path "auth/approle/role/*" {
  capabilities = ["deny"]
}

path "auth/token/create*" {
  capabilities = ["deny"]
}

path "sys/raw/*" {
  capabilities = ["deny"]
}

path "sys/policy/*" {
  capabilities = ["deny"]
}

path "sys/policies/*" {
  capabilities = ["deny"]
}

path "sys/mounts/*" {
  capabilities = ["deny"]
}

path "sys/auth/*" {
  capabilities = ["deny"]
}

path "sys/audit/*" {
  capabilities = ["deny"]
}

path "sys/storage/raft/snapshot*" {
  capabilities = ["deny"]
}

path "sys/rekey/*" {
  capabilities = ["deny"]
}

path "sys/rotate*" {
  capabilities = ["deny"]
}

path "sys/remount" {
  capabilities = ["deny"]
}

path "sys/seal" {
  capabilities = ["deny"]
}

path "sys/step-down" {
  capabilities = ["deny"]
}
