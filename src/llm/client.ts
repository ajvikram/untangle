/**
 * Provider-agnostic LLM client with credential redaction.
 * §S4: all prompts pass through the redactor before sending.
 */

import { redactSensitive } from "./redactor.js";
import { logger } from "../util/logger.js";

export interface LlmResponse {
  text: string;
  inputTokens: number;
  outputTokens: number;
}

export interface LlmClient {
  chat(prompt: string, opts?: { model?: string; jsonMode?: boolean }): Promise<LlmResponse>;
}

/**
 * Anthropic SDK-backed LLM client.
 * Falls back to a mock when the SDK is unavailable or API key is missing.
 */
export class AnthropicLlmClient implements LlmClient {
  private sdk: unknown = null;

  private async getClient(): Promise<unknown> {
    if (this.sdk) return this.sdk;
    try {
      const { default: Anthropic } = await import("@anthropic-ai/sdk");
      this.sdk = new Anthropic();
      return this.sdk;
    } catch {
      return null;
    }
  }

  async chat(
    prompt: string,
    opts: { model?: string; jsonMode?: boolean } = {},
  ): Promise<LlmResponse> {
    // §S4: redact credentials before sending
    const safePrompt = redactSensitive(prompt);
    const model = opts.model ?? "claude-sonnet-4-20250514";
    const start = Date.now();

    const client = await this.getClient() as {
      messages: {
        create: (params: unknown) => Promise<{
          content: Array<{ type: string; text?: string }>;
          usage: { input_tokens: number; output_tokens: number };
        }>;
      };
    } | null;

    if (!client) {
      logger.warn("llm_unavailable", { reason: "Anthropic SDK not available" });
      return { text: "{}", inputTokens: 0, outputTokens: 0 };
    }

    try {
      const response = await client.messages.create({
        model,
        max_tokens: 4096,
        messages: [{ role: "user", content: safePrompt }],
      });

      const text = response.content
        .filter((b: { type: string }) => b.type === "text")
        .map((b: { text?: string }) => b.text ?? "")
        .join("");

      logger.info("llm_call", {
        model,
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
        durationMs: Date.now() - start,
      });

      return {
        text,
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
      };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error("llm_call_failed", { model, error: msg });
      throw err;
    }
  }
}

export class McpSamplingLlmClient implements LlmClient {
  private server: any;
  private fallback: LlmClient;

  constructor(server: any, fallback: LlmClient) {
    this.server = server;
    this.fallback = fallback;
  }

  async chat(
    prompt: string,
    opts: { model?: string; jsonMode?: boolean } = {},
  ): Promise<LlmResponse> {
    const safePrompt = redactSensitive(prompt);
    try {
      const start = Date.now();
      const response = await this.server.createMessage({
        messages: [
          {
            role: "user",
            content: { type: "text", text: safePrompt },
          },
        ],
        modelPreferences: opts.model ? { hints: [{ name: opts.model }] } : undefined,
        maxTokens: 4096,
      });

      const text = response.content.type === "text" ? response.content.text : "";
      logger.info("mcp_sampling_llm_call", {
        model: response.model,
        durationMs: Date.now() - start,
      });

      return {
        text,
        inputTokens: 0,
        outputTokens: 0,
      };
    } catch (err: any) {
      logger.warn("mcp_sampling_failed", { error: err.message, fallback: "Anthropic direct" });
      return this.fallback.chat(prompt, opts);
    }
  }
}

/** Singleton LLM client instance. */
let _client: LlmClient | null = null;
let _mcpServer: any = null;

export function getLlmClient(): LlmClient {
  if (!_client) {
    const fallback = new AnthropicLlmClient();
    if (_mcpServer) {
      _client = new McpSamplingLlmClient(_mcpServer, fallback);
    } else {
      _client = fallback;
    }
  }
  return _client;
}

export function registerMcpServer(server: any): void {
  _mcpServer = server;
  _client = null;
}

/** Override the default client (used by tests). */
export function setLlmClient(client: LlmClient): void {
  _client = client;
}
