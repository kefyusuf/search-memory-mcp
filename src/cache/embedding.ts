import { pipeline } from "@huggingface/transformers";
import { IEmbeddingProvider } from "./types.js";

export class TransformersEmbeddingProvider implements IEmbeddingProvider {
  private extractorLoading: Promise<any> | null = null;
  private extractorFailed = false;
  private modelName: string;

  constructor(modelName: string = "Xenova/paraphrase-multilingual-MiniLM-L12-v2") {
    this.modelName = modelName;
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

  async getEmbedding(text: string): Promise<number[]> {
    const extractor = await this.getExtractor();
    if (!extractor || this.extractorFailed) return [];
    const truncated = text.slice(0, 512);
    const output = await extractor(truncated, { pooling: "mean", normalize: true });
    return Array.from(output.data);
  }

  isAvailable(): boolean {
    return !this.extractorFailed;
  }
}
