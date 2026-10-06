import { pipeline } from "@huggingface/transformers";
import { IEmbeddingProvider } from "./types.js";
import { InvocationError } from "../runtime/request-context.js";

export class TransformersEmbeddingProvider implements IEmbeddingProvider {
  private extractorLoading: Promise<any> | null = null;
  private extractorFailed = false;
  private modelName: string;
  private readonly maxConcurrentInferences: number;
  private readonly maxQueuedInferences: number;
  private activeInferences = 0;
  private readonly inferenceWaiters: Array<() => void> = [];

  constructor(modelName: string = "Xenova/paraphrase-multilingual-MiniLM-L12-v2", options: { maxConcurrentInferences?: number; maxQueuedInferences?: number } = {}) {
    this.modelName = modelName;
    this.maxConcurrentInferences = options.maxConcurrentInferences ?? 1;
    this.maxQueuedInferences = options.maxQueuedInferences ?? 32;
    if (!Number.isSafeInteger(this.maxConcurrentInferences) || this.maxConcurrentInferences <= 0 ||
        !Number.isSafeInteger(this.maxQueuedInferences) || this.maxQueuedInferences < 0) {
      throw new InvocationError("invalid_embedding_capacity");
    }
  }

  private async getExtractor() {
    if (this.extractorFailed) return null;

    if (!this.extractorLoading) {
      // Publish the promise before starting the loader so concurrent callers share it.
      this.extractorLoading = Promise.resolve()
        .then(() => pipeline("feature-extraction", this.modelName))
        .catch((e) => {
          this.extractorFailed = true;
          console.error("Embedding model permanently failed:", e);
          return null;
        });
    }
    return this.extractorLoading;
  }

  private acquireInference(): Promise<void> {
    if (this.activeInferences < this.maxConcurrentInferences) {
      this.activeInferences++;
      return Promise.resolve();
    }
    if (this.inferenceWaiters.length >= this.maxQueuedInferences) {
      return Promise.reject(new InvocationError("embedding_capacity_exceeded"));
    }
    return new Promise(resolve => { this.inferenceWaiters.push(resolve); });
  }

  private releaseInference(): void {
    const next = this.inferenceWaiters.shift();
    if (next) next(); // Transfer the occupied slot; new arrivals cannot jump the FIFO queue.
    else this.activeInferences--;
  }

  getEmbedding(text: string): Promise<number[]> {
    // Retain only the existing bounded model input while waiting for admission.
    return this.embedTruncated(text.slice(0, 512));
  }

  private async embedTruncated(text: string): Promise<number[]> {
    await this.acquireInference();
    try {
      const extractor = await this.getExtractor();
      if (!extractor || this.extractorFailed) return [];
      const output = await extractor(text, { pooling: "mean", normalize: true });
      return Array.from(output.data);
    } finally { this.releaseInference(); }
  }

  isAvailable(): boolean {
    return !this.extractorFailed;
  }
}
