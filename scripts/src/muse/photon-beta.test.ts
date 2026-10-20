import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  PHOTON_BETA_FAILURE_REPLY,
  PhotonBetaMessageHandler,
  parsePhotonBetaMessage,
  readPhotonBetaConfiguration,
  type PhotonBetaReply,
} from "./photon-beta.js";
import { sendPhotonBetaReply } from "./photon-beta-api.js";
import {
  IMAGE_GENERATION_SUCCESS_REPLY,
  IMAGE_GENERATION_UNAVAILABLE_REPLY,
  IMAGE_GENERATION_USAGE_REPLY,
} from "./image-generation-command.js";
import { PhotonCursorStore } from "./photon-cursor-store.js";
import {
  defaultPhotonCursorPath,
  photonEventSocketOptions,
  photonWebhookAcknowledgement,
} from "./photon-beta-transport.js";
import { selectMusePhotonTransport } from "./photon-transport-selection.js";

const projectId = "pho_prj_test-project";
const configuration = { projectId, apiKey: "photon-unit-test-key" };

function incomingEvent(
  options: {
    eventId?: string;
    messageId?: string;
    spaceId?: string;
    senderId?: string;
    text?: string;
    project?: string;
    platform?: string;
  } = {},
) {
  return {
    id: options.eventId ?? "pho_evt_message-one",
    type: "message.received",
    apiVersion: "2026-07-01",
    source: "imessage.photon",
    timestamp: "2026-10-17T12:00:00Z",
    data: {
      projectId: options.project ?? projectId,
      object: {
        id: options.messageId ?? "pho_msg_message-one",
        platform: options.platform ?? "imessage",
        status: "received",
        space: {
          id: options.spaceId ?? "pho_spc_alice",
          platform: options.platform ?? "imessage",
          kind: "direct",
        },
        sentBy: { id: "pho_usr_human", kind: "human", platform: "imessage" },
        receivedBy: {
          id: options.senderId ?? "pho_usr_agent",
          kind: "agent",
          platform: "imessage",
        },
        content: {
          type: "text",
          format: "plain",
          text: options.text ?? "What is a compiler?",
        },
      },
    },
  };
}

test("Photon Beta configuration requires only project ID and API key", () => {
  assert.deepEqual(
    readPhotonBetaConfiguration({
      PHOTON_PROJECT_ID: "  project  ",
      PHOTON_API_KEY: "  key  ",
    }),
    { projectId: "project", apiKey: "key" },
  );
  assert.throws(
    () => readPhotonBetaConfiguration({}),
    /PHOTON_PROJECT_ID and PHOTON_API_KEY/,
  );
  assert.throws(
    () => readPhotonBetaConfiguration({ PHOTON_PROJECT_ID: "project" }),
    /PHOTON_API_KEY/,
  );
});

test("Photon Beta websocket options use the documented project endpoint and bearer key", () => {
  assert.deepEqual(photonEventSocketOptions(configuration), {
    path: `/v1/projects/${projectId}/events/ws`,
    addTrailingSlash: false,
    transports: ["websocket"],
    extraHeaders: { Authorization: `Bearer ${configuration.apiKey}` },
    autoConnect: false,
  });
  assert.match(defaultPhotonCursorPath(projectId), /muse-photon-beta/);
});

test("Photon acknowledges only expected webhook replies with the documented response shape", () => {
  assert.deepEqual(photonWebhookAcknowledgement("pho_evt_webhook"), {
    eventId: "pho_evt_webhook",
    status: 200,
    headers: { "content-type": "text/plain" },
    body: Buffer.from("accepted").toString("base64"),
  });
});

test("Photon parser selects plain-text inbound iMessage events and ignores other event kinds", () => {
  assert.deepEqual(parsePhotonBetaMessage(incomingEvent(), projectId), {
    eventId: "pho_evt_message-one",
    messageId: "pho_msg_message-one",
    spaceId: "pho_spc_alice",
    senderId: "pho_usr_agent",
    text: "What is a compiler?",
  });
  assert.equal(
    parsePhotonBetaMessage(
      { id: "pho_evt_other", type: "message.sent" },
      projectId,
    ),
    undefined,
  );
  assert.equal(
    parsePhotonBetaMessage(incomingEvent({ platform: "telegram" }), projectId),
    undefined,
  );
  assert.equal(
    parsePhotonBetaMessage(incomingEvent({ text: "   " }), projectId),
    undefined,
  );
  assert.throws(
    () =>
      parsePhotonBetaMessage(incomingEvent({ project: "other" }), projectId),
    /unexpected project/,
  );
  assert.throws(
    () => parsePhotonBetaMessage({ type: "message.received" }, projectId),
    /event ID/,
  );
});

test("Photon routes explicit image commands to Cloudflare instead of the chat model", async () => {
  let modelCalls = 0;
  const prompts: string[] = [];
  const replies: PhotonBetaReply[] = [];
  const generatedImage = {
    bytes: Buffer.from([0x89, 0x50, 0x4e, 0x47]),
    mimeType: "image/png" as const,
  };
  const handler = new PhotonBetaMessageHandler(
    projectId,
    () => ({
      hasConversationHistory: false,
      async respond() {
        modelCalls += 1;
        return "This must not handle an image command.";
      },
    }),
    async (reply) => {
      replies.push(reply);
    },
    undefined,
    async (prompt) => {
      prompts.push(prompt);
      return generatedImage;
    },
  );

  assert.equal(
    await handler.handle(
      incomingEvent({
        text: "Generate an image of a fox under the northern lights",
      }),
    ),
    true,
  );
  assert.deepEqual(prompts, ["a fox under the northern lights"]);
  assert.equal(modelCalls, 0);
  assert.equal(replies[0]?.text, IMAGE_GENERATION_SUCCESS_REPLY);
  assert.deepEqual(replies[0]?.image, generatedImage);
});

test("Photon does not send an image command without a prompt to either model", async () => {
  let modelCalls = 0;
  let imageCalls = 0;
  const replies: PhotonBetaReply[] = [];
  const handler = new PhotonBetaMessageHandler(
    projectId,
    () => ({
      hasConversationHistory: false,
      async respond() {
        modelCalls += 1;
        return "chat reply";
      },
    }),
    async (reply) => {
      replies.push(reply);
    },
    undefined,
    async () => {
      imageCalls += 1;
      return { bytes: Buffer.from("image"), mimeType: "image/png" };
    },
  );

  await handler.handle(incomingEvent({ text: "generate image" }));
  assert.equal(modelCalls, 0);
  assert.equal(imageCalls, 0);
  assert.equal(replies[0]?.text, IMAGE_GENERATION_USAGE_REPLY);
  assert.equal(replies[0]?.image, undefined);
});

test("Photon reports a Cloudflare image-generation failure without falling back to chat", async () => {
  let modelCalls = 0;
  const failures: string[] = [];
  const replies: PhotonBetaReply[] = [];
  const handler = new PhotonBetaMessageHandler(
    projectId,
    () => ({
      hasConversationHistory: false,
      async respond() {
        modelCalls += 1;
        return "This must not handle the failed image command.";
      },
    }),
    async (reply) => {
      replies.push(reply);
    },
    (failure) => failures.push(failure),
    async () => {
      throw new Error("private Cloudflare token");
    },
  );

  await handler.handle(
    incomingEvent({ text: "generate image: a glass greenhouse" }),
  );
  assert.equal(modelCalls, 0);
  assert.equal(replies[0]?.text, IMAGE_GENERATION_UNAVAILABLE_REPLY);
  assert.equal(replies[0]?.image, undefined);
  assert.deepEqual(failures, [
    "Muse could not generate an image for an incoming iMessage.",
  ]);
  assert.doesNotMatch(failures.join(" "), /private Cloudflare token/);
});

test("Photon keeps ordinary messages on the existing chat model path", async () => {
  let modelCalls = 0;
  let imageCalls = 0;
  const replies: PhotonBetaReply[] = [];
  const handler = new PhotonBetaMessageHandler(
    projectId,
    () => ({
      hasConversationHistory: false,
      async respond(text) {
        modelCalls += 1;
        return `chat:${text}`;
      },
    }),
    async (reply) => {
      replies.push(reply);
    },
    undefined,
    async () => {
      imageCalls += 1;
      return { bytes: Buffer.from("image"), mimeType: "image/png" };
    },
  );

  await handler.handle(
    incomingEvent({ text: "How does image generation work?" }),
  );
  assert.equal(modelCalls, 1);
  assert.equal(imageCalls, 0);
  assert.equal(replies[0]?.text, "chat:How does image generation work?");
  assert.equal(replies[0]?.image, undefined);
});

test("Photon replies isolate conversations and ignore duplicate event delivery", async () => {
  const histories = new Map<string, string[]>();
  const replies: PhotonBetaReply[] = [];
  const handler = new PhotonBetaMessageHandler(
    projectId,
    (spaceKey) => {
      const history: string[] = [];
      histories.set(spaceKey, history);
      return {
        get hasConversationHistory() {
          return history.length > 0;
        },
        async respond(text: string) {
          history.push(text);
          return `${spaceKey} response ${history.length}`;
        },
      };
    },
    async (reply) => {
      replies.push(reply);
    },
  );

  assert.equal(await handler.handle(incomingEvent()), true);
  assert.equal(await handler.handle(incomingEvent()), false);
  assert.equal(
    await handler.handle(
      incomingEvent({
        eventId: "pho_evt_bob",
        messageId: "pho_msg_bob",
        spaceId: "pho_spc_bob",
        text: "Hello",
      }),
    ),
    true,
  );
  assert.equal(
    await handler.handle(
      incomingEvent({
        eventId: "pho_evt_alice-two",
        messageId: "pho_msg_alice-two",
        text: "Why?",
      }),
    ),
    true,
  );

  assert.equal(handler.conversationCount, 2);
  assert.deepEqual(histories.get("imessage:pho_spc_alice"), [
    "What is a compiler?",
    "Why?",
  ]);
  assert.deepEqual(histories.get("imessage:pho_spc_bob"), ["Hello"]);
  assert.deepEqual(
    replies.map(({ spaceId, text }) => [spaceId, text]),
    [
      ["pho_spc_alice", "imessage:pho_spc_alice response 1"],
      ["pho_spc_bob", "imessage:pho_spc_bob response 1"],
      ["pho_spc_alice", "imessage:pho_spc_alice response 2"],
    ],
  );
});

test("Photon handles concurrent duplicate deliveries once and sends the generated answer", async () => {
  let modelCalls = 0;
  const replies: PhotonBetaReply[] = [];
  const handler = new PhotonBetaMessageHandler(
    projectId,
    () => ({
      hasConversationHistory: false,
      async respond() {
        modelCalls += 1;
        await Promise.resolve();
        return "Successful response";
      },
    }),
    async (reply) => {
      replies.push(reply);
    },
  );

  const event = incomingEvent();
  const results = await Promise.all([
    handler.handle(event),
    handler.handle(event),
  ]);
  assert.deepEqual(results, [true, true]);
  assert.equal(modelCalls, 1);
  assert.equal(replies.length, 1);
  assert.equal(replies[0]?.text, "Successful response");
  assert.equal(replies[0]?.messageId, "pho_msg_message-one");
  assert.equal(replies[0]?.senderId, "pho_usr_agent");
});

test("Photon model errors produce a safe user reply without exposing exception details", async () => {
  const failures: string[] = [];
  const replies: PhotonBetaReply[] = [];
  const handler = new PhotonBetaMessageHandler(
    projectId,
    () => ({
      hasConversationHistory: false,
      async respond() {
        throw new Error("private provider credential");
      },
    }),
    async (reply) => {
      replies.push(reply);
    },
    (message) => failures.push(message),
  );

  assert.equal(await handler.handle(incomingEvent()), true);
  assert.deepEqual(
    replies.map((reply) => reply.text),
    [PHOTON_BETA_FAILURE_REPLY],
  );
  assert.deepEqual(failures, ["Muse could not complete an incoming iMessage."]);
  assert.doesNotMatch(failures.join(" "), /private provider credential/);
});

test("Photon reuses a generated reply when an outbound send must be retried", async () => {
  let modelCalls = 0;
  let sendAttempts = 0;
  const handler = new PhotonBetaMessageHandler(
    projectId,
    () => ({
      hasConversationHistory: false,
      async respond() {
        modelCalls += 1;
        return "Cached response";
      },
    }),
    async () => {
      sendAttempts += 1;
      if (sendAttempts === 1) throw new Error("temporary API failure");
    },
  );

  await assert.rejects(
    handler.handle(incomingEvent()),
    /temporary API failure/,
  );
  assert.equal(await handler.handle(incomingEvent()), true);
  assert.equal(modelCalls, 1);
  assert.equal(sendAttempts, 2);
});

test("Photon reuses generated image bytes when an outbound attachment delivery is retried", async () => {
  let generationCalls = 0;
  let sendAttempts = 0;
  const sentReplies: PhotonBetaReply[] = [];
  const image = {
    bytes: Buffer.from([0x89, 0x50, 0x4e, 0x47]),
    mimeType: "image/png" as const,
  };
  const handler = new PhotonBetaMessageHandler(
    projectId,
    () => ({
      hasConversationHistory: false,
      async respond() {
        return "unused";
      },
    }),
    async (reply) => {
      sendAttempts += 1;
      if (sendAttempts === 1) throw new Error("temporary Photon failure");
      sentReplies.push(reply);
    },
    undefined,
    async () => {
      generationCalls += 1;
      return image;
    },
  );
  const event = incomingEvent({ text: "generate image: a paper kite" });

  await assert.rejects(handler.handle(event), /temporary Photon failure/);
  assert.equal(await handler.handle(event), true);
  assert.equal(generationCalls, 1);
  assert.equal(sendAttempts, 2);
  assert.deepEqual(sentReplies[0]?.image, image);
});

test("Photon retries failed message submission with a stable idempotency key and exact payload", async () => {
  let attempts = 0;
  const sleeps: number[] = [];
  let requestUrl = "";
  let requestInit: RequestInit | undefined;
  await sendPhotonBetaReply(
    configuration,
    {
      messageId: "pho_msg_parent",
      spaceId: "pho_spc_space",
      senderId: "pho_usr_agent",
      text: "Plain text reply",
    },
    {
      fetchImplementation: async (url, init) => {
        attempts += 1;
        requestUrl = String(url);
        requestInit = init;
        if (attempts === 1) {
          return new Response("{}", {
            status: 429,
            headers: { "Retry-After": "0" },
          });
        }
        return new Response("{}", { status: 202 });
      },
      sleep: async (milliseconds) => {
        sleeps.push(milliseconds);
      },
    },
  );

  assert.equal(attempts, 2);
  assert.deepEqual(sleeps, [0]);
  assert.equal(
    requestUrl,
    `https://api.photon.codes/v1/projects/${projectId}/messages`,
  );
  assert.deepEqual(Object.fromEntries(new Headers(requestInit?.headers)), {
    authorization: `Bearer ${configuration.apiKey}`,
    "content-type": "application/json",
    "idempotency-key": "muse-reply:pho_msg_parent",
  });
  assert.deepEqual(JSON.parse(String(requestInit?.body)), {
    spaceId: "pho_spc_space",
    senderId: "pho_usr_agent",
    parentMessageId: "pho_msg_parent",
    content: { type: "text", format: "plain", text: "Plain text reply" },
  });
});

test("Photon uploads generated image bytes and sends an iMessage attachment reply", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const sleeps: number[] = [];
  const imageBytes = Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01, 0x02,
  ]);
  const attachmentId = "pho_att_01arz3ndektsv4rrffq69g5fav";

  await sendPhotonBetaReply(
    configuration,
    {
      messageId: "pho_msg_image-request",
      spaceId: "pho_spc_space",
      senderId: "pho_usr_agent",
      text: IMAGE_GENERATION_SUCCESS_REPLY,
      image: { bytes: imageBytes, mimeType: "image/png" },
    },
    {
      fetchImplementation: async (url, init) => {
        calls.push({ url: String(url), init });
        if (String(url).endsWith("/attachments")) {
          if (calls.length === 1) {
            return new Response("{}", {
              status: 429,
              headers: { "Retry-After": "0" },
            });
          }
          return new Response(JSON.stringify({ id: attachmentId }), {
            status: 201,
            headers: { "content-type": "application/json" },
          });
        }
        return new Response("{}", { status: 202 });
      },
      sleep: async (milliseconds) => {
        sleeps.push(milliseconds);
      },
    },
  );

  assert.equal(calls.length, 3);
  assert.deepEqual(sleeps, [0]);
  assert.equal(
    calls[0]?.url,
    `https://api.photon.codes/v1/projects/${projectId}/attachments`,
  );
  assert.equal(calls[1]?.url, calls[0]?.url);
  assert.equal(
    calls[2]?.url,
    `https://api.photon.codes/v1/projects/${projectId}/messages`,
  );

  const firstUploadHeaders = new Headers(calls[0]?.init?.headers);
  const secondUploadHeaders = new Headers(calls[1]?.init?.headers);
  assert.equal(
    firstUploadHeaders.get("authorization"),
    `Bearer ${configuration.apiKey}`,
  );
  assert.match(
    firstUploadHeaders.get("content-type") ?? "",
    /^multipart\/related;/,
  );
  assert.equal(
    firstUploadHeaders.get("idempotency-key"),
    "muse-image:pho_msg_image-request",
  );
  assert.equal(
    secondUploadHeaders.get("idempotency-key"),
    firstUploadHeaders.get("idempotency-key"),
  );

  const firstUploadBody = Buffer.from(calls[0]?.init?.body as Uint8Array);
  const secondUploadBody = Buffer.from(calls[1]?.init?.body as Uint8Array);
  assert.deepEqual(secondUploadBody, firstUploadBody);
  assert.equal(
    firstUploadHeaders.get("content-length"),
    String(firstUploadBody.byteLength),
  );
  assert.notEqual(firstUploadBody.indexOf(imageBytes), -1);
  const multipartText = firstUploadBody.toString("latin1");
  assert.match(multipartText, /"contentType":"image\/png"/);
  assert.match(
    multipartText,
    new RegExp(`"sizeBytes":${imageBytes.byteLength}`),
  );
  const boundary = firstUploadHeaders
    .get("content-type")
    ?.match(/boundary="?([^";]+)"?/)?.[1];
  assert.ok(boundary);
  assert.ok(multipartText.startsWith(`--${boundary}\r\n`));

  assert.deepEqual(Object.fromEntries(new Headers(calls[2]?.init?.headers)), {
    authorization: `Bearer ${configuration.apiKey}`,
    "content-type": "application/json",
    "idempotency-key": "muse-reply:pho_msg_image-request",
  });
  assert.deepEqual(JSON.parse(String(calls[2]?.init?.body)), {
    spaceId: "pho_spc_space",
    senderId: "pho_usr_agent",
    parentMessageId: "pho_msg_image-request",
    content: {
      type: "group",
      parts: [
        { type: "text", format: "plain", text: IMAGE_GENERATION_SUCCESS_REPLY },
        { type: "attachment", attachmentId },
      ],
    },
  });
});

test("Photon rejects malformed generated-image uploads without sending a message", async () => {
  let calls = 0;
  await assert.rejects(
    sendPhotonBetaReply(
      configuration,
      {
        messageId: "pho_msg_image-request",
        spaceId: "pho_spc_space",
        senderId: "pho_usr_agent",
        text: IMAGE_GENERATION_SUCCESS_REPLY,
        image: { bytes: Buffer.alloc(0), mimeType: "image/png" },
      },
      {
        fetchImplementation: async () => {
          calls += 1;
          return new Response("{}", { status: 202 });
        },
        sleep: async () => {},
      },
    ),
    /generated image cannot be uploaded/i,
  );
  assert.equal(calls, 0);
});

test("Photon reports non-retryable API failures and exhausted rate limits safely", async () => {
  await assert.rejects(
    sendPhotonBetaReply(
      configuration,
      {
        messageId: "message",
        spaceId: "space",
        senderId: "sender",
        text: "reply",
      },
      {
        fetchImplementation: async () =>
          new Response("private key", { status: 401 }),
        sleep: async () => {},
      },
    ),
    /credentials.*401/,
  );

  let attempts = 0;
  await assert.rejects(
    sendPhotonBetaReply(
      configuration,
      {
        messageId: "message",
        spaceId: "space",
        senderId: "sender",
        text: "reply",
      },
      {
        fetchImplementation: async () => {
          attempts += 1;
          return new Response("private key", { status: 429 });
        },
        sleep: async () => {},
      },
    ),
    /rate limit.*429/,
  );
  assert.equal(attempts, 3);
});

test("Photon cursor state persists safely and rejects malformed cursor files", async () => {
  const directory = await mkdtemp(join(tmpdir(), "muse-photon-cursor-"));
  const filename = join(directory, "cursor.json");
  try {
    const store = new PhotonCursorStore(filename);
    assert.deepEqual(await store.load(), { cursor: 0, eventIds: [] });
    await store.save({ cursor: 12, eventIds: ["pho_evt_one"] });
    assert.deepEqual(await store.load(), {
      cursor: 12,
      eventIds: ["pho_evt_one"],
    });
    await writeFile(filename, "{", "utf8");
    await assert.rejects(store.load(), /invalid JSON/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Photon selects Beta by default and keeps Spectrum as an explicit legacy option", () => {
  assert.equal(selectMusePhotonTransport(undefined), "photon2");
  assert.equal(selectMusePhotonTransport(" spectrum "), "spectrum");
  assert.throws(
    () => selectMusePhotonTransport("unknown"),
    /Choose "photon2" or "spectrum"/,
  );
});
