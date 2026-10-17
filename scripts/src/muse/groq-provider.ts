import type {
  TextGenerationProvider,
  TextGenerationRequest,
} from "./llm-provider.js";
import {
  httpError,
  parseChatCompletionText,
  requestError,
} from "./openai-compatible-chat.js";

const GROQ_CHAT_COMPLETIONS_URL =
  "https://api.groq.com/openai/v1/chat/completions";
const DEFAULT_MODEL = "openai/gpt-oss-120b";
const DEFAULT_TIMEOUT_MS = 60_000;

export interface GroqProviderOptions {
  model?: string;
  fetchImplementation?: typeof fetch;
  timeoutMs?: number;
}

export class GroqProvider implements TextGenerationProvider {
  readonly providerName = "groq";
  private readonly apiKey: string;
  readonly model: string;
  private readonly fetchImplementation: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: GroqProviderOptions = {}) {
    const apiKey =
      process.env.GROQ_API_KEY?.trim() ||
      process.env.GROK_API_CODING_KEY?.trim();
    if (!apiKey) {
      throw new Error(
        "Missing GROQ_API_KEY (legacy GROK_API_CODING_KEY is also supported).",
      );
    }

    this.apiKey = apiKey;
    this.model =
      options.model?.trim() ||
      process.env.GROQ_MODEL?.trim() ||
      DEFAULT_MODEL;
    this.fetchImplementation = options.fetchImplementation ?? fetch;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async generateText({
    systemPrompt,
    conversation,
  }: TextGenerationRequest): Promise<string> {
    let response: Response;
    try {
      response = await this.fetchImplementation(GROQ_CHAT_COMPLETIONS_URL, {
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
      });
    } catch (error) {
      throw requestError("Groq", error, this.timeoutMs, this.apiKey);
    }

    if (!response.ok) throw httpError("Groq", response.status);

    let result: unknown;
    try {
      result = await response.json();
    } catch {
      throw new Error("Groq returned a malformed JSON response.");
    }

    const text = parseChatCompletionText(result);
    if (text.kind === "empty") {
      throw new Error("Groq returned a successful response without text output.");
    }
    if (text.kind === "unsupported") {
      throw new Error(
        "Groq returned a successful response with an unsupported response structure.",
      );
    }

    return text.value;
  }
}
