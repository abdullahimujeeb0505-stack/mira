import assert from "node:assert/strict";
import test from "node:test";
import type { ContentInput } from "spectrum-ts";
import {
  PHOTON_FAILURE_REPLY,
  PhotonMessageHandler,
  type PhotonMessage,
  type PhotonSpace,
} from "./photon-message-handler.js";
import { IMAGE_GENERATION_USAGE_REPLY } from "./image-generation-command.js";

function makeSpace(
  id: string,
  onTyping: () => void = () => {},
  onSend: (content: ContentInput) => Promise<unknown> = async () => undefined,
  platform = "imessage",
): PhotonSpace {
  return {
    __platform: platform,
    id,
    async responding<T>(handler: () => T | Promise<T>): Promise<T> {
      onTyping();
      return handler();
    },
    async send(content: ContentInput): Promise<unknown> {
      return onSend(content);
    },
  };
}

function makeMessage(
  content: { type: string; text?: string },
  options: { direction?: "inbound" | "outbound"; platform?: string } = {},
): PhotonMessage {
  return {
    content,
    direction: options.direction ?? "inbound",
    platform: options.platform ?? "imessage",
    sender: { id: "test-handle" },
  };
}

test("Spectrum ignores outbound, unsupported-platform, non-text, and empty events", async () => {
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

test("Photon isolates follow-up context by space and sends through the matching Spectrum space", async () => {
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
  const sendReply = async (reply: ContentInput): Promise<unknown> => {
    assert.equal(typeof reply, "string");
    if (typeof reply === "string") replies.push(reply);
    return undefined;
  };

  const firstSpace = makeSpace("alice", () => typingSignals++, sendReply);
  const secondSpace = makeSpace("bob", () => typingSignals++, sendReply);
  const send = (space: PhotonSpace, text: string) =>
    handler.handle(space, makeMessage({ type: "text", text }));

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
  assert.equal(typingSignals, 1);
});

test("Spectrum handles WhatsApp Business text and replies through its space", async () => {
  const replies: string[] = [];
  let createdSpaceKey = "";
  const handler = new PhotonMessageHandler((spaceKey) => {
    createdSpaceKey = spaceKey;
    return {
      hasConversationHistory: false,
      async respond(message: string) {
        return `WhatsApp reply: ${message}`;
      },
    };
  });
  const space = makeSpace(
    "whatsapp-user",
    undefined,
    async (content) => {
      if (typeof content === "string") replies.push(content);
      return undefined;
    },
    "whatsapp_business",
  );

  assert.equal(
    await handler.handle(
      space,
      makeMessage(
        { type: "text", text: "Hello from WhatsApp" },
        { platform: "whatsapp_business" },
      ),
    ),
    true,
  );
  assert.equal(createdSpaceKey, "whatsapp_business:whatsapp-user");
  assert.deepEqual(replies, ["WhatsApp reply: Hello from WhatsApp"]);
});

test("Spectrum transport sends explicit image commands as image attachments", async () => {
  let modelCalls = 0;
  const prompts: string[] = [];
  let sentContent: ContentInput | undefined;
  let typingSignals = 0;
  const image = {
    bytes: Buffer.from([0x89, 0x50, 0x4e, 0x47]),
    mimeType: "image/png" as const,
  };
  const handler = new PhotonMessageHandler(
    () => ({
      hasConversationHistory: false,
      async respond() {
        modelCalls += 1;
        return "This must not handle an image command.";
      },
    }),
    undefined,
    async (prompt) => {
      prompts.push(prompt);
      return image;
    },
  );

  assert.equal(
    await handler.handle(
      makeSpace("image", () => typingSignals++, async (content) => {
        sentContent = content;
        return undefined;
      }),
      makeMessage({ type: "text", text: "generate image: a glass greenhouse" }),
    ),
    true,
  );

  assert.deepEqual(prompts, ["a glass greenhouse"]);
  assert.equal(modelCalls, 0);
  assert.equal(typingSignals, 1);
  assert.equal(typeof sentContent, "object");
  if (!sentContent || typeof sentContent === "string") {
    throw new Error("Expected a Spectrum attachment content builder.");
  }
  const built = await sentContent.build();
  assert.equal(built.type, "attachment");
  if (built.type !== "attachment") return;
  assert.equal(built.name, "mira-generated-image.png");
  assert.equal(built.mimeType, "image/png");
  assert.deepEqual(await built.read(), image.bytes);
});

test("Spectrum transport asks for an image prompt without calling a model", async () => {
  let modelCalls = 0;
  let sentReply: ContentInput | undefined;
  const handler = new PhotonMessageHandler(() => ({
    hasConversationHistory: false,
    async respond() {
      modelCalls += 1;
      return "chat reply";
    },
  }));

  await handler.handle(
    makeSpace("missing-prompt", undefined, async (content) => {
      sentReply = content;
      return undefined;
    }),
    makeMessage({ type: "text", text: "generate image" }),
  );

  assert.equal(modelCalls, 0);
  assert.equal(sentReply, IMAGE_GENERATION_USAGE_REPLY);
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
    makeSpace("failure", undefined, async (reply) => {
      assert.equal(typeof reply, "string");
      if (typeof reply === "string") replies.push(reply);
      return undefined;
    }),
    makeMessage({ type: "text", text: "What is a compiler?" }),
  );

  assert.deepEqual(replies, [PHOTON_FAILURE_REPLY]);
  assert.deepEqual(failures, ["Muse could not complete an incoming Spectrum message."]);
  assert.equal(
    failures.join(" ").includes("private provider credential"),
    false,
  );
});

test("Spectrum space.send failures propagate for transport-level error logging", async () => {
  const sendError = new Error("Spectrum delivery rejected");
  const handler = new PhotonMessageHandler(() => ({
    hasConversationHistory: false,
    async respond() {
      return "answer";
    },
  }));

  await assert.rejects(
    handler.handle(
      makeSpace("send-error", undefined, async () => {
        throw sendError;
      }),
      makeMessage({ type: "text", text: "Hello" }),
    ),
    (error) => error === sendError,
  );
});

test("Spectrum attaches researched images and sends plain text without Markdown syntax", async () => {
  const imageUrl =
    "https://upload.wikimedia.org/wikipedia/commons/a/aa/ronaldo.jpg";
  const imageBytes = Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01,
  ]);
  const sent: ContentInput[] = [];
  const failures: string[] = [];
  const handler = new PhotonMessageHandler(
    () => ({
      hasConversationHistory: false,
      async respond() {
        return [
          `![Cristiano Ronaldo](${imageUrl})`,
          "",
          "### Career Milestones",
          "- **Real Madrid:** *450 goals*.",
        ].join("\n");
      },
    }),
    (message) => failures.push(message),
    undefined,
    async (url) => {
      assert.equal(url, imageUrl);
      return { bytes: imageBytes, mimeType: "image/png" };
    },
  );

  await handler.handle(
    makeSpace("research-image", undefined, async (content) => {
      sent.push(content);
      return undefined;
    }),
    makeMessage({ type: "text", text: "Research Cristiano Ronaldo" }),
  );

  assert.equal(sent.length, 2);
  const imageContent = sent[0];
  if (!imageContent || typeof imageContent === "string") {
    throw new Error("Expected the researched image to be sent as an attachment.");
  }
  const built = await imageContent.build();
  assert.equal(built.type, "attachment");
  if (built.type !== "attachment") return;
  assert.equal(built.name, "mira-research-image.png");
  assert.equal(built.mimeType, "image/png");
  assert.deepEqual(await built.read(), imageBytes);
  assert.equal(
    sent[1],
    "Career Milestones\n• Real Madrid: 450 goals.",
  );
  assert.deepEqual(failures, []);
});

test("Spectrum replaces a failed researched-image attachment with a clean text note", async () => {
  const sent: ContentInput[] = [];
  const failures: string[] = [];
  const handler = new PhotonMessageHandler(
    () => ({
      hasConversationHistory: false,
      async respond() {
        return [
          "![Cristiano Ronaldo](https://upload.wikimedia.org/wikipedia/commons/a/aa/ronaldo.jpg)",
          "### Career",
          "He scored **many goals**.",
        ].join("\n");
      },
    }),
    (message) => failures.push(message),
    undefined,
    async () => {
      throw new Error("private fetch detail");
    },
  );

  await handler.handle(
    makeSpace("research-image-failure", undefined, async (content) => {
      sent.push(content);
      return undefined;
    }),
    makeMessage({ type: "text", text: "Research Cristiano Ronaldo" }),
  );

  assert.deepEqual(sent, [
    "Image unavailable: Cristiano Ronaldo\n\nCareer\nHe scored many goals.",
  ]);
  assert.deepEqual(failures, [
    "Muse could not attach a sourced image to an incoming Spectrum message.",
  ]);
  assert.doesNotMatch(String(sent[0]), /!\[|\]\(|[#*]/);
  assert.doesNotMatch(failures.join(" "), /private fetch detail/);
});
