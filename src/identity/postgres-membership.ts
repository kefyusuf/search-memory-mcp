import { Pool, type PoolClient, type PoolConfig } from "pg";
import type { MembershipLookupInput } from "../runtime/jwt-authorization.js";
import { InvocationError, PERMISSIONS, type WorkspaceMembership } from "../runtime/request-context.js";

export type PostgresMembershipOptions = {
  connectionString: string;
  issuer: string;
  maxConcurrentLookups: number;
  lookupTimeoutMs: number;
  ssl?: PoolConfig["ssl"];
};

export class PostgresMembershipResolver {
  private readonly pool: Pool;
  private readonly issuer: string;
  private readonly capacity: number;
  private readonly timeoutMs: number;
  private active = 0;
  private closed = false;
  private closing?: Promise<void>;

  constructor(options: PostgresMembershipOptions) {
    if (!options || !validConnection(options.connectionString, options.ssl) || !validIssuer(options.issuer) ||
        !positiveInteger(options.maxConcurrentLookups, 256) || !positiveInteger(options.lookupTimeoutMs, 30_000)) {
      throw new InvocationError("invalid_membership_configuration");
    }
    this.issuer = options.issuer;
    this.capacity = options.maxConcurrentLookups;
    this.timeoutMs = options.lookupTimeoutMs;
    this.pool = new Pool({ connectionString: options.connectionString, ssl: typeof options.ssl === "object" ? { ...options.ssl } : options.ssl,
      max: this.capacity, connectionTimeoutMillis: this.timeoutMs, statement_timeout: this.timeoutMs,
      options: "-c default_transaction_read_only=on", application_name: "websearch-membership" });
    // The next lookup reports unavailability; idle errors must not crash the process or expose credentials.
    this.pool.on("error", () => {});
  }

  /** Read-only, uncached lookup; this bound callback can be passed directly to the JWT adapter. */
  readonly resolveMembership = async (subject: string, workspace: string, input: MembershipLookupInput): Promise<WorkspaceMembership | null> => {
    if (this.closed) throw new InvocationError("authorization_unavailable");
    if (input?.issuer !== this.issuer) throw new InvocationError("authorization_unavailable");
    const request = Object.freeze({ workspaceId: input?.workspaceId, requestId: input?.requestId, deadlineAt: input?.deadlineAt, signal: input?.signal });
    if (!identifier(subject) || !identifier(workspace) || request.workspaceId !== workspace || !identifier(request.requestId) ||
        !Number.isFinite(request.deadlineAt) || !(request.signal instanceof AbortSignal)) throw new InvocationError("invalid_context");
    const expiresAt = Math.min(request.deadlineAt, Date.now() + this.timeoutMs);
    let timedOut = false;
    const check = () => {
      if (request.signal.aborted) throw new InvocationError("cancelled");
      if (request.deadlineAt <= Date.now()) throw new InvocationError("deadline_exceeded");
      if (timedOut || expiresAt <= Date.now()) throw new InvocationError("membership_timeout");
      if (this.closed) throw new InvocationError("authorization_unavailable");
    };
    check();
    if (this.active >= this.capacity) throw new InvocationError("membership_capacity_exceeded");
    this.active++;
    let client: PoolClient | undefined;
    let released = false;
    const release = (destroy: boolean) => { if (client && !released) { released = true; client.release(destroy); } };
    const abort = () => release(true);
    request.signal.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(() => { timedOut = true; abort(); }, Math.max(1, expiresAt - Date.now()));
    timer.unref();
    let healthy = false;
    try {
      // Pending connection acquisition retains capacity until its bounded driver operation settles.
      client = await this.pool.connect(); check();
      const result = await client.query({ text: `SELECT m.principal_id, w.tenant_id, m.workspace_id, m.permissions
        FROM mcp_identity.workspace_memberships m
        JOIN mcp_identity.workspaces w ON w.workspace_id = m.workspace_id
        WHERE m.issuer = $1 AND m.principal_id = $2 AND m.workspace_id = $3
          AND m.revoked_at IS NULL AND w.disabled_at IS NULL`, values: [this.issuer, subject, workspace] });
      check();
      if (result.rows.length > 1) throw new InvocationError("authorization_unavailable");
      const row = result.rows[0];
      if (row && (row.principal_id !== subject || row.workspace_id !== workspace || !identifier(row.tenant_id) ||
          !Array.isArray(row.permissions) || row.permissions.length > PERMISSIONS.length ||
          !row.permissions.every((permission: unknown) => PERMISSIONS.some(allowed => allowed === permission)))) throw new InvocationError("authorization_unavailable");
      healthy = true;
      return row ? Object.freeze({ principalId: subject, tenantId: row.tenant_id, workspaceId: workspace,
        permissions: Object.freeze([...row.permissions]) }) : null;
    } catch (error) {
      check();
      if (error instanceof InvocationError) throw error;
      throw new InvocationError("authorization_unavailable");
    } finally {
      clearTimeout(timer); request.signal.removeEventListener("abort", abort);
      release(!healthy); this.active--;
    }
  };

  close(): Promise<void> {
    this.closed = true;
    return this.closing ??= this.pool.end();
  }
}

function identifier(value: unknown): value is string { return typeof value === "string" && value.trim().length > 0 && value.length <= 256; }
function positiveInteger(value: number, max: number): boolean { return Number.isSafeInteger(value) && value > 0 && value <= max; }
function validIssuer(value: string): boolean {
  try { const url = new URL(value); return value.trim() === value && value.length <= 2048 && url.protocol === "https:" && !url.username && !url.password && !url.search && !url.hash; }
  catch { return false; }
}
function validConnection(value: string, ssl: PostgresMembershipOptions["ssl"]): boolean {
  try {
    const url = new URL(value);
    if (!["postgres:", "postgresql:"].includes(url.protocol) || !url.hostname || !url.username || url.pathname.length <= 1 || url.search || url.hash) return false;
    if (ssl !== undefined && typeof ssl !== "boolean" && typeof ssl !== "object") return false;
    if (typeof ssl === "object" && (!ssl || ssl.rejectUnauthorized === false)) return false;
    const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
    return loopback || ssl === true || (typeof ssl === "object" && ssl !== null);
  } catch { return false; }
}
