import type {
  TextGenerationProvider,
  TextGenerationRequest,
} from "./llm-provider.js";

const GROQ_RESPONSES_URL = "https://api.groq.com/openai/v1/responses";
const DEFAULT_MODEL = "openai/gpt-oss-20b";

export interface GroqResponsesProviderOptions {
  model?: string;
}

export class GroqResponsesProvider implements TextGenerationProvider {
  private readonly apiKey: string;
  private readonly model: string;

  constructor(options: GroqResponsesProviderOptions = {}) {
    const apiKey = process.env.GROK_API_CODING_KEY;
    if (!apiKey) {
      throw new Error("Missing GROK_API_CODING_KEY.");
    }

    this.apiKey = apiKey;
    this.model = options.model ?? process.env.GROQ_MODEL ?? DEFAULT_MODEL;
  }

  async generateText({ systemPrompt, conversation }: TextGenerationRequest): Promise<string> {
    const response = await fetch(GROQ_RESPONSES_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: this.model,
        input: [
          { role: "system", content: systemPrompt },
          ...conversation.map(({ role, content }) => ({ role, content })),
        ],
      }),
      signal: AbortSignal.timeout(60_000),
    });

    const result: unknown = await response.json().catch(() => undefined);

    if (!response.ok) {
      const detail = getErrorMessage(result).replaceAll(this.apiKey, "[REDACTED]");
      throw new Error(`Groq request failed with HTTP ${response.status}${detail}`);
    }

    const text = getResponseText(result);
    if (!text) {
      throw new Error("Groq returned a successful response without text output.");
    }

    return text;
  }
}

function getErrorMessage(value: unknown): string {
  if (!isRecord(value)) return "";
  if (typeof value.error === "string") return `: ${value.error}`;
  if (isRecord(value.error) && typeof value.error.message === "string") {
    return `: ${value.error.message}`;
  }
  return typeof value.message === "string" ? `: ${value.message}` : "";
}

function getResponseText(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  if (typeof value.output_text === "string") return value.output_text;
  if (!Array.isArray(value.output)) return undefined;

  const text = value.output.flatMap((item) => {
    if (!isRecord(item) || !Array.isArray(item.content)) return [];
    return item.content.flatMap((part) =>
      isRecord(part) &&
      part.type === "output_text" &&
      typeof part.text === "string"
        ? [part.text]
        : [],
    );
  });

  return text.length > 0 ? text.join("") : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
