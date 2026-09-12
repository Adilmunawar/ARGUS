DO $$
DECLARE
  breakglass_name text := coalesce(current_setting('argus.breakglass_user', true), '');
  salt_hex        text := coalesce(current_setting('argus.breakglass_salt_hex', true), '');
  hash_hex        text := coalesce(current_setting('argus.breakglass_hash_hex', true), '');
BEGIN
  IF breakglass_name = '' THEN
    RAISE EXCEPTION 'argus.breakglass_user was never set on this session, so this file has no account to create. init.sh binds it from GUAC_BREAKGLASS_USER.';
  END IF;

  IF breakglass_name = 'guacadmin' THEN
    RAISE EXCEPTION 'argus.breakglass_user is "guacadmin", the account 20-retire-default-admin.sql deletes. Creating it here and deleting it there leaves guacamole_db with no administrator.';
  END IF;

  IF length(breakglass_name) > 128 THEN
    RAISE EXCEPTION 'argus.breakglass_user is % characters long; guacamole_entity.name is varchar(128).', length(breakglass_name);
  END IF;

  IF salt_hex !~ '^[0-9A-Fa-f]{64}$' THEN
    RAISE EXCEPTION 'argus.breakglass_salt_hex is not 64 hex characters, so it is not the 32-byte salt bootstrap.ps1 hashed the password with.';
  END IF;

  IF hash_hex !~ '^[0-9A-Fa-f]{64}$' THEN
    RAISE EXCEPTION 'argus.breakglass_hash_hex is not 64 hex characters, so it is not a SHA-256 digest. Guacamole compares SHA256(password_utf8 + UPPERCASE_HEX(password_salt)) against password_hash and nothing else will ever match.';
  END IF;
END
$$;

INSERT INTO guacamole_entity (name, type)
SELECT current_setting('argus.breakglass_user'), 'USER'::guacamole_entity_type
ON CONFLICT (type, name) DO NOTHING;

INSERT INTO guacamole_user (entity_id, password_hash, password_salt, password_date)
SELECT entity.entity_id,
       decode(current_setting('argus.breakglass_hash_hex'), 'hex'),
       decode(current_setting('argus.breakglass_salt_hex'), 'hex'),
       CURRENT_TIMESTAMP
FROM guacamole_entity AS entity
WHERE entity.type = 'USER'
  AND entity.name = current_setting('argus.breakglass_user')
ON CONFLICT (entity_id) DO NOTHING;

INSERT INTO guacamole_system_permission (entity_id, permission)
SELECT entity.entity_id, granted.permission::guacamole_system_permission_type
FROM guacamole_entity AS entity
CROSS JOIN (VALUES
    ('CREATE_CONNECTION'),
    ('CREATE_CONNECTION_GROUP'),
    ('CREATE_SHARING_PROFILE'),
    ('CREATE_USER'),
    ('CREATE_USER_GROUP'),
    ('ADMINISTER')
) AS granted (permission)
WHERE entity.type = 'USER'
  AND entity.name = current_setting('argus.breakglass_user')
ON CONFLICT (entity_id, permission) DO NOTHING;

INSERT INTO guacamole_user_permission (entity_id, affected_user_id, permission)
SELECT entity.entity_id, account.user_id, granted.permission::guacamole_object_permission_type
FROM guacamole_entity AS entity
JOIN guacamole_user AS account
  ON account.entity_id = entity.entity_id
CROSS JOIN (VALUES
    ('READ'),
    ('UPDATE'),
    ('ADMINISTER')
) AS granted (permission)
WHERE entity.type = 'USER'
  AND entity.name = current_setting('argus.breakglass_user')
ON CONFLICT (entity_id, affected_user_id, permission) DO NOTHING;

DO $$
DECLARE
  breakglass_name text := current_setting('argus.breakglass_user');
  is_disabled     boolean;
  is_expired      boolean;
  administers     boolean;
BEGIN
  SELECT account.disabled, account.expired
    INTO is_disabled, is_expired
  FROM guacamole_entity AS entity
  JOIN guacamole_user AS account
    ON account.entity_id = entity.entity_id
  WHERE entity.type = 'USER'
    AND entity.name = breakglass_name;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'the break-glass account % has no guacamole_user row after this file ran.', breakglass_name;
  END IF;

  SELECT EXISTS (
    SELECT 1
    FROM guacamole_entity AS entity
    JOIN guacamole_system_permission AS granted
      ON granted.entity_id = entity.entity_id
    WHERE entity.type = 'USER'
      AND entity.name = breakglass_name
      AND granted.permission = 'ADMINISTER'
  ) INTO administers;

  IF NOT administers THEN
    RAISE EXCEPTION 'the break-glass account % holds no ADMINISTER system permission, so it cannot administer guacamole_db and must not stand in for guacadmin.', breakglass_name;
  END IF;

  IF is_disabled OR is_expired THEN
    RAISE WARNING 'the break-glass account % is disabled=% expired=% and cannot log in. This seed never re-enables an account someone turned off; clear the flag in the Guacamole UI when the incident is over.', breakglass_name, is_disabled, is_expired;
  END IF;
END
$$;

SELECT entity.name       AS breakglass_account,
       account.password_date AS credential_set,
       account.disabled   AS disabled,
       account.expired    AS expired
FROM guacamole_entity AS entity
JOIN guacamole_user AS account
  ON account.entity_id = entity.entity_id
WHERE entity.type = 'USER'
  AND entity.name = current_setting('argus.breakglass_user');
