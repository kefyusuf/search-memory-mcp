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
/**
 * Generic per-scope LRU cache used by the hosted server for context-bound
 * resources that are too expensive to open per request (search caches,
 * content fetchers). Same safety argument as TenantStoreCache: eviction runs
 * inside get(), so an entry cannot be closed while its getter's caller runs.
 */
export class ScopeCache<T> {
  private readonly entries = new Map<string, T>();
  private readonly maxEntries: number;

  constructor(options: { maxEntries: number; onClose?: (item: T) => void }) {
    if (!Number.isSafeInteger(options.maxEntries) || options.maxEntries <= 0) throw new InvocationError("invalid_scope_cache");
    this.maxEntries = options.maxEntries;
    this.onClose = options.onClose ?? (() => {});
  }

  private readonly onClose: (item: T) => void;

  get size(): number {
    return this.entries.size;
  }

  get(key: string, factory: () => T): T {
    const existing = this.entries.get(key);
    if (existing) {
      this.entries.delete(key);
      this.entries.set(key, existing);
      return existing;
    }
    const item = factory();
    this.entries.set(key, item);
    while (this.entries.size > this.maxEntries) {
      const oldestKey = this.entries.keys().next().value;
      if (oldestKey === undefined) break;
      const oldest = this.entries.get(oldestKey);
      this.entries.delete(oldestKey);
      try { this.onClose(oldest as T); } catch { /* already closed */ }
    }
    return item;
  }

  closeAll(): void {
    for (const item of this.entries.values()) {
      try { this.onClose(item); } catch { /* already closed */ }
    }
    this.entries.clear();
  }
}

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
