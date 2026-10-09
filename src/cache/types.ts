import type { Permission } from "../runtime/request-context.js";

export interface TranslationResult {
  translation_text: string;
}

export interface ClassificationResult {
  label: string;
  score: number;
}

export interface SearchResultItem {
  title: string;
  url: string;
  snippet: string;
  source: string;
  sources?: string[];
  providerRanks?: Record<string, number>;
  fusionScore?: number;
  semanticScore?: number;
}

export interface CacheMetadata {
  query: string;
  results: SearchResultItem[];
  timestamp: number;
  /** Execution namespace (strategy + plan fingerprint) so different strategies do not share hits. */
  namespace?: string;
  /** How long the entry stays valid; older entries without it use DEFAULT_SEARCH_CACHE_TTL_MS. */
  ttlMs?: number;
}

export interface IEmbeddingProvider {
  getEmbedding(text: string): Promise<number[]>;
  isAvailable(): boolean;
}

export interface VectorMatch {
  id: string;
  score: number;
  metadata: CacheMetadata;
}

export interface IVectorStore {
  /** Required for hosted adapters; optional only for legacy local implementations. */
  assertAccess?(permission: Permission): void;
  add(id: string, vector: number[], metadata: CacheMetadata): Promise<void>;
  search(vector: number[], limit: number, namespace?: string): Promise<VectorMatch[]>;
  clear(): Promise<void>;
  getStats(): { contentCount: number; vectorCount: number };
  close(): void;
  
  // Content Cache Methods
  getContent(url: string): Promise<ContentEntry | null>;
  setContent(url: string, content: string, category: string, publishedAt?: string): Promise<void>;
  deleteExpiredContent(maxAgeMs: number): number;
}

export interface ContentEntry {
  url: string;
  content: string;
  category: string;
  timestamp: number;
  /** Publication date (YYYY-MM-DD) found in the page, if any. */
  publishedAt?: string | null;
}

export interface CacheEntry {
  query: string;
  results: SearchResultItem[];
  timestamp: number;
}
