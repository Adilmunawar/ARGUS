DO $$
DECLARE
  stock_name CONSTANT text := 'guacadmin';
  other_enabled_administrators integer;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM guacamole_entity WHERE type = 'USER' AND name = stock_name
  ) THEN
    RAISE NOTICE 'the default % account is already absent; nothing to retire', stock_name;
    RETURN;
  END IF;

  SELECT count(DISTINCT entity.entity_id)
    INTO other_enabled_administrators
  FROM guacamole_entity AS entity
  JOIN guacamole_user AS account
    ON account.entity_id = entity.entity_id
  JOIN guacamole_system_permission AS granted
    ON granted.entity_id = entity.entity_id
  WHERE entity.type = 'USER'
    AND entity.name <> stock_name
    AND granted.permission = 'ADMINISTER'
    AND NOT account.disabled
    AND NOT account.expired;

  IF other_enabled_administrators = 0 THEN
    RAISE EXCEPTION 'refusing to delete the default % account: no other enabled user holds ADMINISTER, so deleting it would leave guacamole_db with no administrator and no way back in. 10-breakglass-admin.sql runs first and exists to prevent this.', stock_name;
  END IF;

  RAISE NOTICE 'retiring the default % account; % other enabled administrator(s) remain', stock_name, other_enabled_administrators;
END
$$;

DELETE FROM guacamole_entity
WHERE type = 'USER'
  AND name = 'guacadmin';

SELECT count(*) AS default_guacadmin_rows
FROM guacamole_entity
WHERE type = 'USER'
  AND name = 'guacadmin';

SELECT entity.name     AS administrator,
       account.disabled AS disabled,
       account.expired  AS expired
FROM guacamole_entity AS entity
JOIN guacamole_user AS account
  ON account.entity_id = entity.entity_id
JOIN guacamole_system_permission AS granted
  ON granted.entity_id = entity.entity_id
WHERE entity.type = 'USER'
  AND granted.permission = 'ADMINISTER'
ORDER BY entity.name;
