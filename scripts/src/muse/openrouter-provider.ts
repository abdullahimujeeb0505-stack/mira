import type {
  TextGenerationProvider,
  TextGenerationRequest,
} from "./llm-provider.js";
import {
  httpError,
  parseChatCompletionText,
  requestError,
} from "./openai-compatible-chat.js";

const OPENROUTER_CHAT_COMPLETIONS_URL =
  "https://openrouter.ai/api/v1/chat/completions";
const DEFAULT_TIMEOUT_MS = 60_000;

export interface OpenRouterProviderOptions {
  model?: string;
  fetchImplementation?: typeof fetch;
  timeoutMs?: number;
}

export class OpenRouterProvider implements TextGenerationProvider {
  readonly providerName = "openrouter";
  private readonly apiKey: string;
  readonly model: string;
  private readonly fetchImplementation: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: OpenRouterProviderOptions = {}) {
    const apiKey = process.env.OPENROUTER_API_KEY?.trim();
    if (!apiKey) throw new Error("Missing OPENROUTER_API_KEY.");

    const model = options.model?.trim() || process.env.OPENROUTER_MODEL?.trim();
    if (!model) {
      throw new Error(
        "Missing OPENROUTER_MODEL. Choose an available model and review its pricing and limits.",
      );
    }

    this.apiKey = apiKey;
    this.model = model;
    this.fetchImplementation = options.fetchImplementation ?? fetch;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async generateText({
    systemPrompt,
    conversation,
  }: TextGenerationRequest): Promise<string> {
    let response: Response;
    try {
      response = await this.fetchImplementation(
        OPENROUTER_CHAT_COMPLETIONS_URL,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: this.model,
            messages: [
              { role: "system", content: systemPrompt },
              ...conversation.map(({ role, content }) => ({ role, content })),
            ],
          }),
          signal: AbortSignal.timeout(this.timeoutMs),
        },
      );
    } catch (error) {
      throw requestError("OpenRouter", error, this.timeoutMs, this.apiKey);
    }

    if (!response.ok) throw httpError("OpenRouter", response.status);

    let result: unknown;
    try {
      result = await response.json();
    } catch {
      throw new Error("OpenRouter returned a malformed JSON response.");
    }

    const text = parseChatCompletionText(result);
    if (text.kind === "empty") {
      throw new Error(
        "OpenRouter returned a successful response without text output.",
      );
    }
    if (text.kind === "unsupported") {
      throw new Error(
        "OpenRouter returned a successful response with an unsupported response structure.",
      );
    }

    return text.value;
  }
}
