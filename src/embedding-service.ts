import { pipeline } from "@huggingface/transformers";

export class EmbeddingService {
  private extractor: any;

  async initialize() {
    this.extractor = await pipeline(
      "feature-extraction",
      "Xenova/all-MiniLM-L6-v2",
    );
  }

  async embed(text: string): Promise<number[]> {
    if (!this.extractor) {
      await this.initialize();
    }

    const output = await this.extractor(text, {
      pooling: "mean",
      normalize: true,
    });

    return Array.from(output.data);
  }
}
