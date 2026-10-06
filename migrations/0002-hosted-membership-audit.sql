BEGIN;
CREATE TABLE mcp_identity.membership_audit (
  event_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  occurred_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  transaction_id xid8 NOT NULL DEFAULT pg_catalog.pg_current_xact_id(),
  actor_role text NOT NULL CHECK (actor_role <> ''),
  entity_type text NOT NULL CHECK (entity_type IN ('workspace', 'membership')),
  action text NOT NULL CHECK (action IN ('INSERT', 'UPDATE', 'DELETE')),
  before_state jsonb,
  after_state jsonb,
  CHECK (
    (action = 'INSERT' AND before_state IS NULL AND after_state IS NOT NULL) OR
    (action = 'UPDATE' AND before_state IS NOT NULL AND after_state IS NOT NULL) OR
    (action = 'DELETE' AND before_state IS NOT NULL AND after_state IS NULL)
  )
);
REVOKE ALL ON mcp_identity.membership_audit FROM PUBLIC;

-- Only the trusted migration owner owns this function. Explicit fields avoid logging future secrets.
CREATE FUNCTION mcp_identity.record_membership_audit() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, mcp_identity, pg_temp
AS $$
DECLARE
  previous_state jsonb;
  next_state jsonb;
  entity text;
BEGIN
  IF TG_TABLE_SCHEMA <> 'mcp_identity' OR TG_OP NOT IN ('INSERT', 'UPDATE', 'DELETE') THEN
    RAISE EXCEPTION 'Unsupported membership audit source';
  END IF;
  IF TG_TABLE_NAME = 'workspaces' THEN
    entity := 'workspace';
    IF TG_OP <> 'INSERT' THEN
      previous_state := pg_catalog.jsonb_build_object('workspace_id', OLD.workspace_id, 'tenant_id', OLD.tenant_id, 'disabled_at', OLD.disabled_at);
    END IF;
    IF TG_OP <> 'DELETE' THEN
      next_state := pg_catalog.jsonb_build_object('workspace_id', NEW.workspace_id, 'tenant_id', NEW.tenant_id, 'disabled_at', NEW.disabled_at);
    END IF;
  ELSIF TG_TABLE_NAME = 'workspace_memberships' THEN
    entity := 'membership';
    IF TG_OP <> 'INSERT' THEN
      previous_state := pg_catalog.jsonb_build_object('issuer', OLD.issuer, 'principal_id', OLD.principal_id,
        'workspace_id', OLD.workspace_id, 'permissions', OLD.permissions, 'revoked_at', OLD.revoked_at);
    END IF;
    IF TG_OP <> 'DELETE' THEN
      next_state := pg_catalog.jsonb_build_object('issuer', NEW.issuer, 'principal_id', NEW.principal_id,
        'workspace_id', NEW.workspace_id, 'permissions', NEW.permissions, 'revoked_at', NEW.revoked_at);
    END IF;
  ELSE
    RAISE EXCEPTION 'Unsupported membership audit source';
  END IF;
  INSERT INTO mcp_identity.membership_audit(actor_role, entity_type, action, before_state, after_state)
    VALUES (SESSION_USER, entity, TG_OP, previous_state, next_state);
  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION mcp_identity.record_membership_audit() FROM PUBLIC;

CREATE TRIGGER workspace_membership_audit
AFTER INSERT OR UPDATE OR DELETE ON mcp_identity.workspace_memberships
FOR EACH ROW EXECUTE FUNCTION mcp_identity.record_membership_audit();
CREATE TRIGGER workspace_audit
AFTER INSERT OR UPDATE OR DELETE ON mcp_identity.workspaces
FOR EACH ROW EXECUTE FUNCTION mcp_identity.record_membership_audit();
COMMIT;
