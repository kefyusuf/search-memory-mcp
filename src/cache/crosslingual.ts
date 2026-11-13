import { pipeline } from "@huggingface/transformers";
import type { TranslationResult, ClassificationResult } from "./types.js";

const OPUS_MT_REGISTRY: Record<string, string> = {
  tur_Latn: "Xenova/opus-mt-tr-en",
  fra_Latn: "Xenova/opus-mt-fr-en",
  deu_Latn: "Xenova/opus-mt-de-en",
  spa_Latn: "Xenova/opus-mt-es-en",
  por_Latn: "Xenova/opus-mt-pt-en",
  ita_Latn: "Xenova/opus-mt-it-en",
  nld_Latn: "Xenova/opus-mt-nl-en",
  rus_Cyrl: "Xenova/opus-mt-ru-en",
  zho_Hans: "Xenova/opus-mt-zh-en",
  jpn_Jpan: "Xenova/opus-mt-ja-en",
};

const LANG_DETECT_MODEL = "onnx-community/language_detection-ONNX";

class TranslationProvider {
  private models = new Map<string, (text: string) => Promise<unknown>>();
  private loadFailed = false;

  async translate(text: string, sourceLang: string): Promise<string> {
    const modelName = OPUS_MT_REGISTRY[sourceLang];
    if (!modelName) return text;

    if (this.loadFailed) return text;

    let model = this.models.get(modelName);
    if (!model) {
      try {
        model = await pipeline("translation", modelName);
        this.models.set(modelName, model);
        console.error(`Translation model loaded: ${modelName}`);
      } catch (e) {
        this.loadFailed = true;
        console.error("Translation model permanently failed:", e);
        return text;
      }
    }
    const [result] = (await model(text)) as TranslationResult[];
    return result.translation_text;
  }
}

export class CrossLingualEngine {
  private langDetector: ((text: string) => Promise<unknown>) | null = null;
  private langDetectFailed = false;
  private translator: TranslationProvider;

  constructor() {
    this.translator = new TranslationProvider();
  }

  private async getLangDetector() {
    if (this.langDetectFailed) return null;

    if (!this.langDetector) {
      try {
        this.langDetector = await pipeline("text-classification", LANG_DETECT_MODEL);
        console.error("Language detection model loaded.");
      } catch (e) {
        this.langDetectFailed = true;
        console.error("Language detection model permanently failed:", e);
        return null;
      }
    }
    return this.langDetector;
  }

  async detectLanguage(text: string): Promise<string> {
    try {
      const detector = await this.getLangDetector();
      if (!detector) return "eng_Latn";
      const [result] = (await detector(text)) as ClassificationResult[];
      return result.label;
    } catch (error) {
      console.error("Language detection error:", error);
      return "eng_Latn";
    }
  }

  shouldCrossSearch(intent: string, lang: string): boolean {
    const isEnglish = lang?.startsWith("eng_");
    if (isEnglish) return false;
    return intent === "technical" || intent === "general";
  }

  async translateToEnglish(text: string, lang: string): Promise<string> {
    return this.translator.translate(text, lang);
  }
}
