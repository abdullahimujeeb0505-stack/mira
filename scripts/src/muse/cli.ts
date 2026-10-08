import { createInterface } from "node:readline";
import { GroqResponsesProvider } from "./groq-responses-provider.js";
import { MuseAgent } from "./muse-agent.js";

async function main(): Promise<void> {
  const agent = new MuseAgent(new GroqResponsesProvider());
  const terminal = createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  console.log("Muse, your personal Web3 intern. Type /exit to end the conversation.");
  let terminalClosed = false;
  let exiting = false;
  let pendingMessages = Promise.resolve();
  const closed = new Promise<void>((resolve) => {
    terminal.once("close", () => {
      terminalClosed = true;
      resolve();
    });
  });

  terminal.on("line", (line) => {
    pendingMessages = pendingMessages.then(async () => {
      if (exiting) return;

      const message = line.trim();
      if (message.toLowerCase() === "/exit") {
        exiting = true;
        terminal.close();
        return;
      }

      if (message) {
        try {
          const response = await agent.respond(message);
          console.log(`\nMuse: ${response}\n`);
        } catch (error) {
          const errorMessage =
            error instanceof Error ? error.message : "Muse could not get a response.";
          console.error(`\nError: ${errorMessage}\n`);
        }
      }

      if (!terminalClosed) terminal.prompt();
    });
  });

  terminal.setPrompt("You: ");
  terminal.prompt();
  await closed;
  await pendingMessages;
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Muse could not start.");
  process.exitCode = 1;
});
