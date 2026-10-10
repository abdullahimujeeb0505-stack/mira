import { createInterface } from "node:readline";
import { MuseAgent } from "./muse-agent.js";
import { createTextGenerationProvider } from "./provider-selection.js";
import {
  MEMORY_CATEGORIES,
  parseMemoryCategory,
} from "./memory/memory-types.js";

async function main(): Promise<void> {
  const agent = new MuseAgent(createTextGenerationProvider());
  const terminal = createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  console.log(
    "Muse, your personal Web3 intern. Type /help for memory commands or /exit to leave.",
  );
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
          const handled = await handleMemoryCommand(message, agent);
          if (!handled) {
            const response = await agent.respond(message);
            console.log(`\nMuse: ${response}\n`);
          }
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

async function handleMemoryCommand(
  message: string,
  agent: MuseAgent,
): Promise<boolean> {
  if (/^\/help$/i.test(message)) {
    console.log(
      [
        "Memory commands:",
        "  /memories [CATEGORY]",
        "  /remember CATEGORY <text>",
        "  /update <id> <text>",
        "  /forget <id>",
        `  Categories: ${MEMORY_CATEGORIES.join(", ")}`,
      ].join("\n"),
    );
    return true;
  }

  const listMatch = /^\/memories(?:\s+(\S+))?$/i.exec(message);
  if (listMatch) {
    const categoryText = listMatch[1];
    const category = categoryText
      ? parseMemoryCategory(categoryText)
      : undefined;
    if (categoryText && !category) {
      throw new Error(`Choose one of: ${MEMORY_CATEGORIES.join(", ")}.`);
    }

    const memories = await agent.listMemories(category);
    if (memories.length === 0) {
      console.log("No saved memories.");
    } else {
      for (const memory of memories) {
        console.log(`[${memory.category}] ${memory.id} — ${memory.content}`);
      }
    }
    return true;
  }

  const rememberMatch = /^\/remember\s+(\S+)\s+([\s\S]+)$/i.exec(message);
  if (rememberMatch) {
    const category = parseMemoryCategory(rememberMatch[1]);
    if (!category) {
      throw new Error(`Choose one of: ${MEMORY_CATEGORIES.join(", ")}.`);
    }
    const memory = await agent.remember(category, rememberMatch[2]);
    console.log(`Saved ${memory.category} memory with ID ${memory.id}.`);
    return true;
  }

  const updateMatch = /^\/update\s+(\S+)\s+([\s\S]+)$/i.exec(message);
  if (updateMatch) {
    const memory = await agent.updateMemory(updateMatch[1], updateMatch[2]);
    console.log(
      memory
        ? `Updated ${memory.category} memory ${memory.id}.`
        : "No memory found with that ID.",
    );
    return true;
  }

  const forgetMatch = /^\/forget\s+(\S+)$/i.exec(message);
  if (forgetMatch) {
    const forgotten = await agent.forgetMemory(forgetMatch[1]);
    console.log(forgotten ? "Memory forgotten." : "No memory found with that ID.");
    return true;
  }

  return false;
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Muse could not start.");
  process.exitCode = 1;
});
