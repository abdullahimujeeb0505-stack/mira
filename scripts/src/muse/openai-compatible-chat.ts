export type ParsedChatCompletion =
  | { kind: "text"; value: string }
  | { kind: "empty" }
  | { kind: "unsupported" };

export function parseChatCompletionText(value: unknown): ParsedChatCompletion {
  if (!isRecord(value) || !Array.isArray(value.choices)) {
    return { kind: "unsupported" };
  }

  const firstChoice = value.choices[0];
  if (!isRecord(firstChoice) || !isRecord(firstChoice.message)) {
    return { kind: "unsupported" };
  }

  const content = firstChoice.message.content;
  if (typeof content !== "string") return { kind: "unsupported" };
  return content.trim()
    ? { kind: "text", value: content }
    : { kind: "empty" };
}

export function httpError(provider: string, status: number): Error {
  if (status === 401 || status === 403) {
    return new Error(
      `${provider} rejected the configured credentials (HTTP ${status}).`,
    );
  }
  if (status === 429) {
    return new Error(`${provider} rate limit reached (HTTP 429).`);
  }
  return new Error(`${provider} request failed with HTTP ${status}.`);
}

export function requestError(
  provider: string,
  error: unknown,
  timeoutMs: number,
  secret: string,
): Error {
  if (
    error instanceof Error &&
    (error.name === "TimeoutError" ||
      error.name === "AbortError" ||
      /timed out|timeout/i.test(error.message))
  ) {
    return new Error(`${provider} request timed out after ${timeoutMs} ms.`);
  }
  const detail =
    error instanceof Error
      ? error.message.replaceAll(secret, "[REDACTED]")
      : "Unknown network error.";
  return new Error(`${provider} request failed: ${detail}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
