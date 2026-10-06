import { randomUUID } from "node:crypto";

export const PERMISSIONS = [
  "search:read", "content:read", "knowledge:read", "knowledge:write",
  "memory:read", "memory:write", "status:read",
] as const;
export type Permission = typeof PERMISSIONS[number];
export type ExecutionMode = "local" | "hosted";
export type RequestContext = Readonly<{
  mode: ExecutionMode;
  principalId: string;
  tenantId: string;
  workspaceId: string;
  permissions: readonly Permission[];
  requestId: string;
  deadlineAt: number;
  signal: AbortSignal;
}>;

export class InvocationError extends Error {
  constructor(readonly code: string) { super(code); this.name = "InvocationError"; }
}

/** Server-side outputs only: token signature/issuer verification is the auth adapter's responsibility. */
export type VerifiedAuthorization = {
  subject: string;
  audiences: readonly string[];
  expiresAt: number;
  scopes: readonly string[];
};
/** Must come from a trusted membership resolver, never tool arguments or JWT workspace claims alone. */
export type WorkspaceMembership = {
  principalId: string;
  tenantId: string;
  workspaceId: string;
  permissions: readonly string[];
};
export type HostedContextInput = {
  authorization: VerifiedAuthorization | null;
  membership: WorkspaceMembership | null;
  expectedAudience: string;
  requestId: string;
  deadlineAt: number;
  signal: AbortSignal;
};

// Runtime provenance prevents a cast, copied object, or caller payload from becoming a trusted context.
const issuedContexts = new WeakMap<RequestContext, number>();
const nonblank = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;
const stringList = (value: unknown): value is readonly string[] => Array.isArray(value) && value.every(nonblank);

function issue(context: RequestContext, authorizationExpiresAt: number): RequestContext {
  if (!nonblank(context.requestId) || !Number.isFinite(context.deadlineAt) || !(context.signal instanceof AbortSignal)) {
    throw new InvocationError("invalid_context");
  }
  const snapshot = Object.freeze({ ...context, permissions: Object.freeze([...context.permissions]) });
  issuedContexts.set(snapshot, authorizationExpiresAt);
  return snapshot;
}

export function createHostedRequestContext(input: HostedContextInput): RequestContext {
  const auth = input.authorization;
  if (!auth || !nonblank(auth.subject) || !nonblank(input.expectedAudience) ||
      !stringList(auth.audiences) || !auth.audiences.includes(input.expectedAudience) ||
      !Number.isFinite(auth.expiresAt) || auth.expiresAt <= Date.now() || !stringList(auth.scopes)) {
    throw new InvocationError("unauthenticated");
  }
  const membership = input.membership;
  if (!membership || membership.principalId !== auth.subject || !nonblank(membership.tenantId) ||
      !nonblank(membership.workspaceId) || !stringList(membership.permissions)) {
    throw new InvocationError("forbidden");
  }
  const permissions = PERMISSIONS.filter((permission) =>
    auth.scopes.includes(permission) && membership.permissions.includes(permission));
  return issue({
    mode: "hosted", principalId: auth.subject, tenantId: membership.tenantId, workspaceId: membership.workspaceId,
    permissions, requestId: input.requestId, deadlineAt: input.deadlineAt, signal: input.signal,
  }, auth.expiresAt);
}

/** Only the trusted local stdio adapter should call this; hosted adapters must never use it as fallback. */
export function createLocalRequestContext(input: { requestId?: string; deadlineAt?: number; signal?: AbortSignal } = {}): RequestContext {
  return issue({
    mode: "local", principalId: "local", tenantId: "local", workspaceId: "local", permissions: PERMISSIONS,
    requestId: input.requestId ?? randomUUID(), deadlineAt: input.deadlineAt ?? Date.now() + 60_000,
    signal: input.signal ?? new AbortController().signal,
  }, Number.MAX_SAFE_INTEGER);
}

export function assertRequestContext(input: unknown): asserts input is RequestContext {
  if (!input || typeof input !== "object" || !issuedContexts.has(input as RequestContext)) {
    throw new InvocationError("invalid_context");
  }
  const context = input as RequestContext;
  if (context.mode === "hosted" && issuedContexts.get(context)! <= Date.now()) throw new InvocationError("unauthenticated");
  if (context.signal.aborted) throw new InvocationError("cancelled");
  if (context.deadlineAt <= Date.now()) throw new InvocationError("deadline_exceeded");
}
