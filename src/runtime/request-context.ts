import { randomUUID } from "node:crypto";

export const PERMISSIONS = [
  "search:read", "content:read", "knowledge:read", "knowledge:write",
  "memory:read", "memory:write", "status:read", "cache:manage",
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
  /** Optional server-owned live trust lease; never serialized into request data. */
  isCurrent?: () => boolean;
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
  revalidateMembership?: (context: RequestContext) => Promise<boolean>;
};

// Runtime provenance prevents a cast, copied object, or caller payload from becoming a trusted context.
const issuedContexts = new WeakMap<RequestContext, Readonly<{ expiresAt: number; isCurrent?: () => boolean }>>();
const membershipCheckpoints = new WeakMap<RequestContext, { check: (context: RequestContext) => Promise<boolean>; failure?: string; pending?: Promise<void> }>();
const nonblank = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;
const stringList = (value: unknown): value is readonly string[] => Array.isArray(value) && value.every(nonblank);

function issue(context: RequestContext, authorizationExpiresAt: number, isCurrent?: () => boolean): RequestContext {
  if (!nonblank(context.requestId) || !Number.isFinite(context.deadlineAt) || !(context.signal instanceof AbortSignal)) {
    throw new InvocationError("invalid_context");
  }
  const snapshot = Object.freeze({ ...context, permissions: Object.freeze([...context.permissions]) });
  issuedContexts.set(snapshot, Object.freeze({ expiresAt: authorizationExpiresAt, isCurrent }));
  return snapshot;
}

export function createHostedRequestContext(input: HostedContextInput): RequestContext {
  const auth = input.authorization;
  if (!auth || !nonblank(auth.subject) || !nonblank(input.expectedAudience) ||
      !stringList(auth.audiences) || !auth.audiences.includes(input.expectedAudience) ||
      !Number.isFinite(auth.expiresAt) || auth.expiresAt <= Date.now() || !stringList(auth.scopes)) {
    throw new InvocationError("unauthenticated");
  }
  assertCurrentAuthorization(auth.isCurrent);
  const membership = input.membership;
  if (!membership || membership.principalId !== auth.subject || !nonblank(membership.tenantId) ||
      !nonblank(membership.workspaceId) || !stringList(membership.permissions)) {
    throw new InvocationError("forbidden");
  }
  const permissions = PERMISSIONS.filter((permission) =>
    auth.scopes.includes(permission) && membership.permissions.includes(permission));
  const context = issue({
    mode: "hosted", principalId: auth.subject, tenantId: membership.tenantId, workspaceId: membership.workspaceId,
    permissions, requestId: input.requestId, deadlineAt: input.deadlineAt, signal: input.signal,
  }, auth.expiresAt, auth.isCurrent);
  if (input.revalidateMembership !== undefined) {
    if (typeof input.revalidateMembership !== "function") throw new InvocationError("invalid_context");
    membershipCheckpoints.set(context, { check: input.revalidateMembership });
  }
  return context;
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
  const failure = membershipCheckpoints.get(context)?.failure;
  if (failure) throw new InvocationError(failure);
  if (context.mode === "hosted") {
    const authorization = issuedContexts.get(context)!;
    if (authorization.expiresAt <= Date.now()) throw new InvocationError("unauthenticated");
    assertCurrentAuthorization(authorization.isCurrent);
  }
  if (context.signal.aborted) throw new InvocationError("cancelled");
  if (context.deadlineAt <= Date.now()) throw new InvocationError("deadline_exceeded");
}

/** Revalidate before protected effects after waits; no synchronous database calls. */
export async function assertRequestAuthorization(input: RequestContext): Promise<void> {
  assertRequestContext(input);
  const checkpoint = membershipCheckpoints.get(input);
  if (!checkpoint) return;
  if (!checkpoint.pending) {
    checkpoint.pending = Promise.resolve().then(async () => {
      let current: boolean;
      try { current = await checkpoint.check(input); }
      catch {
        assertRequestContext(input);
        checkpoint.failure = "authorization_unavailable";
        throw new InvocationError(checkpoint.failure);
      }
      assertRequestContext(input);
      if (current !== true) {
        checkpoint.failure = "forbidden";
        throw new InvocationError(checkpoint.failure);
      }
    }).finally(() => { checkpoint.pending = undefined; });
  }
  await checkpoint.pending;
  assertRequestContext(input);
}

function assertCurrentAuthorization(isCurrent: unknown): void {
  if (isCurrent === undefined) return;
  try {
    if (typeof isCurrent !== "function" || isCurrent() !== true) throw new InvocationError("unauthenticated");
  } catch { throw new InvocationError("unauthenticated"); }
}
