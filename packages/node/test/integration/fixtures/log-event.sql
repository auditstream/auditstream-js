-- Fixture implementing auditstream.log_event(text, jsonb, jsonb) from Spec 0.1.0
-- on top of @auditstream/test-utils's prototype schema (where resolve_actor returns
-- OUT actor jsonb, OUT src text). The real function ships from the engine (D2).

CREATE OR REPLACE FUNCTION auditstream.log_event(
  action text,
  target jsonb DEFAULT NULL,
  data jsonb DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $fn$
DECLARE
  raw_actor jsonb;
  v_actor jsonb;
  v_context jsonb;
  v_actor_source text;
  v_event_id uuid;
BEGIN
  IF action IS NULL
     OR pg_catalog.char_length(pg_catalog.btrim(action)) < 1
     OR pg_catalog.char_length(action) > 64
     OR pg_catalog.upper(action) IN ('INSERT', 'UPDATE', 'DELETE', 'TRUNCATE') THEN
    RAISE EXCEPTION 'auditstream.log_event: invalid action %', action
      USING ERRCODE = '22023';
  END IF;

  SELECT r.actor, r.src
    INTO raw_actor, v_actor_source
    FROM auditstream.resolve_actor() AS r;

  IF raw_actor IS NOT NULL THEN
    IF pg_catalog.jsonb_typeof(raw_actor->'context') = 'object' THEN
      v_context := raw_actor->'context';
    END IF;
    v_actor := raw_actor - 'context';
  END IF;

  INSERT INTO auditstream.changes (
    source,
    op,
    record_id,
    after,
    actor,
    context,
    actor_source,
    db_user,
    schema_version
  )
  VALUES (
    'app',
    action,
    target,
    data,
    v_actor,
    v_context,
    v_actor_source,
    session_user,
    1
  )
  RETURNING event_id INTO v_event_id;

  RETURN v_event_id;
END
$fn$;

ALTER FUNCTION auditstream.log_event(text, jsonb, jsonb) OWNER TO auditstream_owner;
REVOKE ALL ON FUNCTION auditstream.log_event(text, jsonb, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION auditstream.log_event(text, jsonb, jsonb) TO app_user;
