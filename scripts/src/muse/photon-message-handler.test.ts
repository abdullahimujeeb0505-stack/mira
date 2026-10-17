import assert from "node:assert/strict";
import test from "node:test";
import {
  PHOTON_FAILURE_REPLY,
  PhotonMessageHandler,
  type PhotonMessage,
  type PhotonSpace,
} from "./photon-message-handler.js";

function makeSpace(id: string, onTyping: () => void = () => {}): PhotonSpace {
  return {
    __platform: "imessage",
    id,
    async responding<T>(handler: () => T | Promise<T>): Promise<T> {
      onTyping();
      return handler();
    },
  };
}

function makeMessage(
  content: { type: string; text?: string },
  options: { direction?: "inbound" | "outbound"; platform?: string } = {},
  reply: (text: string) => Promise<unknown> = async () => undefined,
): PhotonMessage {
  return {
    content,
    direction: options.direction ?? "inbound",
    platform: options.platform ?? "imessage",
    reply,
  };
}

test("Photon ignores outbound, non-iMessage, non-text, and empty events", async () => {
  let agentCreations = 0;
  const handler = new PhotonMessageHandler(() => {
    agentCreations += 1;
    return { hasConversationHistory: false, respond: async () => "reply" };
  });

  for (const message of [
    makeMessage({ type: "text", text: "echo" }, { direction: "outbound" }),
    makeMessage({ type: "text", text: "hello" }, { platform: "telegram" }),
    makeMessage({ type: "attachment" }),
    makeMessage({ type: "text", text: "   " }),
  ]) {
    assert.equal(await handler.handle(makeSpace("one"), message), false);
  }

  assert.equal(agentCreations, 0);
  assert.equal(handler.conversationCount, 0);
});

test("Photon isolates follow-up context by space and uses the matching message reply", async () => {
  const calls = new Map<string, string[]>();
  const replies: string[] = [];
  let typingSignals = 0;
  const handler = new PhotonMessageHandler((spaceKey) => {
    const history: string[] = [];
    calls.set(spaceKey, history);
    return {
      get hasConversationHistory() {
        return history.length > 0;
      },
      async respond(message: string) {
        history.push(message);
        return `${spaceKey} reply ${history.length}`;
      },
    };
  });

  const firstSpace = makeSpace("alice", () => typingSignals++);
  const secondSpace = makeSpace("bob", () => typingSignals++);
  const send = (space: PhotonSpace, text: string) =>
    handler.handle(
      space,
      makeMessage({ type: "text", text }, {}, async (reply) => {
        replies.push(reply);
        return undefined;
      }),
    );

  await send(firstSpace, "What is a compiler?");
  await send(secondSpace, "Hello");
  await send(firstSpace, "Why?");

  assert.equal(handler.conversationCount, 2);
  assert.deepEqual(calls.get("imessage:alice"), [
    "What is a compiler?",
    "Why?",
  ]);
  assert.deepEqual(calls.get("imessage:bob"), ["Hello"]);
  assert.deepEqual(replies, [
    "imessage:alice reply 1",
    "imessage:bob reply 1",
    "imessage:alice reply 2",
  ]);
  assert.equal(typingSignals, 2);
});

test("Photon reports failures safely and sends a generic reply without exception details", async () => {
  const failures: string[] = [];
  const replies: string[] = [];
  const handler = new PhotonMessageHandler(
    () => ({
      hasConversationHistory: false,
      async respond() {
        throw new Error("private provider credential");
      },
    }),
    (message) => failures.push(message),
  );

  await handler.handle(
    makeSpace("failure"),
    makeMessage({ type: "text", text: "What is a compiler?" }, {}, async (reply) => {
      replies.push(reply);
      return undefined;
    }),
  );

  assert.deepEqual(replies, [PHOTON_FAILURE_REPLY]);
  assert.deepEqual(failures, ["Muse could not complete an incoming iMessage."]);
  assert.equal(failures.join(" ").includes("private provider credential"), false);
});
