import { existsSync } from "node:fs";
import path from "node:path";
import { createWorker, type Worker } from "tesseract.js";

/**
 * Local OCR via tesseract.js (WebAssembly). Language data is loaded from a local directory;
 * no document content leaves the machine.
 */
export class OcrEngine {
  private worker: Worker | null = null;

  constructor(private readonly opts: { langs: string; langPath: string }) {}

  private async getWorker(): Promise<Worker> {
    if (this.worker) return this.worker;
    for (const lang of this.opts.langs.split("+")) {
      const file = path.join(this.opts.langPath, `${lang}.traineddata.gz`);
      if (!existsSync(file) && !existsSync(file.replace(/\.gz$/, ""))) {
        throw new Error(`OCR language data not found: ${file}. Check ocr.lang_path / OCR_LANG_PATH.`);
      }
    }
    this.worker = await createWorker(this.opts.langs, 1, {
      langPath: this.opts.langPath,
      cacheMethod: "none",
      logger: () => undefined,
      errorHandler: () => undefined,
    });
    return this.worker;
  }

  async recognize(png: Uint8Array): Promise<{ text: string; confidence: number }> {
    const worker = await this.getWorker();
    const { data } = await worker.recognize(Buffer.from(png));
    return { text: data.text, confidence: data.confidence };
  }

  async close(): Promise<void> {
    if (this.worker) await this.worker.terminate();
    this.worker = null;
  }
}
