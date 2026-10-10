import { readFileSync } from "node:fs";
import path from "node:path";
import type { AppConfig } from "../config.js";
import { REPO_ROOT } from "../config.js";
import { externalAllowed } from "../retrieval/embeddings.js";

/**
 * Optional generative layer (off by default). Supports a local Ollama server or any
 * OpenAI-compatible chat endpoint. A non-localhost endpoint is refused unless
 * ALLOW_EXTERNAL_LLM=true, because the request contains document text.
 * API keys and prompts are never logged.
 */

export const PROMPT_FILE = "legal-analysis-system.v1.md";

export interface LlmInfo {
  provider: string;
  model: string;
  prompt_version: string;
}

export function loadSystemPrompt(): { text: string; version: string } {
  const text = readFileSync(path.join(REPO_ROOT, "config", "prompts", PROMPT_FILE), "utf8");
  return { text, version: PROMPT_FILE.replace(/\.md$/, "") };
}

function isLocal(url: string): boolean {
  const host = new URL(url).hostname;
  return ["localhost", "127.0.0.1", "::1", "[::1]"].includes(host);
}

export function llmEnabled(cfg: AppConfig): boolean {
  return cfg.llm.provider !== "none";
}

/** Send a chat request expecting a JSON object back. */
export async function chatJson(cfg: AppConfig, system: string, user: string): Promise<{ json: unknown; info: LlmInfo }> {
  if (cfg.llm.provider === "none") throw new Error("LLM is disabled (llm.provider: none)");
  if (!isLocal(cfg.llm.url) && !externalAllowed()) {
    throw new Error(`Refusing to send document text to non-local LLM ${new URL(cfg.llm.url).host} (set ALLOW_EXTERNAL_LLM=true to allow).`);
  }
  const signal = AbortSignal.timeout(cfg.llm.timeoutSeconds * 1000);
  const base = cfg.llm.url.replace(/\/$/, "");
  let content: string;
  if (cfg.llm.provider === "ollama") {
    const res = await fetch(`${base}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: cfg.llm.model, stream: false, format: "json", options: { temperature: 0 }, messages: [{ role: "system", content: system }, { role: "user", content: user }] }),
      signal,
    });
    if (!res.ok) throw new Error(`LLM request failed: HTTP ${res.status}`);
    content = ((await res.json()) as { message?: { content?: string } }).message?.content ?? "";
  } else {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (cfg.llm.apiKey) headers.Authorization = `Bearer ${cfg.llm.apiKey}`;
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify({ model: cfg.llm.model, temperature: 0, response_format: { type: "json_object" }, messages: [{ role: "system", content: system }, { role: "user", content: user }] }),
      signal,
    });
    if (!res.ok) throw new Error(`LLM request failed: HTTP ${res.status}`);
    content = ((await res.json()) as { choices?: { message?: { content?: string } }[] }).choices?.[0]?.message?.content ?? "";
  }
  const match = content.match(/\{[\s\S]*\}/);
  if (!match) throw new Error("LLM did not return a JSON object");
  return { json: JSON.parse(match[0]) as unknown, info: { provider: cfg.llm.provider, model: cfg.llm.model, prompt_version: loadSystemPrompt().version } };
}
