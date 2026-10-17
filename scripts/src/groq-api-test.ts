import { GroqProvider } from "./muse/groq-provider.js";

try {
  const provider = new GroqProvider();
  const text = await provider.generateText({
    systemPrompt: "Reply with exactly: GROQ WORKS",
    conversation: [{ role: "user", content: "Verify the Groq connection." }],
  });
  process.stdout.write(`${text}\n`);
} catch (error) {
  console.error(
    error instanceof Error ? error.message : "Groq request failed.",
  );
  process.exitCode = 1;
}
