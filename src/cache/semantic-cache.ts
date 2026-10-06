import { IEmbeddingProvider, IVectorStore, SearchResultItem, CacheMetadata } from "./types.js";
import { SearchIntentDetector, type IntentDetector, type SearchIntent } from "../search/intent.js";
import { cosineSimilarity } from "./utils.js";
import { InvocationError } from "../runtime/request-context.js";

const TTL_MAP: Record<string, number> = {
  price: 15 * 60 * 1000,              // 15 minutes
  news: 1 * 60 * 60 * 1000,           // 1 Hour
  blog: 5 * 24 * 60 * 60 * 1000,     // 5 Days
  docs: 30 * 24 * 60 * 60 * 1000,    // 30 Days
  technical: 30 * 24 * 60 * 60 * 1000, // 30 Days
  social: 3 * 24 * 60 * 60 * 1000,   // 3 Days
  general: 7 * 24 * 60 * 60 * 1000,  // 7 Days
};

const SEMANTIC_RANK_WEIGHT = 0.7;
const FUSION_RANK_WEIGHT = 0.3;

export class SemanticCache {
  private embeddingProvider: IEmbeddingProvider;
  private vectorStore: IVectorStore;
  private intentDetector: IntentDetector;
  private threshold: number;

  constructor(
    embeddingProvider: IEmbeddingProvider,
    vectorStore: IVectorStore,
    threshold: number = 0.75,
    intentDetector: IntentDetector = new SearchIntentDetector(),
  ) {
    this.embeddingProvider = embeddingProvider;
    this.vectorStore = vectorStore;
    this.intentDetector = intentDetector;
    this.threshold = threshold;
  }

  async detectIntent(query: string): Promise<SearchIntent> {
    return (await this.intentDetector.detect(query)).intent;
  }

  close(): void {
    this.vectorStore.close();
  }

  private async getQueryVector(query: string): Promise<number[] | null> {
    this.vectorStore.assertAccess?.("search:read");
    const vector = await this.embeddingProvider.getEmbedding(query);
    this.vectorStore.assertAccess?.("search:read");
    if (vector.length === 0) return null;
    return vector;
  }

  // --- Semantic Search Cache ---

  async get(query: string, namespace?: string): Promise<SearchResultItem[] | null> {
    try {
      const vector = await this.getQueryVector(query);
      if (!vector) return null;

      const matches = await this.vectorStore.search(vector, 5, namespace);
      this.vectorStore.assertAccess?.("search:read");

      for (const match of matches) {
        if (match.score < this.threshold) continue;
        const matchNamespace = match.metadata.namespace ?? "fallback";
        if (namespace && matchNamespace !== namespace) continue;

        // Check TTL: cached search results expire after 1 hour
        const age = Date.now() - match.metadata.timestamp;
        if (age > 60 * 60 * 1000) {
          console.error(`Cache expired (age: ${Math.round(age / 1000 / 60)}m)`);
          continue;
        }
        console.error(`Cache Hit! Similarity: ${match.score.toFixed(4)} namespace: ${matchNamespace}`);
        return match.metadata.results;
      }
    } catch (error) {
      if (error instanceof InvocationError) throw error;
      this.vectorStore.assertAccess?.("search:read");
      console.error("Cache lookup error:", error);
    }
    return null;
  }

  async set(query: string, results: SearchResultItem[], namespace?: string): Promise<void> {
    try {
      const vector = await this.getQueryVector(query);
      if (!vector) return;

      const ns = namespace ?? "fallback";
      const normalized = `${ns}|${query.trim().toLowerCase()}`;
      const id = Buffer.from(normalized).toString("base64");
      const metadata: CacheMetadata = {
        query,
        results,
        timestamp: Date.now(),
        namespace: ns,
      };
      await this.vectorStore.add(id, vector, metadata);
    } catch (error) {
      if (error instanceof InvocationError) throw error;
      this.vectorStore.assertAccess?.("search:read");
      console.error("Cache set error:", error);
    }
  }

  async clearSearchCache(): Promise<void> {
    try {
      this.vectorStore.assertAccess?.("cache:manage");
      await this.vectorStore.clear();
      console.error("Search cache cleared.");
    } catch (error) {
      if (error instanceof InvocationError) throw error;
      this.vectorStore.assertAccess?.("cache:manage");
      console.error("Clear cache error:", error);
    }
  }

  getCacheStats(): { contentCount: number; vectorCount: number } {
    return this.vectorStore.getStats();
  }

  deleteExpiredContent(): number {
    // Use 30 days as the max possible TTL (docs/technical category)
    const MAX_TTL_MS = 30 * 24 * 60 * 60 * 1000;
    return this.vectorStore.deleteExpiredContent(MAX_TTL_MS);
  }

  // --- Full Content Cache with TTL ---

  private intentToContentCategory(intent: SearchIntent): string {
    if (intent === "news") return "news";
    if (intent === "technical") return "technical";
    return "general";
  }

  async getCachedContent(url: string): Promise<string | null> {
    this.vectorStore.assertAccess?.("content:read");
    const entry = await this.vectorStore.getContent(url);
    this.vectorStore.assertAccess?.("content:read");
    if (!entry) return null;

    const ttl = TTL_MAP[entry.category] || TTL_MAP.general;
    const isExpired = Date.now() - entry.timestamp > ttl;

    if (isExpired) {
      console.error(`Cache expired for ${url} (Category: ${entry.category})`);
      return null;
    }

    console.error(`Content Cache Hit for ${url}`);
    return entry.content;
  }

  async setCachedContent(url: string, content: string, title: string, intent?: SearchIntent): Promise<void> {
    const category = intent
      ? this.intentToContentCategory(intent)
      : this.detectCategory(url, title);
    await this.vectorStore.setContent(url, content, category);
  }

  private detectCategory(url: string, title: string): string {
    const combined = (url + " " + title).toLowerCase();

    if (/\b(docs|wiki|tutorial|learn|documentation|guide|stackoverflow|api)\b/.test(combined)) return "docs";
    if (/\b(news|haber|breaking|daily|journal|gazete)\b/.test(combined)) return "news";
    if (/\b(reddit|forum|community|discord)\b/.test(combined)) return "social";
    if (/\b(blog|article|medium\.com|substack)\b/.test(combined)) return "blog";

    return "general";
  }

  // --- Semantic Re-ranking ---

  async reRankResults(query: string, results: SearchResultItem[], limit: number = 5): Promise<SearchResultItem[]> {
    if (results.length === 0) return results;

    const queryVector = await this.getQueryVector(query);
    if (!queryVector) return results;

    try {
      const semanticallyScored = await Promise.all(
        results.map(async (res) => {
          const text = `${res.title} ${res.snippet}`;
          const resVector = await this.embeddingProvider.getEmbedding(text);
          if (resVector.length === 0) return { ...res, semanticScore: 0 };
          const score = cosineSimilarity(queryVector, resVector);
          return { ...res, semanticScore: score };
        })
      );

      const maxFusionScore = semanticallyScored.reduce(
        (max, result) => Math.max(max, result.fusionScore ?? 0),
        0
      );

      const rankedResults = semanticallyScored.map((result) => {
        const normalizedFusionScore = maxFusionScore > 0
          ? (result.fusionScore ?? 0) / maxFusionScore
          : 0;
        const rankingScore = maxFusionScore > 0
          ? result.semanticScore * SEMANTIC_RANK_WEIGHT + normalizedFusionScore * FUSION_RANK_WEIGHT
          : result.semanticScore;
        return { ...result, rankingScore };
      });

      rankedResults.sort((a, b) => b.rankingScore - a.rankingScore);
      this.vectorStore.assertAccess?.("search:read");
      return rankedResults.slice(0, limit).map(({ rankingScore: _rankingScore, ...result }) => result);
    } catch (error) {
      if (error instanceof InvocationError) throw error;
      this.vectorStore.assertAccess?.("search:read");
      console.error("Re-ranking error:", error);
      return results.slice(0, limit);
    }
  }
}
