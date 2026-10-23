import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ConversationMessage } from "./llm-provider.js";

export const MAX_STORED_CHAT_MESSAGES = 120;
export const MAX_MODEL_CONTEXT_MESSAGES = 40;
const MAX_STORED_MESSAGE_CHARACTERS = 20_000;

export class JsonChatHistoryStore {
  constructor(private readonly directory: string) {}

  async load(userId: string): Promise<ConversationMessage[]> {
    let contents: string;
    try {
      contents = await readFile(this.filePath(userId), "utf8");
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") return [];
      throw error;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(contents);
    } catch {
      throw new Error("Muse chat history is not valid JSON.");
    }
    if (!Array.isArray(parsed)) {
      throw new Error("Muse chat history has an invalid format.");
    }

    return parsed
      .filter(isConversationMessage)
      .slice(-MAX_STORED_CHAT_MESSAGES)
      .map((message) => ({
        role: message.role,
        content: message.content.slice(0, MAX_STORED_MESSAGE_CHARACTERS),
      }));
  }

  async save(userId: string, messages: readonly ConversationMessage[]): Promise<void> {
    const storedMessages = messages
      .filter(isConversationMessage)
      .slice(-MAX_STORED_CHAT_MESSAGES)
      .map((message) => ({
        role: message.role,
        content: message.content.slice(0, MAX_STORED_MESSAGE_CHARACTERS),
      }));
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const path = this.filePath(userId);
    const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(storedMessages, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await rename(temporaryPath, path);
    await chmod(path, 0o600);
  }

  private filePath(userId: string): string {
    const idHash = createHash("sha256").update(userId).digest("hex");
    return join(this.directory, `${idHash}.json`);
  }
}

function isConversationMessage(value: unknown): value is ConversationMessage {
  if (typeof value !== "object" || value === null) return false;
  const message = value as Record<string, unknown>;
  return (
    (message.role === "user" || message.role === "assistant") &&
    typeof message.content === "string"
  );
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
