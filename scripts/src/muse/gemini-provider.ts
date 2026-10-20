import type {
  TextGenerationProvider,
  TextGenerationRequest,
} from "./llm-provider.js";
import { requestError } from "./openai-compatible-chat.js";

const GEMINI_GENERATE_CONTENT_URL =
  "https://generativelanguage.googleapis.com/v1beta/models";
const DEFAULT_MODEL = "gemini-3.5-flash-lite";
const DEFAULT_TIMEOUT_MS = 60_000;
const BLOCKED_REASONS = new Set([
  "BLOCKLIST",
  "JAILBREAK",
  "IMAGE_SAFETY",
  "MODEL_ARMOR",
  "PROHIBITED_CONTENT",
  "RECITATION",
  "SAFETY",
  "SPII",
]);

export interface GeminiProviderOptions {
  fetchImplementation?: typeof fetch;
  timeoutMs?: number;
}

type ParsedGeminiText =
  | { kind: "text"; value: string }
  | { kind: "empty" }
  | { kind: "unsupported" }
  | { kind: "blocked"; reason: string };

export class GeminiProvider implements TextGenerationProvider {
  readonly providerName = "gemini";
  private readonly apiKey: string;
  readonly model: string;
  private readonly fetchImplementation: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: GeminiProviderOptions = {}) {
    const apiKey = process.env.GEMINI_API_KEY?.trim();
    if (!apiKey) throw new Error("Missing GEMINI_API_KEY.");

    this.apiKey = apiKey;
    this.model = DEFAULT_MODEL;
    this.fetchImplementation = options.fetchImplementation ?? fetch;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async generateText({
    systemPrompt,
    conversation,
  }: TextGenerationRequest): Promise<string> {
    const requestBody: Record<string, unknown> = {
      contents: conversation.map(({ role, content }) => ({
        role: role === "assistant" ? "model" : "user",
        parts: [{ text: content }],
      })),
    };
    if (systemPrompt.length > 0) {
      requestBody.systemInstruction = { parts: [{ text: systemPrompt }] };
    }

    let response: Response;
    try {
      response = await this.fetchImplementation(
        `${GEMINI_GENERATE_CONTENT_URL}/${encodeURIComponent(this.model)}:generateContent`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-goog-api-key": this.apiKey,
          },
          body: JSON.stringify(requestBody),
          signal: AbortSignal.timeout(this.timeoutMs),
        },
      );
    } catch (error) {
      throw requestError("Gemini", error, this.timeoutMs, this.apiKey);
    }

    let result: unknown;
    try {
      result = await response.json();
    } catch {
      if (!response.ok) throw geminiHttpError(response.status);
      throw new Error("Gemini returned a malformed JSON response.");
    }

    if (!response.ok) {
      throw geminiHttpError(
        response.status,
        extractErrorDetail(result, this.apiKey),
      );
    }

    const text = parseGeminiText(result);
    if (text.kind === "blocked") {
      throw new Error(
        `Gemini blocked the request because of a policy filter (${text.reason}).`,
      );
    }
    if (text.kind === "empty") {
      throw new Error(
        "Gemini returned a successful response without text output.",
      );
    }
    if (text.kind === "unsupported") {
      throw new Error(
        "Gemini returned a successful response with an unsupported response structure.",
      );
    }

    return text.value;
  }
}

function geminiHttpError(status: number, detail?: string): Error {
  const suffix = detail ? `: ${detail}` : "";
  if (status === 401) {
    return new Error(
      `Gemini rejected the configured credentials (HTTP 401)${suffix}.`,
    );
  }
  if (status === 403) {
    return new Error(`Gemini denied the request (HTTP 403)${suffix}.`);
  }
  if (status === 429) {
    return new Error(`Gemini rate limit reached (HTTP 429)${suffix}.`);
  }
  return new Error(`Gemini request failed with HTTP ${status}${suffix}.`);
}

function extractErrorDetail(
  value: unknown,
  apiKey: string,
): string | undefined {
  if (!isRecord(value) || !isRecord(value.error)) return undefined;
  if (typeof value.error.message !== "string") return undefined;

  const detail = value.error.message
    .replaceAll(apiKey, "[REDACTED]")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 220);
  return detail || undefined;
}

function parseGeminiText(value: unknown): ParsedGeminiText {
  if (!isRecord(value)) return { kind: "unsupported" };

  const promptFeedback = isRecord(value.promptFeedback)
    ? value.promptFeedback
    : undefined;
  if (typeof promptFeedback?.blockReason === "string") {
    const reason = promptFeedback.blockReason.toUpperCase();
    if (reason && reason !== "BLOCKED_REASON_UNSPECIFIED") {
      return { kind: "blocked", reason: safeReason(reason) };
    }
  }

  if (!Array.isArray(value.candidates)) return { kind: "unsupported" };
  if (value.candidates.length === 0) return { kind: "empty" };

  const candidate = value.candidates[0];
  if (!isRecord(candidate)) return { kind: "unsupported" };

  if (typeof candidate.finishReason === "string") {
    const reason = candidate.finishReason.toUpperCase();
    if (BLOCKED_REASONS.has(reason)) {
      return { kind: "blocked", reason };
    }
  }

  if (!isRecord(candidate.content) || !Array.isArray(candidate.content.parts)) {
    return { kind: "unsupported" };
  }

  const textParts: string[] = [];
  for (const part of candidate.content.parts) {
    if (!isRecord(part)) return { kind: "unsupported" };
    if (part.thought === true || part.text === undefined) continue;
    if (typeof part.text !== "string") return { kind: "unsupported" };
    if (part.text.length > 0) textParts.push(part.text);
  }

  const text = textParts.join("");
  return text.trim() ? { kind: "text", value: text } : { kind: "empty" };
}

function safeReason(reason: string): string {
  return reason.replace(/[^A-Z_]/g, "").slice(0, 48) || "UNKNOWN";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
