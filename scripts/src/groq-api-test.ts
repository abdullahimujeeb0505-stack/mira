export {};

const apiKey = process.env.GROK_API_CODING_KEY;

if (!apiKey) {
  console.error("Missing GROK_API_CODING_KEY.");
  process.exitCode = 1;
} else {
  try {
    const response = await fetch("https://api.groq.com/openai/v1/responses", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "openai/gpt-oss-20b",
        input: "Reply with exactly: GROQ WORKS",
      }),
      signal: AbortSignal.timeout(120_000),
    });

    const result: unknown = await response.json();

    if (!response.ok) {
      throw new Error(
        `Groq request failed with HTTP ${response.status}${getErrorMessage(result)}`,
      );
    }

    const text = getResponseText(result);
    if (!text) {
      throw new Error("Groq returned a successful response without text output.");
    }

    process.stdout.write(`${text}\n`);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Groq request failed.";
    console.error(message.replaceAll(apiKey, "[REDACTED]"));
    process.exitCode = 1;
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
