import assert from "node:assert/strict";
import { ReadableStream } from "node:stream/web";
import test from "node:test";
import type { ContentInput } from "spectrum-ts";
import {
  PHOTON_FAILURE_REPLY,
  PhotonMessageHandler,
  type PhotonMessage,
  type PhotonMessageContent,
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
  content: PhotonMessageContent,
  options: {
    direction?: "inbound" | "outbound";
    platform?: string;
    onReact?: (emoji: "👍") => Promise<unknown> | unknown;
  } = {},
): PhotonMessage {
  return {
    content,
    direction: options.direction ?? "inbound",
    platform: options.platform ?? "imessage",
    sender: { id: "test-handle" },
    ...(options.onReact
      ? { react: async (emoji: "👍") => options.onReact?.(emoji) }
      : {}),
  };
}

test("Spectrum ignores outbound, unsupported-platform, reaction, and empty events", async () => {
  let agentCreations = 0;
  const reactions: string[] = [];
  const handler = new PhotonMessageHandler(() => {
    agentCreations += 1;
    return { hasConversationHistory: false, respond: async () => "reply" };
  });

  for (const message of [
    makeMessage({ type: "text", text: "echo" }, { direction: "outbound" }),
    makeMessage({ type: "text", text: "hello" }, { platform: "telegram" }),
    makeMessage({ type: "reaction" }, { onReact: (emoji) => reactions.push(emoji) }),
    makeMessage(
      { type: "text", text: "   " },
      { onReact: (emoji) => reactions.push(emoji) },
    ),
    makeMessage(
      { type: "audio" },
      { onReact: (emoji) => reactions.push(emoji) },
    ),
  ]) {
    assert.equal(await handler.handle(makeSpace("one"), message), "ignored");
  }

  assert.deepEqual(reactions, ["👍", "👍"]);
  assert.equal(agentCreations, 0);
  assert.equal(handler.conversationCount, 0);
});

test("Spectrum immediately adds a thumbs-up Tapback before handling an iMessage", async () => {
  const events: string[] = [];
  const handler = new PhotonMessageHandler(() => ({
    hasConversationHistory: false,
    async respond(message: string) {
      events.push(`respond:${message}`);
      return "Got it.";
    },
  }));

  const outcome = await handler.handle(
    makeSpace("receipt", undefined, async () => {
      events.push("send-reply");
      return undefined;
    }),
    makeMessage(
      { type: "text", text: "Hello" },
      { onReact: (emoji) => events.push(`react:${emoji}`) },
    ),
  );

  assert.equal(outcome, "replied");
  assert.deepEqual(events, ["react:👍", "respond:Hello", "send-reply"]);
});

test("Spectrum analyzes an inline image and passes its context to Muse", async () => {
  const imageBytes = Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01,
  ]);
  const events: string[] = [];
  const replies: string[] = [];
  const agentCalls: Array<{
    message: string;
    attachmentContext: string;
    hasImageAttachment: boolean;
  }> = [];
  let analysisQuestion = "";
  let typingSignals = 0;
  const handler = new PhotonMessageHandler(
    () => ({
      hasConversationHistory: false,
      async respond(
        message: string,
        attachmentContext = "",
        hasImageAttachment = false,
      ) {
        agentCalls.push({ message, attachmentContext, hasImageAttachment });
        events.push("agent");
        return "Research summary with sources.";
      },
    }),
    undefined,
    undefined,
    undefined,
    async (image, mimeType, question) => {
      assert.deepEqual(Buffer.from(image), imageBytes);
      assert.equal(mimeType, "image/png");
      analysisQuestion = question;
      events.push("analyze-image");
      return "The diagram is an action research cycle with four stages.";
    },
  );

  const outcome = await handler.handle(
    makeSpace(
      "inline-paper",
      () => typingSignals++,
      async (content) => {
        if (typeof content === "string") replies.push(content);
        return undefined;
      },
    ),
    makeMessage(
      {
        type: "group",
        items: [
          { content: { type: "text", text: "Make research on this paper." } },
          {
            content: {
              type: "attachment",
              name: "paper.png",
              mimeType: "image/png",
              size: imageBytes.length,
              stream: async () =>
                new ReadableStream<Uint8Array>({
                  start(controller) {
                    events.push("read-image");
                    controller.enqueue(imageBytes);
                    controller.close();
                  },
                }),
            },
          },
        ],
      },
      { onReact: (emoji) => events.push(`react:${emoji}`) },
    ),
  );

  assert.equal(outcome, "replied");
  assert.deepEqual(events, ["react:👍", "read-image", "analyze-image", "agent"]);
  assert.equal(typingSignals, 1);
  assert.deepEqual(replies, ["Research summary with sources."]);
  assert.equal(agentCalls.length, 1);
  assert.equal(agentCalls[0]?.message, "Make research on this paper.");
  assert.equal(agentCalls[0]?.hasImageAttachment, true);
  assert.match(agentCalls[0]?.attachmentContext ?? "", /visual analysis/);
  assert.match(
    agentCalls[0]?.attachmentContext ?? "",
    /action research cycle with four stages/,
  );
  assert.match(analysisQuestion, /research question, methods, findings/);
  assert.match(analysisQuestion, /Make research on this paper/);
});

test("Spectrum uses an image sent just before its research follow-up", async () => {
  const imageBytes = Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x02,
  ]);
  const agentCalls: Array<{
    message: string;
    attachmentContext: string;
    hasImageAttachment: boolean;
  }> = [];
  const analyzedQuestions: string[] = [];
  const reactions: string[] = [];
  const handler = new PhotonMessageHandler(
    () => ({
      hasConversationHistory: false,
      async respond(
        message: string,
        attachmentContext = "",
        hasImageAttachment = false,
      ) {
        agentCalls.push({ message, attachmentContext, hasImageAttachment });
        return "Handled.";
      },
    }),
    undefined,
    undefined,
    undefined,
    async (_image, _mimeType, question) => {
      analyzedQuestions.push(question);
      return "The image shows a research-cycle diagram.";
    },
  );
  const space = makeSpace("separate-paper");
  const imageMessage = makeMessage(
    {
      type: "attachment",
      name: "research-cycle.png",
      mimeType: "image/png",
      size: imageBytes.length,
      read: async () => imageBytes,
    },
    { onReact: (emoji) => reactions.push(emoji) },
  );

  assert.equal(await handler.handle(space, imageMessage), "attachment_stored");
  assert.deepEqual(analyzedQuestions, []);
  assert.equal(agentCalls.length, 0);

  assert.equal(
    await handler.handle(
      space,
      makeMessage({ type: "text", text: "What is photosynthesis?" }),
    ),
    "replied",
  );
  assert.equal(agentCalls[0]?.hasImageAttachment, false);
  assert.equal(analyzedQuestions.length, 0);

  assert.equal(
    await handler.handle(
      space,
      makeMessage(
        { type: "text", text: "Make research on this paper." },
        { onReact: (emoji) => reactions.push(emoji) },
      ),
    ),
    "replied",
  );
  assert.equal(analyzedQuestions.length, 1);
  assert.match(analyzedQuestions[0] ?? "", /Make research on this paper/);
  assert.equal(agentCalls[1]?.message, "Make research on this paper.");
  assert.equal(agentCalls[1]?.hasImageAttachment, true);
  assert.match(
    agentCalls[1]?.attachmentContext ?? "",
    /research-cycle diagram/,
  );
  assert.deepEqual(reactions, ["👍", "👍"]);
});

test("image-analysis failures are reported safely and Muse is told not to guess", async () => {
  const imageBytes = Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x03,
  ]);
  const failures: string[] = [];
  let attachmentContext = "";
  const handler = new PhotonMessageHandler(
    () => ({
      hasConversationHistory: false,
      async respond(_message: string, context = "") {
        attachmentContext = context;
        return "I could not inspect that image.";
      },
    }),
    (message) => failures.push(message),
    undefined,
    undefined,
    async () => {
      throw new Error("private Cloudflare credential detail");
    },
  );
  const space = makeSpace("analysis-failure");

  await handler.handle(
    space,
    makeMessage({
      type: "attachment",
      name: "paper.png",
      mimeType: "image/png",
      size: imageBytes.length,
      read: async () => imageBytes,
    }),
  );
  await handler.handle(
    space,
    makeMessage({ type: "text", text: "Research this paper." }),
  );

  assert.match(attachmentContext, /could not be inspected/);
  assert.match(attachmentContext, /Do not infer or invent visual details/);
  assert.deepEqual(failures, [
    "Muse could not analyze an incoming Spectrum image attachment.",
  ]);
  assert.doesNotMatch(failures.join(" "), /private Cloudflare credential detail/);
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
    "replied",
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
    "replied",
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
