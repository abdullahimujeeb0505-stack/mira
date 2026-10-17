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
  readonly providerName = "agentrouter";
  private readonly apiKey: string;
  readonly model: string;
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

    const parsedResponse = parseResponseText(result);
    if (parsedResponse.kind === "empty") {
      throw new Error(
        "AgentRouter returned a successful response without text output.",
      );
    }
    if (parsedResponse.kind === "unsupported") {
      throw new Error(
        "AgentRouter returned a successful response with an unsupported response structure.",
      );
    }

    return parsedResponse.text;
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

type ParsedResponseText =
  | { kind: "text"; text: string }
  | { kind: "empty" }
  | { kind: "unsupported" };

function parseResponseText(value: unknown): ParsedResponseText {
  if (!isRecord(value)) return { kind: "unsupported" };

  if (typeof value.output_text === "string" && value.output_text.length > 0) {
    return { kind: "text", text: value.output_text };
  }

  if (value.output === undefined) {
    return typeof value.output_text === "string"
      ? { kind: "empty" }
      : { kind: "unsupported" };
  }
  if (!Array.isArray(value.output)) return { kind: "unsupported" };

  const textBlocks: string[] = [];
  for (const item of value.output) {
    if (!isRecord(item)) return { kind: "unsupported" };
    if (item.content === undefined) {
      if (typeof item.type !== "string") return { kind: "unsupported" };
      continue;
    }
    if (!Array.isArray(item.content)) return { kind: "unsupported" };

    for (const part of item.content) {
      if (!isRecord(part) || typeof part.type !== "string") {
        return { kind: "unsupported" };
      }

      if (part.type === "output_text" || part.type === "text") {
        if (typeof part.text !== "string") return { kind: "unsupported" };
        if (part.text.length > 0) textBlocks.push(part.text);
      }
    }
  }

  return textBlocks.length > 0
    ? { kind: "text", text: textBlocks.join("") }
    : { kind: "empty" };
}

function redact(value: string, secret: string): string {
  return value.replaceAll(secret, "[REDACTED]");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
