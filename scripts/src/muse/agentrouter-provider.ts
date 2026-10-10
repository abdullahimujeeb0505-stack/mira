import type {
  TextGenerationProvider,
  TextGenerationRequest,
} from "./llm-provider.js";

const AGENTROUTER_RESPONSES_URL = "https://agentrouter.org/v1/responses";
const DEFAULT_MODEL = "gpt-5.6-sol";
const DEFAULT_TIMEOUT_MS = 60_000;

export interface AgentRouterProviderOptions {
  model?: string;
  fetchImplementation?: typeof fetch;
  timeoutMs?: number;
}

export class AgentRouterProvider implements TextGenerationProvider {
  private readonly apiKey: string;
  private readonly model: string;
  private readonly fetchImplementation: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: AgentRouterProviderOptions = {}) {
    const apiKey = process.env.AGENTROUTER_API_KEY?.trim();
    if (!apiKey) {
      throw new Error("Missing AGENTROUTER_API_KEY.");
    }

    this.apiKey = apiKey;
    this.model =
      options.model ??
      (process.env.AGENTROUTER_MODEL?.trim() || DEFAULT_MODEL);
    this.fetchImplementation = options.fetchImplementation ?? fetch;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async generateText({
    systemPrompt,
    conversation,
  }: TextGenerationRequest): Promise<string> {
    let response: Response;
    try {
      response = await this.fetchImplementation(AGENTROUTER_RESPONSES_URL, {
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
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      const detail =
        error instanceof Error ? error.message : "Unknown network error.";
      throw new Error(
        `AgentRouter request failed: ${redact(detail, this.apiKey)}`,
      );
    }

    const result: unknown = await response.json().catch(() => undefined);
    if (!response.ok) {
      const detail = redact(getErrorMessage(result), this.apiKey);
      throw new Error(
        `AgentRouter request failed with HTTP ${response.status}${detail}`,
      );
    }

    const text = getResponseText(result);
    if (!text) {
      throw new Error(
        "AgentRouter returned a successful response without text output.",
      );
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

function redact(value: string, secret: string): string {
  return value.replaceAll(secret, "[REDACTED]");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
