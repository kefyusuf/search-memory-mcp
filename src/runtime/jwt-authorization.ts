import { jwtVerify } from "jose";
import { assertRequestContext, createHostedRequestContext, InvocationError, type RequestContext, type VerifiedAuthorization, type WorkspaceMembership } from "./request-context.js";
import { JwtVerificationKeyRing, type JwtKeyLease, type JwtSignatureAlgorithm } from "./jwt-key-ring.js";

export type AuthenticatedRequestInput = { workspaceId: string; requestId: string; deadlineAt: number; signal: AbortSignal };
export type JwtAuthorizationOptions = {
  issuer: string; audience: string; algorithm: JwtSignatureAlgorithm; verificationKey: CryptoKey | JwtVerificationKeyRing;
  resolveMembership: (subject: string, workspaceId: string, request: AuthenticatedRequestInput) => Promise<WorkspaceMembership | null>;
};
export class JwtAuthorizationAdapter {
  private readonly options: Readonly<JwtAuthorizationOptions>;
  constructor(options: JwtAuthorizationOptions) {
    if (!options || !secureIdentifier(options.issuer) || !secureIdentifier(options.audience) ||
        !["RS256", "ES256", "EdDSA"].includes(options.algorithm) ||
        !((options.verificationKey instanceof CryptoKey && options.verificationKey.type === "public") ||
          (options.verificationKey instanceof JwtVerificationKeyRing && options.verificationKey.algorithm === options.algorithm)) ||
        typeof options.resolveMembership !== "function") throw new InvocationError("invalid_auth_configuration");
    this.options = Object.freeze({ ...options });
  }

  async authenticate(header: unknown, input: AuthenticatedRequestInput): Promise<RequestContext> {
    const request = Object.freeze({ workspaceId: input?.workspaceId, requestId: input?.requestId, deadlineAt: input?.deadlineAt, signal: input?.signal });
    assertRequestInput(request);
    if (typeof header !== "string" || header.length > 8192) throw new InvocationError("unauthenticated");
    const match = /^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/i.exec(header);
    if (!match) throw new InvocationError("unauthenticated");
    let authorization: VerifiedAuthorization;
    try {
      let lease: JwtKeyLease | undefined;
      const verificationKey = this.options.verificationKey;
      const { payload } = await jwtVerify(match[1], header => {
        if (verificationKey instanceof JwtVerificationKeyRing) {
          lease = verificationKey.select(header.kid); return lease.key;
        }
        return verificationKey;
      }, {
        issuer: this.options.issuer, audience: this.options.audience, algorithms: [this.options.algorithm],
        typ: "at+jwt", requiredClaims: ["sub", "exp"], clockTolerance: 0,
      });
      const expiresAt = payload.exp! * 1000;
      if ((lease && !lease.isCurrent()) || typeof payload.sub !== "string" || !payload.sub.trim() || !Number.isSafeInteger(expiresAt) ||
          (payload.scope !== undefined && (typeof payload.scope !== "string" || !SCOPE.test(payload.scope)))) {
        throw new InvocationError("unauthenticated");
      }
      authorization = { subject: payload.sub, audiences: typeof payload.aud === "string" ? [payload.aud] : payload.aud!, expiresAt,
        scopes: typeof payload.scope === "string" && payload.scope ? payload.scope.split(" ") : [], isCurrent: lease?.isCurrent };
    } catch { throw new InvocationError("unauthenticated"); }
    assertRequestInput(request);
    let membership: WorkspaceMembership | null;
    try { membership = await this.options.resolveMembership(authorization.subject, request.workspaceId, request); }
    catch { assertRequestInput(request); throw new InvocationError("authorization_unavailable"); }
    assertRequestInput(request);
    if (!membership || membership.workspaceId !== request.workspaceId) throw new InvocationError("forbidden");
    const context = createHostedRequestContext({ authorization, membership, expectedAudience: this.options.audience,
      requestId: request.requestId, deadlineAt: request.deadlineAt, signal: request.signal });
    assertRequestContext(context);
    return context;
  }
}

// OAuth scope-token characters exclude quotes, backslashes and control characters.
const SCOPE = /^(?:[\x21\x23-\x5B\x5D-\x7E]+(?: [\x21\x23-\x5B\x5D-\x7E]+)*)?$/;
function secureIdentifier(value: string): boolean {
  try {
    if (typeof value !== "string" || value.trim() !== value) return false;
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password && !url.search && !url.hash;
  } catch { return false; }
}
function assertRequestInput(request: AuthenticatedRequestInput): void {
  if (typeof request.workspaceId !== "string" || !request.workspaceId.trim() || typeof request.requestId !== "string" ||
      !request.requestId.trim() || !Number.isFinite(request.deadlineAt) || !(request.signal instanceof AbortSignal)) throw new InvocationError("invalid_context");
  if (request.signal.aborted) throw new InvocationError("cancelled");
  if (request.deadlineAt <= Date.now()) throw new InvocationError("deadline_exceeded");
}
