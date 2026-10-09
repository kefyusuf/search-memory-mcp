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
  /** How long a query waits for the model; undefined waits until it is loaded. */
  private readonly loadWaitMs?: number;
  private extractorReady = false;

  constructor(modelName: string = "Xenova/paraphrase-multilingual-MiniLM-L12-v2", options: { maxConcurrentInferences?: number; maxQueuedInferences?: number; loadWaitMs?: number } = {}) {
    this.modelName = modelName;
    // Loading takes seconds from disk and minutes on the first download. Queries made
    // meanwhile get no vector (keyword-only search) instead of waiting for it;
    // background work passes waitForModel to wait for the model instead.
    this.loadWaitMs = options.loadWaitMs;
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
        .then((extractor) => { this.extractorReady = true; return extractor; })
        .catch((e) => {
          this.extractorFailed = true;
          console.error("Embedding model permanently failed:", e);
          return null;
        });
    }
    return this.extractorLoading;
  }

  /** Starts loading (and on first run, downloading) the model in the background. */
  warmUp(): void {
    void this.getExtractor();
  }

  /** Resolves to the extractor, or null when it is not ready within loadWaitMs. */
  private async waitForExtractor() {
    const loading = this.getExtractor();
    if (this.extractorReady) return loading;
    if (!this.loadWaitMs) return null;
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), this.loadWaitMs); });
    try {
      return await Promise.race([loading, timeout]);
    } finally {
      clearTimeout(timer);
    }
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

  getEmbedding(text: string, options: { waitForModel?: boolean } = {}): Promise<number[]> {
    // Retain only the existing bounded model input while waiting for admission.
    return this.embedTruncated(text.slice(0, 512), options.waitForModel ?? false);
  }

  private async embedTruncated(text: string, waitForModel: boolean): Promise<number[]> {
    // A query that will not wait for the model returns before taking an inference slot.
    if (!waitForModel && this.loadWaitMs !== undefined && !(await this.waitForExtractor())) return [];
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
