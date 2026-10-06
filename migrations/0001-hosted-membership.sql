BEGIN;
CREATE SCHEMA IF NOT EXISTS mcp_identity;
CREATE TABLE mcp_identity.workspaces (
  workspace_id text PRIMARY KEY CHECK (length(workspace_id) BETWEEN 1 AND 256 AND btrim(workspace_id) <> ''),
  tenant_id text NOT NULL CHECK (length(tenant_id) BETWEEN 1 AND 256 AND btrim(tenant_id) <> ''),
  disabled_at timestamptz
);
CREATE TABLE mcp_identity.workspace_memberships (
  issuer text NOT NULL CHECK (length(issuer) BETWEEN 1 AND 2048 AND btrim(issuer) <> ''),
  principal_id text NOT NULL CHECK (length(principal_id) BETWEEN 1 AND 256 AND btrim(principal_id) <> ''),
  workspace_id text NOT NULL REFERENCES mcp_identity.workspaces(workspace_id),
  permissions text[] NOT NULL CHECK (
    coalesce(array_ndims(permissions), 1) = 1 AND cardinality(permissions) <= 8
    AND
    permissions <@ ARRAY['search:read','content:read','knowledge:read','knowledge:write','memory:read','memory:write','status:read','cache:manage']::text[]
    AND array_position(permissions, NULL) IS NULL
  ),
  revoked_at timestamptz,
  PRIMARY KEY (issuer, principal_id, workspace_id)
);
COMMIT;
