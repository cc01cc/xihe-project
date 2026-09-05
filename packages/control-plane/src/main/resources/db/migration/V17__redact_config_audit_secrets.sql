UPDATE config_audit
SET old_value = CASE
        WHEN old_value IS NULL OR BTRIM(old_value) = '' THEN 'missing'
        ELSE 'present:legacy:' || MD5(old_value)
    END,
    new_value = CASE
        WHEN new_value IS NULL OR BTRIM(new_value) = '' THEN 'missing'
        ELSE 'present:legacy:' || MD5(new_value)
    END
WHERE LOWER(domain) = 'llm-provider'
  AND (
      LOWER(config_key) LIKE '%apikey%'
      OR LOWER(config_key) LIKE '%secret%'
      OR LOWER(config_key) LIKE '%password%'
      OR LOWER(config_key) LIKE '%token%'
  );
