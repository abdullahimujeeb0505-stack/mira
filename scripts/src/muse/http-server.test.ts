import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type {
  TextGenerationProvider,
  TextGenerationRequest,
} from "./llm-provider.js";
import { createMuseHttpServer } from "./http-server.js";

const testSessionSecret = "muse-http-session-test-secret";
const testAccessToken =
  "muse-test-access-code-with-more-than-thirty-two-bytes-0123456789";

async function withServer(
  providerFactory: () => TextGenerationProvider,
  run: (baseUrl: string, memoryDirectory: string) => Promise<void>,
  accessToken: string | null = testAccessToken,
  sharedMemoryPath?: string,
): Promise<void> {
  const memoryDirectory = await mkdtemp(join(tmpdir(), "muse-http-test-"));
  const server = createMuseHttpServer({
    sessionSecret: testSessionSecret,
    accessToken: accessToken ?? "",
    memoryDirectory,
    ...(sharedMemoryPath ? { sharedMemoryPath } : {}),
    providerFactory,
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("The test server did not bind to a TCP port.");
  }
  try {
    await run(`http://127.0.0.1:${address.port}`, memoryDirectory);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
    await rm(memoryDirectory, { recursive: true, force: true });
  }
}

function getSessionCookie(response: Response): string {
  const cookie = response.headers.get("set-cookie")?.split(";")[0];
  assert.ok(cookie);
  return cookie;
}

async function sendMessage(
  baseUrl: string,
  message: string,
  cookie?: string,
  accessToken: string | null = testAccessToken,
): Promise<Response> {
  return fetch(`${baseUrl}/api/chat`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(accessToken !== null
        ? { Authorization: `Bearer ${accessToken}` }
        : {}),
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body: JSON.stringify({ message }),
  });
}

test("Muse serves the chat page with same-origin security headers", async () =>
  withServer(
    () => ({ generateText: async () => "unused" }),
    async (baseUrl) => {
      const response = await fetch(baseUrl);
      assert.equal(response.status, 200);
      const html = await response.text();
      assert.match(html, /What are you working on\?/);
      assert.equal(response.headers.get("cache-control"), "no-store");
      assert.equal(response.headers.get("x-content-type-options"), "nosniff");
      assert.equal(response.headers.get("content-security-policy")?.includes("connect-src 'self'"), true);
      assert.match(html, /access-code/);
    },
  ));

test("Muse chat works locally without an access code", async () => {
  let providerCreations = 0;
  const providerFactory = () => {
    providerCreations += 1;
    return { generateText: async () => "authorized reply" };
  };

  await withServer(
    providerFactory,
    async (baseUrl) => {
      const response = await sendMessage(baseUrl, "Hello Muse", undefined, null);
      assert.equal(response.status, 200);
      const body = (await response.json()) as { reply: string };
      assert.equal(body.reply, "authorized reply");
    },
    null,
  );

  assert.equal(providerCreations, 1);
});

test("Muse keeps conversation histories isolated by signed browser session", async () => {
  const conversationsBySession: TextGenerationRequest[][] = [];
  let providerNumber = 0;

  await withServer(
    () => {
      const sessionNumber = ++providerNumber;
      conversationsBySession.push([]);
      return {
        generateText: async (request) => {
          conversationsBySession[sessionNumber - 1].push({
            ...request,
            conversation: request.conversation.map((message) => ({ ...message })),
          });
          return `reply-${sessionNumber}`;
        },
      };
    },
    async (baseUrl) => {
      const aliceFirst = await sendMessage(baseUrl, "Alice's first message");
      assert.equal(aliceFirst.status, 200);
      const aliceCookie = getSessionCookie(aliceFirst);
      assert.match(aliceFirst.headers.get("set-cookie") ?? "", /HttpOnly/);
      assert.match(aliceFirst.headers.get("set-cookie") ?? "", /SameSite=Strict/);
      assert.deepEqual(await aliceFirst.json(), { reply: "reply-1" });

      const bobFirst = await sendMessage(baseUrl, "Bob's first message");
      assert.equal(bobFirst.status, 200);
      const bobCookie = getSessionCookie(bobFirst);
      assert.notEqual(aliceCookie, bobCookie);
      assert.deepEqual(await bobFirst.json(), { reply: "reply-2" });

      const aliceSecond = await sendMessage(
        baseUrl,
        "Alice's follow-up",
        aliceCookie,
      );
      assert.equal(aliceSecond.status, 200);
      assert.deepEqual(await aliceSecond.json(), { reply: "reply-1" });

      assert.deepEqual(
        conversationsBySession[0][1].conversation.map(
          ({ role, content }) => [role, content],
        ),
        [
          ["user", "Alice's first message"],
          ["assistant", "reply-1"],
          ["user", "Alice's follow-up"],
        ],
      );
      assert.deepEqual(
        conversationsBySession[1][0].conversation.map(
          ({ role, content }) => [role, content],
        ),
        [["user", "Bob's first message"]],
      );

      const [cookieName, cookieValue] = aliceCookie.split("=");
      const [sessionId, signature] = cookieValue.split(".");
      const alteredSignature =
        (signature[0] === "0" ? "1" : "0") + signature.slice(1);
      const forgedResponse = await sendMessage(
        baseUrl,
        "This must start a new session",
        `${cookieName}=${sessionId}.${alteredSignature}`,
      );
      assert.equal(forgedResponse.status, 200);
      assert.notEqual(getSessionCookie(forgedResponse), aliceCookie);
      assert.equal(providerNumber, 3);
      assert.deepEqual(
        conversationsBySession[2][0].conversation.map(
          ({ role, content }) => [role, content],
        ),
        [["user", "This must start a new session"]],
      );
    },
  );
});

test("each browser session persists memories in a separate file", async () =>
  withServer(
    () => ({ generateText: async () => "Noted." }),
    async (baseUrl, memoryDirectory) => {
      const aliceMessage =
        "Please remember that I prefer low-risk launches.";
      const bobMessage =
        "Please remember that I prefer rapid experiments.";
      const aliceResponse = await sendMessage(baseUrl, aliceMessage);
      assert.equal(aliceResponse.status, 200);
      const aliceCookie = getSessionCookie(aliceResponse);
      const bobResponse = await sendMessage(baseUrl, bobMessage);
      assert.equal(bobResponse.status, 200);
      assert.notEqual(getSessionCookie(bobResponse), aliceCookie);

      const memoryFiles = await readdir(memoryDirectory);
      assert.equal(memoryFiles.length, 2);
      const memories = await Promise.all(
        memoryFiles.map(async (fileName) => ({
          fileName,
          contents: await readFile(join(memoryDirectory, fileName), "utf8"),
        })),
      );
      const aliceMemory = memories.find(({ contents }) =>
        contents.includes(aliceMessage),
      );
      const bobMemory = memories.find(({ contents }) =>
        contents.includes(bobMessage),
      );

      assert.ok(aliceMemory);
      assert.ok(bobMemory);
      assert.notEqual(aliceMemory.fileName, bobMemory.fileName);
      assert.equal(aliceMemory.contents.includes(bobMessage), false);
      assert.equal(bobMemory.contents.includes(aliceMessage), false);
    },
  ));


test("browser sessions can recall shared profile memories", async () => {
  const root = await mkdtemp(join(tmpdir(), "muse-shared-profile-test-"));
  const sharedMemoryPath = join(root, "profile.json");
  const profileFact = "I study Pharmacy and prefer concise practical explanations.";
  await mkdir(root, { recursive: true });
  await writeFile(
    sharedMemoryPath,
    JSON.stringify([{
      id: "shared-profile-fact",
      category: "USER",
      content: profileFact,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }]),
    "utf8",
  );

  const capturedPrompts: string[] = [];
  try {
    await withServer(
      () => ({
        generateText: async (request: TextGenerationRequest) => {
          capturedPrompts.push(request.systemPrompt);
          return "Noted.";
        },
      }),
      async (baseUrl) => {
        const response = await sendMessage(baseUrl, "Can you help me study?");
        assert.equal(response.status, 200);
        assert.ok(capturedPrompts[0]?.includes(profileFact));
      },
      testAccessToken,
      sharedMemoryPath,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Muse rejects missing, empty, and oversized messages before creating a session", async () => {
  let providerCreations = 0;
  await withServer(
    () => {
      providerCreations += 1;
      return { generateText: async () => "unused" };
    },
    async (baseUrl) => {
      const missing = await fetch(`${baseUrl}/api/chat`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${testAccessToken}`,
        },
        body: JSON.stringify({}),
      });
      assert.equal(missing.status, 400);

      const malformed = await fetch(`${baseUrl}/api/chat`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${testAccessToken}`,
        },
        body: '{"message":',
      });
      assert.equal(malformed.status, 400);

      const empty = await sendMessage(baseUrl, "   ");
      assert.equal(empty.status, 400);

      const oversized = await sendMessage(baseUrl, "x".repeat(4_001));
      assert.equal(oversized.status, 413);

      const oversizedBody = await fetch(`${baseUrl}/api/chat`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${testAccessToken}`,
        },
        body: JSON.stringify({
          message: "Hello",
          unused: "x".repeat(17 * 1_024),
        }),
      });
      assert.equal(oversizedBody.status, 413);
      assert.equal(providerCreations, 0);
    },
  );
});

test("Muse returns a generic configuration error without exposing provider details", async () =>
  withServer(
    () => {
      throw new Error("Provider failed with sensitive details");
    },
    async (baseUrl) => {
      const response = await sendMessage(baseUrl, "Hello");
      assert.equal(response.status, 503);
      const body = await response.text();
      assert.match(body, /model provider is not configured/i);
      assert.equal(body.includes("sensitive details"), false);
    },
  ));

test("Muse hides model-generation failures from the HTTP response", async () =>
  withServer(
    () => ({
      generateText: async () => {
        throw new Error("Sensitive provider response and credential details");
      },
    }),
    async (baseUrl) => {
      const response = await sendMessage(baseUrl, "Hello");
      assert.equal(response.status, 502);
      const body = await response.text();
      assert.match(body, /could not generate a reply/i);
      assert.equal(body.includes("credential details"), false);
    },
  ));
