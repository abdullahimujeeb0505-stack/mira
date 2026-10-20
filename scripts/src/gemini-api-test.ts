import { GeminiProvider } from "./muse/gemini-provider.js";

try {
  const provider = new GeminiProvider();
  const text = await provider.generateText({
    systemPrompt: "Reply with exactly: GEMINI WORKS",
    conversation: [
      { role: "user", content: "Verify the Gemini API connection." },
    ],
  });
  process.stdout.write(`Gemini (${provider.model}): ${text}\n`);
} catch (error) {
  console.error(
    error instanceof Error ? error.message : "Gemini request failed.",
  );
  process.exitCode = 1;
}
