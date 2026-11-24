/**
 * Prototype audit schema adapted from auditstream/docs/handbook/test-kit/sql/schema.sql
 * to run from Node without psql metacommands.
 *
 * `auditstream.resolve_actor()` and `auditstream.capture()` are kept verbatim from the prototype.
 */

function quoteSqlLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

/**
 * Creates cluster-wide `auditstream_owner` and `app_user` roles once per test run.
 * Roles are reused and never dropped because poolers keep sessions open for existing roles.
 */
export function buildRoleSetupSql(appPassword: string): string {
  const pwLiteral = quoteSqlLiteral(appPassword);
  return `
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'auditstream_owner') THEN
    EXECUTE 'CREATE ROLE auditstream_owner NOLOGIN';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_user') THEN
    EXECUTE 'CREATE ROLE app_user LOGIN';
  END IF;
  IF NOT pg_has_role(current_user, 'auditstream_owner', 'USAGE') THEN
    EXECUTE format('GRANT auditstream_owner TO %I', current_user);
  END IF;
  IF NOT pg_has_role(current_user, 'app_user', 'USAGE') THEN
    EXECUTE format('GRANT app_user TO %I', current_user);
  END IF;
END $$;
ALTER ROLE app_user LOGIN PASSWORD ${pwLiteral};
`;
}

/**
 * Prototype history schema, capture functions, sample tables and triggers applied to the
 * template database once per test run.
 */
export const PROTOTYPE_SCHEMA_SQL: string = `
DROP SCHEMA IF EXISTS auditstream CASCADE;
DROP TABLE IF EXISTS line_item, invoice, up_t, up_plain;

CREATE SCHEMA auditstream AUTHORIZATION auditstream_owner;
CREATE TABLE auditstream.changes (
  id bigint GENERATED ALWAYS AS IDENTITY,
  event_id uuid NOT NULL DEFAULT gen_random_uuid(),
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  xact_id xid8 NOT NULL DEFAULT pg_current_xact_id(),
  source text NOT NULL DEFAULT 'db',
  schema_name text, table_name text, table_oid oid, op text NOT NULL,
  record_id jsonb, before jsonb, after jsonb, changed text[],
  actor jsonb, context jsonb, actor_source text,
  db_user text NOT NULL DEFAULT session_user,
  schema_version smallint NOT NULL DEFAULT 1,
  PRIMARY KEY (id, occurred_at)
) PARTITION BY RANGE (occurred_at);
ALTER TABLE auditstream.changes OWNER TO auditstream_owner;
DO $$
DECLARE
  m_start timestamptz;
  m_end timestamptz;
  p_name text;
  i int;
BEGIN
  FOR i IN 0..2 LOOP
    m_start := date_trunc('month', now()) + make_interval(months => i);
    m_end := m_start + interval '1 month';
    p_name := format('changes_%s', to_char(m_start, 'YYYY_MM'));
    EXECUTE format(
      'CREATE TABLE auditstream.%I PARTITION OF auditstream.changes FOR VALUES FROM (%L) TO (%L)',
      p_name, m_start, m_end
    );
    EXECUTE format('ALTER TABLE auditstream.%I OWNER TO auditstream_owner', p_name);
  END LOOP;
END $$;
CREATE TABLE auditstream.changes_default PARTITION OF auditstream.changes DEFAULT;
ALTER TABLE auditstream.changes_default OWNER TO auditstream_owner;
CREATE INDEX ON auditstream.changes USING brin (occurred_at);
CREATE INDEX ON auditstream.changes (table_name, record_id, occurred_at);

CREATE FUNCTION auditstream.resolve_actor(OUT actor jsonb, OUT src text)
LANGUAGE plpgsql STABLE SET search_path = pg_catalog, pg_temp AS $f$
DECLARE v text; body text[]; m text[]; claims jsonb;
BEGIN
  v := nullif(current_setting('auditstream.actor', true), '');
  IF v IS NOT NULL THEN
    BEGIN actor := v::jsonb; src := 'set_config'; RETURN;
    EXCEPTION WHEN others THEN actor := NULL; src := 'invalid'; RETURN; END;
  END IF;
  -- last comment at the very end of the statement; sqlcommenter bodies never contain '/'
  body := regexp_match(right(current_query(), 4096), '/\\*([^/]*)\\*/[\\s;]*$');
  IF body IS NOT NULL THEN
    m := regexp_match(body[1], '(?:^|,)auditstream=''([A-Za-z0-9_-]+)''');
    IF m IS NOT NULL AND length(m[1]) <= 700 THEN
      BEGIN
        actor := convert_from(decode(translate(m[1], '-_', '+/') || repeat('=', (4 - length(m[1]) % 4) % 4), 'base64'), 'UTF8')::jsonb;
        src := 'comment'; RETURN;
      EXCEPTION WHEN others THEN actor := NULL; src := 'invalid'; RETURN; END;
    END IF;
  END IF;
  claims := nullif(current_setting('request.jwt.claims', true), '')::jsonb;
  IF claims ? 'sub' THEN actor := jsonb_build_object('type','user','id',claims->>'sub'); src := 'jwt'; RETURN; END IF;
END $f$;

CREATE FUNCTION auditstream.capture() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $f$
DECLARE b jsonb; a jsonb; ex text[] := coalesce(TG_ARGV::text[], '{}'); act jsonb; src text;
BEGIN
  SELECT r.actor, r.src INTO act, src FROM auditstream.resolve_actor() r;
  IF TG_OP = 'TRUNCATE' THEN
    INSERT INTO auditstream.changes(schema_name, table_name, table_oid, op, actor, actor_source)
    VALUES (TG_TABLE_SCHEMA, TG_TABLE_NAME, TG_RELID, 'TRUNCATE', act, src);
    RETURN NULL;
  END IF;
  IF TG_OP <> 'INSERT' THEN b := to_jsonb(OLD) - ex; END IF;
  IF TG_OP <> 'DELETE' THEN a := to_jsonb(NEW) - ex; END IF;
  IF TG_OP = 'UPDATE' AND a = b THEN RETURN NULL; END IF;
  INSERT INTO auditstream.changes(schema_name, table_name, table_oid, op, record_id, before, after, changed, actor, actor_source)
  VALUES (TG_TABLE_SCHEMA, TG_TABLE_NAME, TG_RELID, TG_OP, jsonb_build_object('id', coalesce(a, b)->'id'), b, a,
    CASE WHEN TG_OP = 'UPDATE' THEN ARRAY(SELECT k FROM jsonb_each(a) e(k, v) WHERE b->k IS DISTINCT FROM v) END, act, src);
  RETURN NULL;
END $f$;
ALTER FUNCTION auditstream.capture() OWNER TO auditstream_owner;
ALTER FUNCTION auditstream.resolve_actor() OWNER TO auditstream_owner;
REVOKE ALL ON FUNCTION auditstream.capture() FROM PUBLIC;
GRANT USAGE ON SCHEMA auditstream TO app_user;
GRANT SELECT ON auditstream.changes TO app_user;

CREATE TABLE invoice (id int PRIMARY KEY, status text, total numeric, password_hash text);
CREATE TABLE line_item (id int PRIMARY KEY, invoice_id int REFERENCES invoice(id) ON DELETE CASCADE, qty int);
GRANT SELECT, INSERT, UPDATE, DELETE, TRUNCATE ON invoice, line_item TO app_user;
CREATE TRIGGER audit_iud AFTER INSERT OR DELETE ON invoice FOR EACH ROW EXECUTE FUNCTION auditstream.capture('password_hash');
CREATE TRIGGER audit_u AFTER UPDATE ON invoice FOR EACH ROW WHEN (OLD.* IS DISTINCT FROM NEW.*) EXECUTE FUNCTION auditstream.capture('password_hash');
CREATE TRIGGER audit_t AFTER TRUNCATE ON invoice FOR EACH STATEMENT EXECUTE FUNCTION auditstream.capture();
CREATE TRIGGER audit_iud AFTER INSERT OR DELETE ON line_item FOR EACH ROW EXECUTE FUNCTION auditstream.capture();
CREATE TRIGGER audit_u AFTER UPDATE ON line_item FOR EACH ROW WHEN (OLD.* IS DISTINCT FROM NEW.*) EXECUTE FUNCTION auditstream.capture();
CREATE TRIGGER audit_t AFTER TRUNCATE ON line_item FOR EACH STATEMENT EXECUTE FUNCTION auditstream.capture();
`;
