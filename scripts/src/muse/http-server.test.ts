import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Script } from "node:vm";
import type {
  TextGenerationProvider,
  TextGenerationRequest,
} from "./llm-provider.js";
import {
  createMuseHttpServer,
  type MuseHttpServerOptions,
} from "./http-server.js";
import type { ResearchImage } from "./research-images.js";
import type { ResearchResult } from "./research-cli.js";
import {
  CloudflareAIConfigurationError,
  type MuseMediaProvider,
} from "./cloudflare-workers-ai.js";

const testSessionSecret = "muse-http-session-test-secret";

async function withServer(
  providerFactory: () => TextGenerationProvider,
  run: (baseUrl: string, memoryDirectory: string) => Promise<void>,
  sharedMemoryPath?: string,
  serverOptions: Partial<MuseHttpServerOptions> = {},
): Promise<void> {
  const memoryDirectory = await mkdtemp(join(tmpdir(), "muse-http-test-"));
  const server = createMuseHttpServer({
    ...serverOptions,
    researchImageFinder: serverOptions.researchImageFinder ?? (async () => []),
    sessionSecret: testSessionSecret,
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

type FakeElement = {
  tagName: string;
  children: FakeElement[];
  textContent: string;
  disabled: boolean;
  value: string;
  className?: string;
  type?: string;
  title?: string;
  href?: string;
  src?: string;
  alt?: string;
  loading?: string;
  referrerPolicy?: string;
  hidden: boolean;
  style: { height: string };
  scrollHeight: number;
  focused: boolean;
  attributes: Record<string, string>;
  dataset: Record<string, string>;
  listeners: Record<string, (event: any) => void | Promise<void>>;
  append(...elements: FakeElement[]): void;
  replaceChildren(...elements: FakeElement[]): void;
  setAttribute(name: string, value: string): void;
  addEventListener(
    name: string,
    listener: (event: any) => void | Promise<void>,
  ): void;
  scrollIntoView(): void;
  focus(): void;
  click(): void;
  requestSubmit(): void;
  contains(node: unknown): boolean;
};

function fakeElement(tagName: string): FakeElement {
  return {
    tagName,
    children: [],
    textContent: "",
    disabled: false,
    value: "",
    hidden: false,
    style: { height: "" },
    scrollHeight: 0,
    focused: false,
    attributes: {},
    dataset: {},
    listeners: {},
    append(...elements) {
      this.children.push(...elements);
    },
    replaceChildren(...elements) {
      this.children = [...elements];
    },
    setAttribute(name, value) {
      this.attributes[name] = value;
    },
    addEventListener(name, listener) {
      this.listeners[name] = listener;
    },
    scrollIntoView() {},
    focus() {
      this.focused = true;
    },
    click() {},
    requestSubmit() {
      void this.listeners.submit?.({ preventDefault() {} });
    },
    contains(node) {
      return node === this || this.children.includes(node as FakeElement);
    },
  };
}

async function sendMessage(
  baseUrl: string,
  message: string,
  cookie?: string,
): Promise<Response> {
  return fetch(`${baseUrl}/api/chat`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body: JSON.stringify({ message }),
  });
}

async function uploadAttachment(
  baseUrl: string,
  name: string,
  bytes: Uint8Array,
  mimeType: string,
  cookie?: string,
): Promise<Response> {
  return fetch(`${baseUrl}/api/attachments`, {
    method: "POST",
    headers: {
      "Content-Type": mimeType,
      "X-Muse-File-Name": encodeURIComponent(name),
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body: Buffer.from(bytes),
  });
}

async function sendMessageWithAttachments(
  baseUrl: string,
  message: string,
  attachmentIds: string[],
  cookie: string,
): Promise<Response> {
  return fetch(`${baseUrl}/api/chat`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Cookie: cookie,
    },
    body: JSON.stringify({ message, attachmentIds }),
  });
}

test("Muse serves the chat page with same-origin security headers", async () =>
  withServer(
    () => ({ generateText: async () => "unused" }),
    async (baseUrl) => {
      const response = await fetch(baseUrl);
      assert.equal(response.status, 200);
      const html = await response.text();
      const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
      assert.ok(script);
      assert.doesNotThrow(() => new Script(script));
      assert.match(html, /Mira — conversational assistant by Muse/);
      assert.match(html, /Muse assistant/);
      assert.match(html, /Hi, I’m Mira, Muse’s assistant/);
      assert.match(html, /Message to Mira/);
      assert.match(html, /<h1>Mira<\/h1>/);
      assert.match(html, /chat, brainstorm, ask a question, or request web research/i);
      assert.match(html, /id="attachment-menu-toggle"[^>]*aria-haspopup="menu"/);
      assert.match(html, /id="attachment-menu" role="menu"[^>]*hidden/);
      assert.match(html, /Attach photos or files/);
      assert.match(html, /Generate an image/);
      assert.match(html, /automatic research images have no source caption/);
      assert.match(html, /Generate an image only for new AI artwork/);
      assert.match(html, /id="attachment-files"/);
      assert.match(html, /id="voice-input" class="composer-icon"[^>]*aria-label="Dictate a message"/);
      assert.match(html, /aria-label="Send message"/);
      assert.match(html, /#attachment-menu\[hidden\]/);
      assert.match(html, /\.message\.you \{ align-self: flex-end/);
      assert.doesNotMatch(html, />Use microphone</);
      assert.doesNotMatch(html, />Create image</);
      assert.match(html, /SpeechRecognition/);
      assert.match(html, /speechSynthesis/);
      assert.match(html, /Read Mira's response aloud/);
      assert.match(html, /speak\.textContent = "🔊"/);
      assert.match(html, /api\/images\/generate/);
      assert.match(html, /URL\.createObjectURL/);
      assert.match(html, /Download image/);
      assert.match(html, /quota-limited Cloudflare Workers AI/);
      assert.match(html, /browser may use its own remote speech service/);
      assert.doesNotMatch(html, /Connect X|Web3 intern|authorizationUrl/i);
      assert.match(html, /function renderMarkdown/);
      assert.match(html, /document\.createElement\("table"\)/);
      assert.match(html, /document\.createElement\(ordered \? "ol" : "ul"\)/);
      assert.match(html, /url\.protocol === "https:" \|\| url\.protocol === "http:"/);
      assert.match(html, /table-layout: fixed/);
      assert.match(html, /word-break: normal/);
      assert.match(html, /overflow-wrap: break-word/);
      assert.match(html, /max-width: 100%; overflow-x: auto/);
      assert.match(
        response.headers.get("content-security-policy") ?? "",
        /img-src https:\/\/upload\.wikimedia\.org https:\/\/api\.openverse\.org/,
      );
      assert.doesNotMatch(html, /\.innerHTML\s*=/);
      assert.equal(response.headers.get("cache-control"), "no-store");
      assert.equal(response.headers.get("x-content-type-options"), "nosniff");
      assert.equal(response.headers.get("content-security-policy")?.includes("connect-src 'self'"), true);
      assert.doesNotMatch(html, /access-code|Chat access code|Bearer /i);
      assert.doesNotMatch(html, /localStorage|sessionStorage/);
    },
  ));

test("browser Markdown rendering handles sourced images and normalizes other Markdown", async () =>
  withServer(
    () => ({ generateText: async () => "unused" }),
    async (baseUrl) => {
      const response = await fetch(baseUrl);
      const html = await response.text();
      const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
      assert.ok(script);
      const document = {
        querySelector: () => fakeElement("input"),
        createElement: (tagName: string) => fakeElement(tagName),
        addEventListener() {},
        createTextNode: (text: string) => {
          const node = fakeElement("#text");
          node.textContent = text;
          return node;
        },
      };
      const sandbox = { document, URL, window: {}, navigator: { language: "en" } };
      new Script(
        `${script}\nglobalThis.renderMarkdownForTest = renderMarkdown;`,
      ).runInNewContext(sandbox);

      const root = fakeElement("div");
      (sandbox as typeof sandbox & {
        renderMarkdownForTest: (parent: FakeElement, text: string) => void;
      }).renderMarkdownForTest(
        root,
        [
          "# Article",
          "#### First section",
          "",
          "| Name | Code |",
          "| --- | --- |",
          "| Example | `a|b` |",
          "",
          "```ts",
          "const line = \"# not heading | ;\";",
          "```",
          "",
          "[Official guide](https://example.org/guide) [Flickr source](https://www.flickr.com/photos/example/1) (by Example photographer; license: [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/))",
          "",
          "![Butterfly](https://upload.wikimedia.org/wikipedia/commons/b/b0/Butterfly.jpg)",
          "",
          "![Flickr image](https://api.openverse.org/v1/images/00000000-0000-0000-0000-000000000000/thumb/)",
          "",
          "![Untrusted](https://example.com/image.jpg)",
        ].join("\n"),
      );

      assert.deepEqual(
        root.children.map((child) => child.tagName),
        ["h2", "h3", "table", "pre", "p", "p", "p", "p"],
      );
      const table = root.children[2];
      assert.ok(table);
      const body = table.children[1];
      assert.ok(body);
      assert.equal(body.children[0]?.children.length, 2);
      const inlineCode = body.children[0]?.children[1]?.children.find(
        (child) => child.tagName === "code",
      );
      assert.equal(inlineCode?.textContent, "a|b");
      assert.equal(
        root.children[3]?.children[0]?.textContent,
        "const line = \"# not heading | ;\";",
      );
      const sourceLink = root.children[4]?.children.find(
        (child) => child.tagName === "a",
      );
      assert.equal(sourceLink?.textContent, "Official guide");
      assert.equal(sourceLink?.href, "https://example.org/guide");
      const imageSourceLink = root.children[4]?.children.find(
        (child) => child.textContent === "Flickr source",
      );
      assert.equal(
        imageSourceLink?.href,
        "https://www.flickr.com/photos/example/1",
      );
      const licenseLink = root.children[4]?.children.find(
        (child) => child.textContent === "CC BY-SA 4.0",
      );
      assert.equal(
        licenseLink?.href,
        "https://creativecommons.org/licenses/by-sa/4.0/",
      );
      const image = root.children[5]?.children.find((child) => child.tagName === "img");
      assert.equal(image?.src, "https://upload.wikimedia.org/wikipedia/commons/b/b0/Butterfly.jpg");
      assert.equal(image?.alt, "Butterfly");
      const openverseImage = root.children[6]?.children.find(
        (child) => child.tagName === "img",
      );
      assert.equal(
        openverseImage?.src,
        "https://api.openverse.org/v1/images/00000000-0000-0000-0000-000000000000/thumb/",
      );
      assert.equal(
        root.children[7]?.children.some((child) => child.tagName === "img"),
        false,
      );

      const imageFirstRoot = fakeElement("div");
      (
        sandbox as typeof sandbox & {
          renderMarkdownForTest: (parent: FakeElement, text: string) => void;
        }
      ).renderMarkdownForTest(
        imageFirstRoot,
        [
          "### Images",
          "",
          "![Donald Trump portrait](https://upload.wikimedia.org/wikipedia/commons/1/1a/Donald_Trump.jpg)",
          "",
          "[Donald Trump portrait — Wikimedia Commons](https://commons.wikimedia.org/wiki/File:Donald_Trump.jpg)",
          "",
          "# The story",
          "Donald Trump served as president.",
        ].join("\n"),
      );
      assert.deepEqual(
        imageFirstRoot.children.map((child) => child.tagName),
        ["h2", "p", "p", "h2", "p"],
      );
      assert.equal(
        imageFirstRoot.children[1]?.children.find((child) => child.tagName === "img")?.alt,
        "Donald Trump portrait",
      );
    },
  ));

test("a duplicate browser submit while a follow-up is pending sends and renders one response", async () =>
  withServer(
    () => ({ generateText: async () => "unused" }),
    async (baseUrl) => {
      const response = await fetch(baseUrl);
      const html = await response.text();
      const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
      assert.ok(script);
      const actionMenu = fakeElement("div");
      actionMenu.hidden = true;
      const elements = new Map<string, FakeElement>([
        ["#chat-form", fakeElement("form")],
        ["#message", fakeElement("textarea")],
        ["#send", fakeElement("button")],
        ["#messages", fakeElement("section")],
        ["#status", fakeElement("p")],
        ["#attachment-files", fakeElement("input")],
        ["#attachment-list", fakeElement("div")],
        ["#attachment-menu-toggle", fakeElement("button")],
        ["#attachment-menu", actionMenu],
        ["#attach", fakeElement("button")],
        ["#voice-input", fakeElement("button")],
        ["#generate-image", fakeElement("button")],
      ]);
      let documentClickHandler: ((event: { target: unknown }) => void) | undefined;
      const document = {
        querySelector: (selector: string) => elements.get(selector),
        createElement: (tagName: string) => fakeElement(tagName),
        addEventListener(name: string, listener: (event: any) => void) {
          if (name === "click") documentClickHandler = listener;
        },
        createTextNode: (text: string) => {
          const node = fakeElement("#text");
          node.textContent = text;
          return node;
        },
      };
      let resolveFetch: ((value: {
        ok: boolean;
        json(): Promise<{ reply: string }>;
      }) => void) | undefined;
      let fetchCalls = 0;
      const sandbox = {
        document,
        URL,
        window: {},
        navigator: { language: "en" },
        fetch: (_url: string) => {
          fetchCalls += 1;
          return new Promise<{
            ok: boolean;
            json(): Promise<{ reply: string }>;
          }>((resolve) => {
            resolveFetch = resolve;
          });
        },
      };
      new Script(script).runInNewContext(sandbox);

      const toggle = elements.get("#attachment-menu-toggle");
      const attach = elements.get("#attach");
      const generateImage = elements.get("#generate-image");
      const input = elements.get("#message");
      assert.ok(toggle && attach && generateImage && input);
      assert.equal(actionMenu.hidden, true);
      toggle.listeners.click?.({});
      assert.equal(actionMenu.hidden, false);
      assert.equal(toggle.attributes["aria-expanded"], "true");
      assert.equal(attach.focused, true);
      actionMenu.listeners.keydown?.({
        key: "ArrowDown",
        target: attach,
        preventDefault() {},
      });
      assert.equal(generateImage.focused, true);
      actionMenu.listeners.keydown?.({
        key: "Escape",
        target: generateImage,
        preventDefault() {},
      });
      assert.equal(actionMenu.hidden, true);
      assert.equal(toggle.attributes["aria-expanded"], "false");
      assert.equal(toggle.focused, true);

      toggle.listeners.click?.({});
      actionMenu.listeners.keydown?.({
        key: "ArrowDown",
        target: attach,
        preventDefault() {},
      });
      actionMenu.listeners.keydown?.({
        key: "Tab",
        target: generateImage,
        shiftKey: false,
        preventDefault() {},
      });
      assert.equal(actionMenu.hidden, true);
      assert.equal(input.focused, true);

      toggle.listeners.click?.({});
      let shiftTabPrevented = false;
      actionMenu.listeners.keydown?.({
        key: "Tab",
        target: attach,
        shiftKey: true,
        preventDefault() {
          shiftTabPrevented = true;
        },
      });
      assert.equal(shiftTabPrevented, true);
      assert.equal(actionMenu.hidden, true);
      assert.equal(toggle.focused, true);

      toggle.listeners.click?.({});
      documentClickHandler?.({ target: elements.get("#messages") });
      assert.equal(actionMenu.hidden, true);

      let enterSubmitted = 0;
      const form = elements.get("#chat-form");
      form!.requestSubmit = () => {
        enterSubmitted += 1;
      };
      let enterPrevented = false;
      input.listeners.keydown?.({
        key: "Enter",
        shiftKey: false,
        isComposing: false,
        preventDefault() {
          enterPrevented = true;
        },
      });
      assert.equal(enterSubmitted, 1);
      assert.equal(enterPrevented, true);
      input.listeners.keydown?.({
        key: "Enter",
        shiftKey: true,
        isComposing: false,
        preventDefault() {
          throw new Error("Shift+Enter should insert a line break.");
        },
      });
      assert.equal(enterSubmitted, 1);

      const messages = elements.get("#messages");
      const submit = form?.listeners.submit;
      assert.ok(input && messages && submit);
      input.value = "Why?";

      const firstSubmit = submit({ preventDefault() {} });
      await submit({ preventDefault() {} });
      assert.equal(fetchCalls, 1);
      assert.equal(messages.children.length, 1);

      resolveFetch?.({
        ok: true,
        json: async () => ({ reply: "The earlier evidence explains why." }),
      });
      await firstSubmit;

      assert.equal(messages.children.length, 2);
      assert.equal(fetchCalls, 1);
    },
  ));

test("chat page and API work without an access code", async () => {
  let providerCreations = 0;
  const providerFactory = () => {
    providerCreations += 1;
    return { generateText: async () => "Muse reply" };
  };

  await withServer(providerFactory, async (baseUrl) => {
    const page = await fetch(baseUrl);
    assert.equal(page.status, 200);
    assert.doesNotMatch(await page.text(), /access-code|Chat access code|Bearer /i);

    const malformed = await fetch(`${baseUrl}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not-json",
    });
    assert.equal(malformed.status, 400);
    assert.equal(providerCreations, 0);

    const response = await sendMessage(baseUrl, "Hello Muse");
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("www-authenticate"), null);
    assert.deepEqual(await response.json(), { reply: "Muse reply" });
    assert.equal(providerCreations, 1);
  });
});

test("chat API places a clean image before a topical research answer", async () => {
  const image: ResearchImage = {
    title: "Honeybee pollinating a flower",
    imageUrl:
      "https://api.openverse.org/v1/images/00000000-0000-0000-0000-000000000000/thumb/",
    pageUrl: "https://www.flickr.com/photos/example/1",
    creator: "Example photographer",
    license: "CC0 1.0",
    licenseUrl: "https://creativecommons.org/publicdomain/zero/1.0/",
    source: "Flickr",
  };
  const imageRequests: string[] = [];
  const researchResult: ResearchResult = {
    question: "What is pollination?",
    plan: {
      objective: "Explain pollination.",
      taskType: "general",
      deliverable: "A concise factual answer.",
      requiresCurrentInformation: false,
      sourcePreferences: [],
      questions: [],
      queries: [],
      unresolvedQuestions: [],
    },
    answer: "Pollination transfers pollen between flowers. [1]",
    sources: [{
      title: "Pollination guide",
      url: "https://example.org/pollination",
      retrievedAt: "2026-10-20T12:00:00.000Z",
      content: "Pollination transfers pollen between flowers.",
    }],
    unresolvedQuestions: [],
    contradictions: [],
    completeness: "supported",
    limitations: [],
    archive: { markdownPath: "/archive/research.md", jsonPath: "/archive/research.json" },
    retrieval: {
      candidateCount: 1,
      retrievedCount: 1,
      failedCount: 0,
      rounds: 1,
      searches: 1,
    },
  };

  await withServer(
    () => ({ generateText: async () => "unused" }),
    async (baseUrl) => {
      const response = await sendMessage(baseUrl, "What is pollination?");
      assert.equal(response.status, 200);
      const body = (await response.json()) as { reply: string };
      assert.match(body.reply, /^!\[Honeybee pollinating a flower\]\(https:\/\/api\.openverse\.org/);
      assert.ok(
        body.reply.indexOf("![Honeybee pollinating a flower]") <
          body.reply.indexOf("Pollination transfers pollen between flowers"),
      );
      assert.doesNotMatch(body.reply, /Flickr|Example photographer|license:|www\.flickr\.com/);
      assert.deepEqual(imageRequests, ["What is pollination?"]);
    },
    undefined,
    {
      researchRunner: async () => researchResult,
      researchImageFinder: async (message, _context, _maxResults, attributionFreeOnly) => {
        assert.equal(attributionFreeOnly, true);
        imageRequests.push(message);
        return [image];
      },
    },
  );
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
        },
        body: JSON.stringify({}),
      });
      assert.equal(missing.status, 400);

      const malformed = await fetch(`${baseUrl}/api/chat`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
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

test(
  "Muse returns a safe 502 when Groq fails without another provider configured",
  async () => {
    const providerCalls: string[] = [];
    const groqProvider: TextGenerationProvider = {
      providerName: "groq",
      model: "test-groq",
      async generateText() {
        providerCalls.push("groq");
        throw new Error("Groq request failed with HTTP 503.");
      },
    };

    await withServer(
      () => groqProvider,
      async (baseUrl) => {
        const originalError = console.error;
        console.error = () => undefined;
        try {
          const response = await sendMessage(baseUrl, "Hi, can we just talk?");
          assert.equal(response.status, 502);
          assert.deepEqual(await response.json(), {
            error: "Mira could not generate a reply. Check the server terminal.",
          });
          assert.deepEqual(providerCalls, ["groq"]);
        } finally {
          console.error = originalError;
        }
      },
    );
  },
);

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

test("X endpoints are removed and publishing commands are ordinary chat messages", async () =>
  withServer(
    () => ({ generateText: async () => "I can help research that topic." }),
    async (baseUrl) => {
      const xStatus = await fetch(`${baseUrl}/api/x/status`);
      assert.equal(xStatus.status, 404);

      const reply = await sendMessage(baseUrl, "publish quote draft 12345678");
      assert.equal(reply.status, 200);
      assert.deepEqual(await reply.json(), {
        reply: "I can help research that topic.",
      });
    },
  ));

test("text attachments are available for one turn and absent from later context", async () => {
  const capturedConversations: string[][] = [];
  await withServer(
    () => ({
      generateText: async (request) => {
        capturedConversations.push(
          request.conversation.map((message) => `${message.role}: ${message.content}`),
        );
        return "I read the attachment.";
      },
    }),
    async (baseUrl, memoryDirectory) => {
      const privateMarker = "PRIVATE-ATTACHMENT-MARKER";
      const upload = await uploadAttachment(
        baseUrl,
        "launch-notes.md",
        Buffer.from(
          `Please remember that I prefer low-risk launches. ${privateMarker}`,
          "utf8",
        ),
        "text/markdown",
      );
      assert.equal(upload.status, 201);
      const cookie = getSessionCookie(upload);
      const result = (await upload.json()) as {
        attachment: { id: string; name: string; mimeType: string; size: number };
      };
      assert.equal(result.attachment.name, "launch-notes.md");
      assert.equal(result.attachment.mimeType, "text/markdown");

      const firstTurn = await sendMessageWithAttachments(
        baseUrl,
        "Thanks for reading this note.",
        [result.attachment.id],
        cookie,
      );
      assert.equal(firstTurn.status, 200);
      assert.deepEqual(await firstTurn.json(), { reply: "I read the attachment." });
      assert.ok(
        capturedConversations[0]?.some(
          (content) =>
            content.includes('Text file "launch-notes.md"') &&
            content.includes(privateMarker),
        ),
      );

      const nextTurn = await sendMessage(baseUrl, "Please continue.", cookie);
      assert.equal(nextTurn.status, 200);
      assert.equal(
        capturedConversations[1]?.join("\n").includes(privateMarker),
        false,
      );
      const deleted = await fetch(
        `${baseUrl}/api/attachments/${result.attachment.id}`,
        { method: "DELETE", headers: { Cookie: cookie } },
      );
      assert.equal(deleted.status, 404);
      assert.deepEqual(await readdir(memoryDirectory), []);
    },
  );
});

test("image attachments are analyzed with the current question and not retained in later turns", async () => {
  const capturedConversations: string[][] = [];
  const visionCalls: Array<{ mimeType: string; question: string }> = [];
  const privateVisionMarker = "VISION-ONLY-MARKER";
  const mediaProvider: MuseMediaProvider = {
    generateImage: async () => ({
      bytes: Buffer.from([0xff, 0xd8, 0xff, 0x01]),
      mimeType: "image/jpeg",
    }),
    describeImage: async (_image, mimeType, question) => {
      visionCalls.push({ mimeType, question });
      return `A red bicycle. ${privateVisionMarker}`;
    },
  };

  await withServer(
    () => ({
      generateText: async (request) => {
        capturedConversations.push(
          request.conversation.map((message) => `${message.role}: ${message.content}`),
        );
        return "I described what is visible.";
      },
    }),
    async (baseUrl) => {
      const png = Buffer.from([
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00,
      ]);
      const upload = await uploadAttachment(
        baseUrl,
        "bike.png",
        png,
        "image/png",
      );
      assert.equal(upload.status, 201);
      const cookie = getSessionCookie(upload);
      const result = (await upload.json()) as {
        attachment: { id: string; mimeType: string };
      };

      const firstTurn = await sendMessageWithAttachments(
        baseUrl,
        "Thanks for looking at this.",
        [result.attachment.id],
        cookie,
      );
      assert.equal(firstTurn.status, 200);
      assert.equal(visionCalls.length, 1);
      assert.deepEqual(visionCalls[0], {
        mimeType: "image/png",
        question: "Thanks for looking at this.",
      });
      assert.ok(capturedConversations[0]?.join("\n").includes(privateVisionMarker));

      const nextTurn = await sendMessage(baseUrl, "Thanks for your help.", cookie);
      assert.equal(nextTurn.status, 200);
      assert.equal(
        capturedConversations[1]?.join("\n").includes(privateVisionMarker),
        false,
      );
    },
    undefined,
    { mediaProviderFactory: () => mediaProvider },
  );
});

test("image generation returns a viewable image and enforces the hourly request cap", async () => {
  const prompts: string[] = [];
  const generatedBytes = Buffer.from([0xff, 0xd8, 0xff, 0x00, 0x01, 0x02]);
  const mediaProvider: MuseMediaProvider = {
    generateImage: async (prompt) => {
      prompts.push(prompt);
      return { bytes: generatedBytes, mimeType: "image/jpeg" };
    },
    describeImage: async () => "unused",
  };

  await withServer(
    () => ({ generateText: async () => "unused" }),
    async (baseUrl) => {
      for (let index = 0; index < 10; index += 1) {
        const response = await fetch(`${baseUrl}/api/images/generate`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ prompt: index === 0 ? "A blue bicycle" : `Image ${index}` }),
        });
        assert.equal(response.status, 200);
        assert.equal(response.headers.get("content-type"), "image/jpeg");
        assert.deepEqual(Buffer.from(await response.arrayBuffer()), generatedBytes);
      }
      const limited = await fetch(`${baseUrl}/api/images/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: "One more image" }),
      });
      assert.equal(limited.status, 429);
      assert.ok(Number(limited.headers.get("retry-after")) > 0);
      const limitedBody = (await limited.json()) as { error: string };
      assert.match(limitedBody.error, /hourly image-generation limit/);
      assert.equal(prompts.length, 10);
      assert.equal(prompts[0], "A blue bicycle");
    },
    undefined,
    { mediaProviderFactory: () => mediaProvider },
  );
});

test("missing vision configuration does not block chat or invite image guesses", async () => {
  const capturedConversations: string[] = [];
  await withServer(
    () => ({
      generateText: async (request) => {
        capturedConversations.push(
          request.conversation.map((message) => message.content).join("\n"),
        );
        return "I could not inspect the image, so I will not guess what it shows.";
      },
    }),
    async (baseUrl) => {
      const originalError = console.error;
      console.error = () => undefined;
      try {
        const generation = await fetch(`${baseUrl}/api/images/generate`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ prompt: "A quiet garden" }),
        });
        assert.equal(generation.status, 503);
        const generationBody = (await generation.json()) as { error: string };
        assert.match(generationBody.error, /MUSE_CLOUDFLARE_ACCOUNT_ID/);

        const upload = await uploadAttachment(
          baseUrl,
          "photo.jpg",
          Buffer.from([0xff, 0xd8, 0xff, 0x02]),
          "image/jpeg",
        );
        assert.equal(upload.status, 201);
        const cookie = getSessionCookie(upload);
        const { attachment } = (await upload.json()) as {
          attachment: { id: string };
        };
        const chat = await sendMessageWithAttachments(
          baseUrl,
          "Describe this image.",
          [attachment.id],
          cookie,
        );
        assert.equal(chat.status, 200);
        const chatBody = (await chat.json()) as {
          reply: string;
          notices: string[];
        };
        assert.match(chatBody.reply, /could not inspect the image/i);
        assert.match(chatBody.notices.join(" "), /could not inspect/i);
        assert.match(chatBody.notices.join(" "), /not configured/i);
        assert.match(capturedConversations[0] ?? "", /Do not infer or invent visual details/);
        assert.match(capturedConversations[0] ?? "", /ask them to describe it or try again/);
        const retry = await sendMessageWithAttachments(
          baseUrl,
          "Describe this image.",
          [attachment.id],
          cookie,
        );
        assert.equal(retry.status, 400);
      } finally {
        console.error = originalError;
      }
    },
    undefined,
    {
      mediaProviderFactory: () => {
        throw new CloudflareAIConfigurationError("Missing test configuration");
      },
    },
  );
});

test("a failed vision request still replies with a notice and no invented image details", async () => {
  const modelContext: string[] = [];
  const systemPrompts: string[] = [];
  const mediaProvider: MuseMediaProvider = {
    generateImage: async () => ({
      bytes: Buffer.from([0xff, 0xd8, 0xff, 0x01]),
      mimeType: "image/jpeg",
    }),
    describeImage: async () => {
      throw new Error("Cloudflare Workers AI vision models returned no description.");
    },
  };

  await withServer(
    () => ({
      generateText: async (request) => {
        systemPrompts.push(request.systemPrompt);
        modelContext.push(request.conversation.map((message) => message.content).join("\n"));
        return "I could not inspect the image, so I will not guess what it shows.";
      },
    }),
    async (baseUrl) => {
      const originalError = console.error;
      console.error = () => undefined;
      try {
        const upload = await uploadAttachment(
          baseUrl,
          "unknown.png",
          Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
          "image/png",
        );
        assert.equal(upload.status, 201);
        const cookie = getSessionCookie(upload);
        const { attachment } = (await upload.json()) as { attachment: { id: string } };
        const response = await sendMessageWithAttachments(
          baseUrl,
          "What is in the image?",
          [attachment.id],
          cookie,
        );
        assert.equal(response.status, 200);
        const body = (await response.json()) as { reply: string; notices: string[] };
        assert.match(body.reply, /will not guess/i);
        assert.match(body.notices.join(" "), /could not inspect/i);
        assert.match(body.notices.join(" "), /image analysis was unavailable/i);
        assert.match(modelContext[0] ?? "", /Do not infer or invent visual details/);
        assert.match(modelContext[0] ?? "", /ask them to describe it or try again/);
        assert.match(systemPrompts[0] ?? "", /Never invent visual details/);
      } finally {
        console.error = originalError;
      }
    },
    undefined,
    { mediaProviderFactory: () => mediaProvider },
  );
});

test("attachment uploads reject unsupported types, spoofed image bytes, and oversized text", async () => {
  await withServer(
    () => ({ generateText: async () => "unused" }),
    async (baseUrl) => {
      const pdf = await uploadAttachment(
        baseUrl,
        "report.pdf",
        Buffer.from("not supported"),
        "application/pdf",
      );
      assert.equal(pdf.status, 415);

      const spoofed = await uploadAttachment(
        baseUrl,
        "fake.png",
        Buffer.from("this is not a PNG"),
        "image/png",
      );
      assert.equal(spoofed.status, 415);

      const oversized = await uploadAttachment(
        baseUrl,
        "large.txt",
        Buffer.alloc(512 * 1024 + 1, 0x61),
        "text/plain",
      );
      assert.equal(oversized.status, 413);
      const oversizedBody = (await oversized.json()) as { error: string };
      assert.match(oversizedBody.error, /512 KB/);
    },
  );
});

test("image understanding enforces its per-hour Cloudflare request limit", async () => {
  let analysisCalls = 0;
  const mediaProvider: MuseMediaProvider = {
    generateImage: async () => ({
      bytes: Buffer.from([0xff, 0xd8, 0xff, 0x01]),
      mimeType: "image/jpeg",
    }),
    describeImage: async () => {
      analysisCalls += 1;
      return "A simple test image.";
    },
  };

  await withServer(
    () => ({ generateText: async () => "I looked at the image." }),
    async (baseUrl) => {
      let cookie: string | undefined;
      const originalError = console.error;
      console.error = () => undefined;
      try {
        for (let index = 0; index < 21; index += 1) {
          const upload = await uploadAttachment(
            baseUrl,
            `rate-${index}.png`,
            Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
            "image/png",
            cookie,
          );
          assert.equal(upload.status, 201);
          cookie ??= getSessionCookie(upload);
          const { attachment } = (await upload.json()) as {
            attachment: { id: string };
          };
          const response = await sendMessageWithAttachments(
            baseUrl,
            "Thanks for looking at this.",
            [attachment.id],
            cookie,
          );
          assert.equal(response.status, 200);
          const body = (await response.json()) as { reply: string; notices?: string[] };
          assert.equal(body.reply, "I looked at the image.");
          if (index === 20) {
            assert.match(body.notices?.join(" ") ?? "", /hourly image-analysis limit/i);
          } else {
            assert.equal(body.notices, undefined);
          }
        }
      } finally {
        console.error = originalError;
      }
      assert.equal(analysisCalls, 20);
    },
    undefined,
    { mediaProviderFactory: () => mediaProvider },
  );
});
