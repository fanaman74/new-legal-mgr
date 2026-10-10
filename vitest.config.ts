import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    testTimeout: 120_000,
    hookTimeout: 300_000,
    // Integration tests write to per-test temporary directories, but OCR workers are heavy;
    // run files sequentially to keep memory predictable.
    fileParallelism: false,
  },
});
