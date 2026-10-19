import type {
  ConversationMessage,
  TextGenerationProvider,
  TextGenerationRequest,
} from "./llm-provider.js";
import { requestError } from "./openai-compatible-chat.js";

const GEMINI_API_BASE = "https://generativelanguage.googleapis.com/v1beta";
const DEFAULT_MODEL = "gemini-3.5-flash";
const DEFAULT_TIMEOUT_MS = 60_000;
/**
 * Generous body ceiling. Streaming responses are reassembled in memory, and a
 * runaway gateway should not be able to exhaust the process.
 */
const RESPONSE_BYTE_LIMIT = 8_000_000;

export interface GeminiProviderOptions {
  model?: string;
  fetchImplementation?: typeof fetch;
  timeoutMs?: number;
  /** Set false to use the non-streaming endpoint. */
  stream?: boolean;
}

interface GeminiPart {
  text?: string;
}

interface GeminiContent {
  role: "user" | "model";
  parts: GeminiPart[];
}

/**
 * Google Gemini text-generation adapter.
 *
 * Task-aware provider selection uses Groq by default and can retry failed
 * requests through Gemini. `MUSE_CHAT_LLM_PROVIDER` and
 * `MUSE_RESEARCH_LLM_PROVIDER` override the primary routes, while
 * `MUSE_LLM_PROVIDER=gemini` can pin both tasks to Gemini. This adapter speaks
 * Gemini's native `generateContent` shape rather than the
 * OpenAI-compatibility shim, which keeps finish reasons, prompt blocks, and
 * citation/safety metadata legible instead of flattened.
 *
 * Requests go to `:streamGenerateContent?alt=sse` by default. Intermediary
 * proxies commonly buffer a long non-streaming JSON body and then drop the
 * connection; Server-Sent Events flush incrementally, so the same timeout
 * yields a usable response far more often. A gateway that ignores `alt=sse`
 * and answers with `application/json` is still parsed correctly. If the API
 * explicitly rejects the streaming method (HTTP 404/405), the provider retries
 * once with the standard `:generateContent` JSON endpoint.
 */
export class GeminiProvider implements TextGenerationProvider {
  readonly providerName = "gemini";
  private readonly apiKey: string;
  readonly model: string;
  private readonly fetchImplementation: typeof fetch;
  private readonly timeoutMs: number;
  private readonly stream: boolean;

  constructor(options: GeminiProviderOptions = {}) {
    const apiKey = process.env.GEMINI_API_KEY?.trim();
    if (!apiKey) {
      throw new Error(
        "Missing GEMINI_API_KEY. Set it to enable Gemini fallback, or select another configured provider.",
      );
    }

    this.apiKey = apiKey;
    const configuredModel =
      options.model?.trim() || process.env.GEMINI_MODEL?.trim();
    // Google's error guidance may show the full resource name. Keep the
    // adapter's model property as the base ID before adding `/models/` below.
    const model = configuredModel?.startsWith("models/")
      ? configuredModel.slice("models/".length)
      : configuredModel;
    this.model = model || DEFAULT_MODEL;
    this.fetchImplementation = options.fetchImplementation ?? fetch;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.stream = options.stream ?? true;
  }

  private endpointFor(useSse: boolean): string {
    // Google's streaming and non-streaming methods are distinct endpoints;
    // `alt=sse` belongs only on `:streamGenerateContent`.
    const method = useSse ? "streamGenerateContent" : "generateContent";
    const path = `${GEMINI_API_BASE}/models/${encodeURIComponent(this.model)}:${method}`;
    return useSse ? `${path}?alt=sse` : path;
  }

  async generateText({
    systemPrompt,
    conversation,
  }: TextGenerationRequest): Promise<string> {
    const contents = toGeminiContents(conversation);
    if (contents.length === 0) {
      throw new Error("Gemini requires at least one conversation message.");
    }

    const requestBody = JSON.stringify({
      contents,
      ...(systemPrompt.trim()
        ? { systemInstruction: { parts: [{ text: systemPrompt }] } }
        : {}),
    });
    // A 404/405 from the streaming method can mean that this API gateway/model
    // only exposes unary generation. Retry that one case with generateContent;
    // other failures (auth, quota, malformed input) are not helped by a retry.
    const attempts = this.stream ? [true, false] : [false];

    for (const useSse of attempts) {
      let response: Response;
      try {
        response = await this.fetchImplementation(this.endpointFor(useSse), {
          method: "POST",
          headers: {
            "x-goog-api-key": this.apiKey,
            "Content-Type": "application/json",
            ...(useSse ? { Accept: "text/event-stream" } : {}),
          },
          body: requestBody,
          signal: AbortSignal.timeout(this.timeoutMs),
        });
      } catch (error) {
        throw requestError("Gemini", error, this.timeoutMs, this.apiKey);
      }

      const bodyText = await readBodyText(response, this.apiKey);

      if (!response.ok) {
        const failure = new Error(
          `Gemini request failed with HTTP ${response.status}${describeErrorPayload(bodyText, this.apiKey)}`,
        );
        if (useSse && (response.status === 404 || response.status === 405)) {
          continue;
        }
        throw failure;
      }

      const payload = useSse
        ? parseSsePayload(bodyText)
        : parseJsonPayload(bodyText);

      if (!payload) {
        throw new Error("Gemini returned a malformed JSON response.");
      }

      const blockReason = readBlockReason(payload);
      if (blockReason) {
        throw new Error(
          `Gemini blocked the request before generation (${humanizeBlockReason(blockReason)}).`,
        );
      }

      const parsed = parseGeminiText(payload);
      if (parsed.kind === "empty") {
        throw new Error(
          `Gemini returned a successful response without text output${readFinishReasonDetail(payload)}.`,
        );
      }
      if (parsed.kind === "unsupported") {
        throw new Error(
          "Gemini returned a successful response with an unsupported response structure.",
        );
      }

      return parsed.text;
    }

    throw new Error("Gemini request failed on every supported endpoint.");
  }
}

/**
 * Maps Muse's conversation onto Gemini's `contents`, merging consecutive
 * same-role turns into one entry. Gemini tolerates repeats, but merging keeps
 * long research threads — where Muse pushes several assistant turns in a row —
 * inside the model's turn structure instead of fragmenting it.
 */
function toGeminiContents(
  conversation: readonly ConversationMessage[],
): GeminiContent[] {
  const contents: GeminiContent[] = [];

  for (const message of conversation) {
    const text = message.content?.trim();
    if (!text) continue;

    const role = message.role === "assistant" ? "model" : "user";
    const last = contents[contents.length - 1];
    if (last && last.role === role) {
      last.parts.push({ text });
      continue;
    }
    contents.push({ role, parts: [{ text }] });
  }

  return contents;
}

async function readBodyText(
  response: Response,
  secret: string,
): Promise<string> {
  try {
    if (!response.body) return "";
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let totalBytes = 0;

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        totalBytes += value.byteLength;
        if (totalBytes > RESPONSE_BYTE_LIMIT) {
          await reader.cancel();
          throw new Error(
            `Gemini response exceeded the ${RESPONSE_BYTE_LIMIT}-byte limit.`,
          );
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }

    const bytes = new Uint8Array(totalBytes);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return new TextDecoder().decode(bytes);
  } catch (error) {
    throw requestError("Gemini", error, RESPONSE_BYTE_LIMIT, secret);
  }
}

function parseJsonPayload(body: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(body);
    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
}

/**
 * Reassembles a `text/event-stream` body into one response object.
 *
 * Gemini's stream events carry incremental text deltas per candidate — each
 * event's `parts[].text` is only the new fragment since the previous event —
 * so fragments are accumulated per candidate index in arrival order and then
 * wrapped into a single full-shaped response. Events without candidates (for
 * example a trailing usage-only event) still contribute `promptFeedback` and
 * `usageMetadata`.
 */
function parseSsePayload(body: string): Record<string, unknown> | null {
  const events: Record<string, unknown>[] = [];

  for (const line of body.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) continue;
    const data = trimmed.slice(5).trim();
    if (!data || data === "[DONE]") continue;
    const parsed = parseJsonPayload(data);
    if (parsed) events.push(parsed);
  }

  if (events.length === 0) {
    // Some gateways answer an `alt=sse` request with plain JSON.
    return parseJsonPayload(body.trim());
  }

  const perCandidate = new Map<
    number,
    { texts: string[]; finishReason?: string }
  >();
  let promptFeedback: Record<string, unknown> | undefined;
  let usageMetadata: Record<string, unknown> | undefined;

  for (const event of events) {
    const feedback = readPromptFeedback(event);
    if (feedback) promptFeedback = feedback;
    if (isRecord(event.usageMetadata)) usageMetadata = event.usageMetadata;

    const candidates = Array.isArray(event.candidates) ? event.candidates : [];
    for (const candidate of candidates) {
      if (!isRecord(candidate)) continue;
      const index = typeof candidate.index === "number" ? candidate.index : 0;
      const entry = perCandidate.get(index) ?? { texts: [] };
      const content = isRecord(candidate.content)
        ? candidate.content
        : undefined;
      const parts =
        content && Array.isArray(content.parts) ? content.parts : [];
      for (const part of parts) {
        if (!isRecord(part) || part.thought === true) continue;
        if (typeof part.text === "string" && part.text.length > 0) {
          entry.texts.push(part.text);
        }
      }
      if (typeof candidate.finishReason === "string") {
        entry.finishReason = candidate.finishReason;
      }
      perCandidate.set(index, entry);
    }
  }

  if (perCandidate.size === 0) {
    return events[events.length - 1] ?? null;
  }

  const candidates = [...perCandidate.entries()]
    .sort(([left], [right]) => left - right)
    .map(([index, entry]) => ({
      index,
      content: { role: "model", parts: [{ text: entry.texts.join("") }] },
      ...(entry.finishReason ? { finishReason: entry.finishReason } : {}),
    }));

  return {
    ...(promptFeedback ? { promptFeedback } : {}),
    ...(usageMetadata ? { usageMetadata } : {}),
    candidates,
  };
}

type ParsedGeminiText =
  { kind: "text"; text: string } | { kind: "empty" } | { kind: "unsupported" };

function parseGeminiText(payload: Record<string, unknown>): ParsedGeminiText {
  if (!Array.isArray(payload.candidates)) return { kind: "unsupported" };

  const blocks: string[] = [];
  for (const candidate of payload.candidates) {
    if (!isRecord(candidate)) return { kind: "unsupported" };
    const content = candidate.content;
    if (!isRecord(content) || !Array.isArray(content.parts)) {
      return { kind: "unsupported" };
    }
    for (const part of content.parts) {
      if (!isRecord(part)) return { kind: "unsupported" };
      if (part.thought === true) continue;
      if (typeof part.text === "string" && part.text.length > 0) {
        blocks.push(part.text);
      }
    }
  }

  if (blocks.length > 0) {
    const joined = blocks.join("");
    return joined.trim() ? { kind: "text", text: joined } : { kind: "empty" };
  }

  return { kind: "empty" };
}

function readPromptFeedback(
  payload: Record<string, unknown>,
): Record<string, unknown> | undefined {
  return isRecord(payload.promptFeedback) ? payload.promptFeedback : undefined;
}

function readBlockReason(payload: Record<string, unknown>): string | null {
  const feedback = readPromptFeedback(payload);
  if (
    feedback &&
    typeof feedback.blockReason === "string" &&
    feedback.blockReason
  ) {
    return feedback.blockReason;
  }

  const candidate = Array.isArray(payload.candidates)
    ? payload.candidates[0]
    : undefined;
  if (!isRecord(candidate)) return null;
  const finishReason = candidate.finishReason;
  if (typeof finishReason !== "string") return null;
  return BLOCKING_FINISH_REASONS.has(finishReason.toUpperCase())
    ? finishReason
    : null;
}

function readFinishReasonDetail(payload: Record<string, unknown>): string {
  const candidate = Array.isArray(payload.candidates)
    ? payload.candidates[0]
    : undefined;
  if (!isRecord(candidate)) return "";
  return typeof candidate.finishReason === "string"
    ? ` (finish reason: ${candidate.finishReason})`
    : "";
}

/**
 * Finish reasons that mean "refused or withheld", not "finished normally".
 *
 * Reported distinctly so Muse does not surface a safety block as an opaque
 * "no text output" failure.
 */
const BLOCKING_FINISH_REASONS = new Set([
  "SAFETY",
  "RECITATION",
  "PROHIBITED_CONTENT",
  "BLOCKLIST",
  "LANGUAGE",
  "OTHER",
]);

const BLOCK_REASON_LABELS: Record<string, string> = {
  SAFETY: "the prompt was flagged by safety filters",
  PROHIBITED_CONTENT: "the prompt contained prohibited content",
  RECITATION: "the output was withheld as recited copyrighted text",
  BLOCKLIST: "the prompt matched a blocked term",
  LANGUAGE: "the prompt language is not supported",
  OTHER: "Google reported another block reason",
  SPII: "the prompt appeared to contain sensitive personal information",
  MALFORMED_FUNCTION_CALL: "the model produced a malformed function call",
  MAX_TOKENS: "the token budget was exhausted before any text",
  UNEXPECTED_TOOL_CALL: "the model attempted an unexpected tool call",
};

function humanizeBlockReason(reason: string): string {
  const normalized = reason.toUpperCase();
  return BLOCK_REASON_LABELS[normalized] ?? reason;
}

/**
 * Extracts Gemini's own error message from a failure body without echoing the
 * API key back into logs or chat.
 */
function describeErrorPayload(body: string, secret: string): string {
  const payload = parseJsonPayload(body);
  if (!payload) return bodySnippet(body, secret);

  const error = payload.error;
  const message = isRecord(error)
    ? typeof error.message === "string"
      ? error.message
      : ""
    : typeof error === "string"
      ? error
      : "";

  const status =
    isRecord(error) && typeof error.status === "string" ? error.status : "";
  const detail = redact(message, secret);
  if (detail) return `: ${detail}${status ? ` [${status}]` : ""}`;
  if (status) return `: ${status}`;
  return bodySnippet(body, secret);
}

/**
 * Keeps a short, redacted preview of non-Google error bodies (for example an
 * HTML 404 from a proxy) so diagnostics can distinguish a provider response
 * from a gateway response without logging an unbounded body.
 */
function bodySnippet(body: string, secret: string): string {
  const snippet = redact(body, secret)
    .replaceAll("\r", " ")
    .replaceAll("\n", " ")
    .replaceAll("\t", " ")
    .split(" ")
    .filter(Boolean)
    .join(" ");
  return snippet ? `: ${snippet.slice(0, 200)}` : "";
}

function redact(value: string, secret: string): string {
  return secret ? value.replaceAll(secret, "[REDACTED]") : value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
