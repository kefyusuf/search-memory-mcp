import { InvocationError, type RequestContext } from "../runtime/request-context.js";
import { SessionMemory } from "../memory/session-memory.js";

export type TenantStoreCacheOptions = {
  appDbPath: string;
  /** Maximum simultaneously open tenant stores; least-recently-used is closed. */
  maxStores?: number;
};

const DEFAULT_MAX_STORES = 64;

/**
 * Scope-keyed SessionMemory cache for the hosted server: one store instance
 * per (tenant, workspace), opened lazily against the shared application
 * database and closed on LRU eviction. Hosted mode only - local contexts are
 * rejected because the cache exists precisely to scope shared-file access.
 *
 * Safe by construction under Node's single thread: eviction runs inside
 * memoryFor, so a store cannot be closed while a handler is using it.
 */
export class TenantStoreCache {
  private readonly entries = new Map<string, SessionMemory>();
  private readonly maxStores: number;

  constructor(private readonly options: TenantStoreCacheOptions) {
    const max = options.maxStores ?? DEFAULT_MAX_STORES;
    if (!Number.isSafeInteger(max) || max <= 0) throw new InvocationError("invalid_tenant_store_cache");
    this.maxStores = max;
  }

  get size(): number {
    return this.entries.size;
  }

  memoryFor(context: RequestContext): SessionMemory {
    if (context.mode !== "hosted") throw new InvocationError("invalid_context");
    const key = `${context.tenantId}|${context.workspaceId}`;
    const existing = this.entries.get(key);
    if (existing) {
      // Refresh LRU position.
      this.entries.delete(key);
      this.entries.set(key, existing);
      return existing;
    }
    const store = new SessionMemory(this.options.appDbPath, { context });
    this.entries.set(key, store);
    this.evictOverflow();
    return store;
  }

  close(): void {
    for (const store of this.entries.values()) {
      try { store.close(); } catch { /* already closed */ }
    }
    this.entries.clear();
  }

  private evictOverflow(): void {
    while (this.entries.size > this.maxStores) {
      const oldestKey = this.entries.keys().next().value;
      if (oldestKey === undefined) break;
      const oldest = this.entries.get(oldestKey);
      this.entries.delete(oldestKey);
      try { oldest?.close(); } catch { /* already closed */ }
    }
  }
}
