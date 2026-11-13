import type { SearchResultItem } from "../cache/types.js";

export type RerankScorer = (query: string, texts: string[]) => Promise<number[]>;

export type RerankOptions = {
  scorer: RerankScorer;
  limit?: number;
};

type PipelinePair = { text: string; text_pair: string };

type PipelineResult = {
  /** Pre-computed relevance scores, one per pair. */
  scores?: number[];
  /** Logits per pair: logits[pairIndex][logitIndex]. */
  logits?: number[][];
  /** Single-pair convenience shape from HF text-classification. */
  score?: number;
};

type CrossEncoderPipeline = (pairs: PipelinePair[]) => Promise<PipelineResult | PipelineResult[]>;

export type CrossEncoderRerankerOptions = {
  modelName?: string;
  loadPipeline?: (task: string, model: string) => Promise<CrossEncoderPipeline>;
};

function toText(result: SearchResultItem): string {
  return `${result.title} ${result.snippet}`.trim();
}

/**
 * Reorder search results with a query-document scorer (cross-encoder style).
 * Falls back to the original order if scoring fails.
 */
export async function rerankResults(
  query: string,
  results: SearchResultItem[],
  options: RerankOptions,
): Promise<SearchResultItem[]> {
  if (results.length === 0) return [];

  const texts = results.map(toText);
  let scores: number[];
  try {
    scores = await options.scorer(query, texts);
    if (scores.length !== results.length) {
      throw new Error(`scorer returned ${scores.length} scores for ${results.length} results`);
    }
  } catch (error) {
    console.error("Rerank failed, keeping original order:", error);
    return [...results];
  }

  const scored = results.map((result, index) => ({
    result: {
      ...result,
      semanticScore: scores[index],
    },
    score: scores[index],
  }));

  scored.sort((a, b) => b.score - a.score);
  const limit = options.limit ?? results.length;
  return scored.slice(0, limit).map((entry) => entry.result);
}

/**
 * Local cross-encoder scorer using Transformers.js when available.
 * Designed as an opt-in upgrade over embedding similarity reranking.
 */
export class CrossEncoderReranker {
  private pipeline: CrossEncoderPipeline | null = null;
  private loadFailed = false;
  private loadPromise: Promise<CrossEncoderPipeline | null> | null = null;
  private readonly modelName: string;
  private readonly loadPipeline: (task: string, model: string) => Promise<CrossEncoderPipeline>;

  constructor(options?: CrossEncoderRerankerOptions) {
    this.modelName = options?.modelName ?? "Xenova/ms-marco-MiniLM-L-6-v2";
    this.loadPipeline =
      options?.loadPipeline ??
      (async (task: string, model: string) => {
        const { pipeline } = await import("@huggingface/transformers");
        return pipeline(task as never, model) as unknown as CrossEncoderPipeline;
      });
  }

  isAvailable(): boolean {
    return this.pipeline !== null && !this.loadFailed;
  }

  private async getPipeline(): Promise<CrossEncoderPipeline | null> {
    if (this.loadFailed) return null;
    if (this.pipeline) return this.pipeline;

    if (!this.loadPromise) {
      this.loadPromise = this.loadPipeline("text-classification", this.modelName)
        .then((loaded) => {
          this.pipeline = loaded;
          return loaded;
        })
        .catch((error) => {
          this.loadFailed = true;
          console.error("Cross-encoder model permanently failed:", error);
          return null;
        })
        .finally(() => {
          this.loadPromise = null;
        });
    }

    return this.loadPromise;
  }

  /** Returns one score per text. Missing model yields zeros. */
  async score(query: string, texts: string[]): Promise<number[]> {
    if (texts.length === 0) return [];

    const runner = await this.getPipeline();
    if (!runner) return texts.map(() => 0);

    try {
      const pairs = texts.map((text) => ({ text: query, text_pair: text }));
      const output = await runner(pairs);
      return normalizePipelineScores(output, texts.length);
    } catch (error) {
      console.error("Cross-encoder scoring failed:", error);
      return texts.map(() => 0);
    }
  }

  asScorer(): RerankScorer {
    return (query, texts) => this.score(query, texts);
  }
}

export function normalizePipelineScores(output: PipelineResult | PipelineResult[], expected: number): number[] {
  const entries = Array.isArray(output) ? output : [output];

  // Shape A: one entry carrying an explicit scores array.
  if (entries.length === 1 && Array.isArray(entries[0].scores)) {
    return padScores(entries[0].scores!, expected);
  }

  // Shape B: one entry carrying logits[pairIndex][logitIndex].
  if (entries.length === 1 && Array.isArray(entries[0].logits) && entries[0].logits!.length >= expected) {
    return entries[0].logits!.slice(0, expected).map((logits) => Math.max(...logits));
  }

  // Shape C: one entry per pair, each with a score or single-pair logits.
  return padScores(
    entries.map((entry) => {
      if (typeof entry.score === "number") return entry.score;
      if (Array.isArray(entry.logits) && entry.logits[0]) return Math.max(...entry.logits[0]);
      return 0;
    }),
    expected,
  );
}

function padScores(scores: number[], expected: number): number[] {
  if (scores.length === expected) return scores;
  if (scores.length > expected) return scores.slice(0, expected);
  return [...scores, ...Array.from({ length: expected - scores.length }, () => 0)];
}
