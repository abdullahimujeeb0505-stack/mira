import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  JsonChatHistoryStore,
  MAX_STORED_CHAT_MESSAGES,
} from "./chat-history-store.js";
import type { ConversationMessage } from "./llm-provider.js";

test("chat history is isolated by user and bounded to the newest messages", async () => {
  const directory = await mkdtemp(join(tmpdir(), "muse-chat-history-"));
  const store = new JsonChatHistoryStore(directory);
  const firstUserHistory: ConversationMessage[] = Array.from(
    { length: MAX_STORED_CHAT_MESSAGES + 24 },
    (_, index): ConversationMessage => ({
      role: index % 2 === 0 ? "user" : "assistant",
      content: `Message ${index}`,
    }),
  );
  try {
    await store.save("user-one", firstUserHistory);
    await store.save("user-two", [{ role: "user", content: "Private message" }]);

    const loadedFirst = await store.load("user-one");
    assert.equal(loadedFirst.length, MAX_STORED_CHAT_MESSAGES);
    assert.equal(loadedFirst[0]?.content, "Message 24");
    assert.equal(loadedFirst.at(-1)?.content, `Message ${firstUserHistory.length - 1}`);
    assert.deepEqual(await store.load("user-two"), [
      { role: "user", content: "Private message" },
    ]);
    assert.deepEqual(await store.load("a-user-with-no-history"), []);

    const files = await readdir(directory);
    assert.equal(files.length, 2);
    assert.ok(files.every((name) => /^[a-f0-9]{64}\.json$/.test(name)));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
