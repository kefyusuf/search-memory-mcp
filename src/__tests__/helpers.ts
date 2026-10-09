import { IVectorStore, VectorMatch, CacheMetadata, ContentEntry } from "../cache/types.js";
import { cosineSimilarity } from "../cache/utils.js";

export class InMemoryVectorStore implements IVectorStore {
  private store: Map<string, { vector: number[]; metadata: CacheMetadata }> = new Map();
  private contentStore: Map<string, { content: string; category: string; timestamp: number; publishedAt: string | null }> = new Map();

  async add(id: string, vector: number[], metadata: CacheMetadata): Promise<void> {
    this.store.set(id, { vector, metadata });
  }

  async search(vector: number[], limit: number, namespace?: string): Promise<VectorMatch[]> {
    const results: VectorMatch[] = [];

    for (const [id, entry] of this.store.entries()) {
      if (namespace !== undefined && (entry.metadata.namespace ?? "fallback") !== namespace) continue;
      const score = cosineSimilarity(vector, entry.vector);
      results.push({ id, score, metadata: entry.metadata });
    }

    return results
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }

  async clear(): Promise<void> {
    this.store.clear();
    this.contentStore.clear();
  }

  getStats(): { contentCount: number; vectorCount: number } {
    return {
      contentCount: this.contentStore.size,
      vectorCount: this.store.size,
    };
  }

  close(): void {
  }

  async getContent(url: string): Promise<ContentEntry | null> {
    const entry = this.contentStore.get(url);
    if (!entry) return null;
    return { url, ...entry };
  }

  async setContent(url: string, content: string, category: string, publishedAt?: string): Promise<void> {
    this.contentStore.set(url, { content, category, timestamp: Date.now(), publishedAt: publishedAt ?? null });
  }

  deleteExpiredContent(maxAgeMs: number): number {
    const cutoff = Date.now() - maxAgeMs;
    let deleted = 0;

    for (const [url, entry] of this.contentStore.entries()) {
      if (entry.timestamp < cutoff) {
        this.contentStore.delete(url);
        deleted++;
      }
    }

    return deleted;
  }
}
