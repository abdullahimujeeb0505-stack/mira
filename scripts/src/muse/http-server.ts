import {
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { JsonMemoryRepository } from "./memory/json-memory-repository.js";
import { MemoryService } from "./memory/memory-service.js";
import { MuseAgent } from "./muse-agent.js";
import { createTaskAwareProviders } from "./provider-selection.js";
import type { TextGenerationProvider } from "./llm-provider.js";
import type { ResearchRunner } from "./muse-agent.js";

const SESSION_COOKIE_NAME = "muse_session";
const SESSION_TTL_MS = 8 * 60 * 60 * 1_000;
const MAX_ACTIVE_SESSIONS = 500;
const MAX_REQUEST_BYTES = 16 * 1_024;
const MAX_MESSAGE_LENGTH = 4_000;
const DEFAULT_MEMORY_DIRECTORY = fileURLToPath(
  new URL("../../data/muse-http-sessions/", import.meta.url),
);

const CHAT_PAGE = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="theme-color" content="#10131b">
    <title>Muse — conversational assistant</title>
    <style>
      :root { color-scheme: dark; font-family: Inter, ui-sans-serif, system-ui, sans-serif; background: #10131b; color: #f4f5f7; }
      * { box-sizing: border-box; }
      body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 24px; background: radial-gradient(ellipse at top, #222b3d 0, #10131b 54%); }
      main { width: min(100%, 760px); min-height: min(780px, calc(100vh - 48px)); display: flex; flex-direction: column; padding: clamp(20px, 5vw, 40px); border: 1px solid #32394a; border-radius: 24px; background: #171b25; box-shadow: 0 24px 80px #0006; }
      .eyebrow { color: #91a9ff; font-size: 12px; font-weight: 700; letter-spacing: .16em; text-transform: uppercase; }
      h1 { margin: 12px 0 8px; font-size: clamp(30px, 6vw, 48px); letter-spacing: -.04em; }
      .intro, .notice { color: #a8afbe; line-height: 1.6; }
      .notice { margin: 0; font-size: 12px; }
      .visually-hidden { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
      #messages { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 12px; overflow-y: auto; padding: 22px 0; }
      .message { max-width: 88%; min-width: 0; padding: 12px 15px; border-radius: 16px; line-height: 1.55; overflow-wrap: break-word; word-break: normal; white-space: pre-wrap; }
      .message.muse { align-self: flex-start; background: #252c3a; }
      .message.muse h1, .message.muse h2, .message.muse h3, .message.muse h4, .message.muse h5, .message.muse h6 { margin: .4em 0; line-height: 1.25; }
      .message.muse p { margin: .35em 0; }
      .message.muse ul, .message.muse ol { margin: .35em 0; padding-left: 1.5em; }
      .message.muse a { color: #a9bbff; text-decoration: underline; text-underline-offset: 2px; }
      .message.muse img { display: block; max-width: min(100%, 680px); height: auto; margin: 10px 0; border-radius: 10px; }
      .message.muse table { border-collapse: collapse; table-layout: fixed; display: block; width: 100%; max-width: 100%; overflow-x: auto; white-space: normal; }
      .message.muse th, .message.muse td { border: 1px solid #4a5365; padding: 6px 9px; text-align: left; vertical-align: top; overflow-wrap: anywhere; word-break: normal; }
      .message.muse pre { max-width: 100%; overflow-x: auto; white-space: pre; }
      .message.muse code { overflow-wrap: anywhere; white-space: break-spaces; }
      .message.you { align-self: flex-end; background: #526de2; }
      form { display: flex; gap: 10px; align-items: flex-end; margin-top: 4px; }
      textarea { flex: 1; min-height: 52px; max-height: 180px; resize: vertical; border: 1px solid #3b4354; border-radius: 14px; padding: 14px; color: inherit; background: #10131b; font: inherit; }
      textarea:focus { outline: 2px solid #91a9ff; outline-offset: 1px; }
      button { min-height: 52px; border: 0; border-radius: 14px; padding: 0 20px; color: white; background: #526de2; font: inherit; font-weight: 700; cursor: pointer; }
      button:disabled { cursor: wait; opacity: .65; }
      #status { min-height: 20px; margin: 10px 0 0; color: #a8afbe; font-size: 13px; }
      @media (max-width: 520px) { body { padding: 0; } main { min-height: 100vh; border: 0; border-radius: 0; } form { align-items: stretch; flex-direction: column; } button { width: 100%; } }
    </style>
  </head>
  <body>
    <main>
      <div class="eyebrow">Muse · assistant</div>
      <h1>What would you like to talk about?</h1>
      <p class="intro">Chat, brainstorm, ask a question, or request web research with sources.</p>
      <section id="messages" aria-live="polite" aria-label="Conversation">
        <div class="message muse">Hi, I’m Muse. What would you like to work through?</div>
      </section>
      <form id="chat-form">
        <label for="message" class="visually-hidden">Message to Muse</label>
        <textarea id="message" name="message" maxlength="4000" placeholder="Write a message…" required></textarea>
        <button id="send" type="submit">Send</button>
      </form>
      <p id="status" role="status"></p>
    </main>
    <script>
      const form = document.querySelector("#chat-form");
      const input = document.querySelector("#message");
      const button = document.querySelector("#send");
      const messages = document.querySelector("#messages");
      const status = document.querySelector("#status");

      function addInlineFormatting(parent, text) {
        const parts = text.split(/(\\*\\*[^*]+\\*\\*|\\*[^*]+\\*|\`[^\`]+\`|!?\\[[^\\]]+\\]\\([^)]+\\))/g);
        for (const part of parts) {
          if (part.startsWith("**") && part.endsWith("**") && part.length > 4) {
            const strong = document.createElement("strong");
            strong.textContent = part.slice(2, -2);
            parent.append(strong);
          } else if (part.startsWith("*") && part.endsWith("*") && part.length > 2) {
            const em = document.createElement("em");
            em.textContent = part.slice(1, -1);
            parent.append(em);
          } else if (part.startsWith("\`") && part.endsWith("\`") && part.length > 2) {
            const code = document.createElement("code");
            code.textContent = part.slice(1, -1);
            parent.append(code);
          } else if (part.startsWith("![") && part.endsWith(")")) {
            const match = part.match(/^!\\[([^\\]]*)\\]\\(([^)]+)\\)$/);
            let url;
            try {
              url = match ? new URL(match[2]) : null;
            } catch {
              url = null;
            }
            if (match && url && url.protocol === "https:" && url.hostname === "upload.wikimedia.org") {
              const image = document.createElement("img");
              image.src = url.href;
              image.alt = match[1];
              image.loading = "lazy";
              image.referrerPolicy = "no-referrer";
              parent.append(image);
            } else {
              parent.append(document.createTextNode(match ? match[1] : part));
            }
          } else if (part.startsWith("[") && part.includes("](") && part.endsWith(")")) {
            const match = part.match(/^\\[([^\\]]+)\\]\\(([^)]+)\\)$/);
            let url;
            try {
              url = match ? new URL(match[2]) : null;
            } catch {
              url = null;
            }
            if (match && url && (url.protocol === "https:" || url.protocol === "http:")) {
              const link = document.createElement("a");
              link.href = url.href;
              link.rel = "noopener noreferrer";
              link.target = "_blank";
              link.textContent = match[1];
              parent.append(link);
            } else {
              parent.append(document.createTextNode(match ? match[1] : part));
            }
          } else {
            parent.append(document.createTextNode(part));
          }
        }
      }

      function renderMarkdown(parent, text) {
        const lines = text.split("\\n");
        const cells = (line) => {
          const value = line.trim();
          if (!value.startsWith("|") || !value.endsWith("|")) return null;
          const result = [];
          let cell = "";
          let inCode = false;
          let escaped = false;
          for (let position = 1; position < value.length - 1; position += 1) {
            const character = value[position];
            if (escaped) {
              cell += character;
              escaped = false;
            } else if (character === "\\\\") {
              escaped = true;
            } else if (character === "\`") {
              inCode = !inCode;
              cell += character;
            } else if (character === "|" && !inCode) {
              result.push(cell.trim());
              cell = "";
            } else {
              cell += character;
            }
          }
          result.push(cell.trim());
          return result;
        };
        const isTableSeparator = (line) => {
          const row = cells(line);
          return Boolean(row && row.length && row.every((cell) => /^:?-{3,}:?$/.test(cell)));
        };
        const isTableStart = (position) =>
          Boolean(cells(lines[position]) && isTableSeparator(lines[position + 1] || ""));
        let index = 0;
        let previousHeadingLevel = 1;
        while (index < lines.length) {
          const line = lines[index].trim();
          if (!line) {
            index += 1;
            continue;
          }
          const fence = line.match(/^(\`\`\`|~~~)(.*)$/);
          if (fence) {
            const closing = fence[1];
            const codeLines = [];
            index += 1;
            while (index < lines.length && !lines[index].trim().startsWith(closing)) {
              codeLines.push(lines[index]);
              index += 1;
            }
            if (index < lines.length) index += 1;
            const pre = document.createElement("pre");
            const code = document.createElement("code");
            code.textContent = codeLines.join("\\n");
            pre.append(code);
            parent.append(pre);
            continue;
          }
          const heading = line.match(/^(#{1,6})\\s+(.+)$/);
          if (heading) {
            const level = Math.min(
              6,
              Math.max(2, Math.min(heading[1].length + 1, previousHeadingLevel + 1))
            );
            previousHeadingLevel = level;
            const element = document.createElement("h" + level);
            addInlineFormatting(element, heading[2]);
            parent.append(element);
            index += 1;
            continue;
          }
          if (isTableStart(index)) {
            const table = document.createElement("table");
            const head = document.createElement("thead");
            const headerRow = document.createElement("tr");
            for (const cell of cells(line)) {
              const th = document.createElement("th");
              addInlineFormatting(th, cell);
              headerRow.append(th);
            }
            head.append(headerRow);
            table.append(head);
            index += 2;
            const body = document.createElement("tbody");
            while (index < lines.length && cells(lines[index].trim()) && !isTableSeparator(lines[index])) {
              const row = document.createElement("tr");
              for (const cell of cells(lines[index])) {
                const td = document.createElement("td");
                addInlineFormatting(td, cell);
                row.append(td);
              }
              body.append(row);
              index += 1;
            }
            table.append(body);
            parent.append(table);
            continue;
          }
          const list = line.match(/^([-+*])\\s+(.+)|^(\\d+)\\.\\s+(.+)$/);
          if (list) {
            const ordered = Boolean(list[3]);
            const element = document.createElement(ordered ? "ol" : "ul");
            while (index < lines.length) {
              const item = lines[index].trim().match(/^([-+*])\\s+(.+)|^(\\d+)\\.\\s+(.+)$/);
              if (!item || Boolean(item[3]) !== ordered) break;
              const li = document.createElement("li");
              addInlineFormatting(li, item[2] || item[4]);
              element.append(li);
              index += 1;
            }
            parent.append(element);
            continue;
          }
          const paragraphLines = [];
          while (index < lines.length && lines[index].trim() &&
            !/^#{1,6}\\s/.test(lines[index].trim()) &&
            !/^(\`\`\`|~~~)/.test(lines[index].trim()) &&
            !/^([-+*])\\s+|^\\d+\\.\\s+/.test(lines[index].trim()) &&
            !isTableStart(index)) {
            paragraphLines.push(lines[index].trim());
            index += 1;
          }
          if (paragraphLines.length) {
            const paragraph = document.createElement("p");
            addInlineFormatting(paragraph, paragraphLines.join(" "));
            parent.append(paragraph);
          }
        }
      }

      function addMessage(kind, text) {
        const item = document.createElement("div");
        item.className = "message " + kind;
        if (kind === "muse") {
          renderMarkdown(item, text);
        } else {
          item.textContent = text;
        }
        messages.append(item);
        item.scrollIntoView({ block: "nearest" });
      }
      form.addEventListener("submit", async (event) => {
        event.preventDefault();
        const message = input.value.trim();
        if (!message || button.disabled) return;
        addMessage("you", message);
        input.value = "";
        button.disabled = true;
        status.textContent = "Muse is thinking…";
        try {
          const response = await fetch("/api/chat", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ message })
          });
          const result = await response.json();
          if (!response.ok) throw new Error(result.error || "Muse could not reply.");
          addMessage("muse", result.reply);
          status.textContent = "";
        } catch (error) {
          status.textContent = error instanceof Error ? error.message : "Muse could not reply.";
        } finally {
          button.disabled = false;
          input.focus();
        }
      });
    </script>
  </body>
</html>`;

interface MuseSession {
  agent: MuseAgent;
  lastUsedAt: number;
  pending: Promise<void>;
}

export interface MuseHttpServerOptions {
  sessionSecret?: string;
  memoryDirectory?: string;
  sharedMemoryPath?: string;
  providerFactory?: () => TextGenerationProvider;
  /** Provider for research planning, synthesis, and long-form writing.
   *  Defaults to `providerFactory` (or the task-aware research provider when
   *  neither factory is supplied). */
  researchProviderFactory?: () => TextGenerationProvider;
  researchRunner?: ResearchRunner;
  maxActiveSessions?: number;
  sessionTtlMs?: number;
}

export function createMuseHttpServer(
  options: MuseHttpServerOptions = {},
): Server {
  const sessionSecret =
    options.sessionSecret ?? process.env.SESSION_SECRET ?? "";
  if (!sessionSecret.trim()) {
    throw new Error("SESSION_SECRET is required to start the Muse HTTP server.");
  }
  const memoryDirectory =
    options.memoryDirectory ??
    process.env.MUSE_HTTP_MEMORY_DIR ??
    DEFAULT_MEMORY_DIRECTORY;
  const defaultTasks = options.providerFactory
    ? undefined
    : createTaskAwareProviders();
  const providerFactory =
    options.providerFactory ??
    (() => {
      if (!defaultTasks) {
        throw new Error("Muse's default LLM provider was not initialized.");
      }
      return defaultTasks.chat.provider;
    });
  const sharedMemories = new MemoryService(
    new JsonMemoryRepository(options.sharedMemoryPath),
  );
  const maxActiveSessions = options.maxActiveSessions ?? MAX_ACTIVE_SESSIONS;
  const sessionTtlMs = options.sessionTtlMs ?? SESSION_TTL_MS;
  if (!Number.isInteger(maxActiveSessions) || maxActiveSessions < 1) {
    throw new Error("maxActiveSessions must be a positive integer.");
  }
  if (!Number.isFinite(sessionTtlMs) || sessionTtlMs <= 0) {
    throw new Error("sessionTtlMs must be a positive number.");
  }

  const sessions = new Map<string, MuseSession>();
  return createServer((request, response) => {
    void handleRequest(request, response).catch(() => {
      if (!response.headersSent && !response.destroyed) {
        sendJson(response, 500, { error: "Muse could not handle this request." });
      }
    });
  });

  async function handleRequest(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    setSecurityHeaders(response);
    const pathname = new URL(request.url ?? "/", "http://localhost").pathname;

    if (request.method === "GET" && pathname === "/") {
      response.statusCode = 200;
      response.setHeader("Content-Type", "text/html; charset=utf-8");
      response.end(CHAT_PAGE);
      return;
    }

    if (request.method === "GET" && pathname === "/api/healthz") {
      sendJson(response, 200, { status: "ok" });
      return;
    }

    if (pathname !== "/api/chat") {
      sendJson(response, 404, { error: "Not found." });
      return;
    }
    if (request.method !== "POST") {
      response.setHeader("Allow", "POST");
      sendJson(response, 405, { error: "Use POST to send a chat message." });
      return;
    }
    if (request.headers["content-type"]?.split(";")[0]?.trim() !== "application/json") {
      sendJson(response, 415, { error: "Send the message as JSON." });
      return;
    }

    let body: unknown;
    try {
      body = await readJsonBody(request);
    } catch (error) {
      sendJson(
        response,
        error instanceof RequestBodyTooLargeError ? 413 : 400,
        {
          error:
            error instanceof RequestBodyTooLargeError
              ? "The request body is too large."
              : "The request body must be valid JSON.",
        },
      );
      return;
    }

    if (!isRecord(body) || typeof body.message !== "string") {
      sendJson(response, 400, { error: "A message is required." });
      return;
    }
    const message = body.message.trim();
    if (!message) {
      sendJson(response, 400, { error: "A message is required." });
      return;
    }
    if (message.length > MAX_MESSAGE_LENGTH) {
      sendJson(response, 413, {
        error: `Messages must be ${MAX_MESSAGE_LENGTH} characters or fewer.`,
      });
      return;
    }

    let session: MuseSession | undefined;
    try {
      session = getSession(request, response);
    } catch {
      sendJson(response, 503, {
        error:
          "Muse's model provider is not configured. Set a provider key and try again.",
      });
      return;
    }
    if (!session) {
      sendJson(response, 503, {
        error: "Muse has reached its active session limit. Try again later.",
      });
      return;
    }

    try {
      const reply = await enqueueResponse(session, message);
      sendJson(response, 200, { reply });
    } catch (error) {
      console.error("Muse generation failed:", error);
      sendJson(response, 502, {
        error: "Muse could not generate a reply. Check the server terminal.",
      });
    }
  }

  function getSession(
    request: IncomingMessage,
    response: ServerResponse,
  ): MuseSession | undefined {
    const now = Date.now();
    for (const [id, session] of sessions) {
      if (now - session.lastUsedAt > sessionTtlMs) sessions.delete(id);
    }

    const cookieSessionId = readSessionId(request, sessionSecret);
    let id = cookieSessionId ?? randomBytes(32).toString("hex");
    let session = sessions.get(id);
    if (!session) {
      if (sessions.size >= maxActiveSessions) return undefined;
      session = {
        agent: (() => {
          const chatProvider = providerFactory();
          return new MuseAgent(
            chatProvider,
            new MemoryService(
              new JsonMemoryRepository(join(memoryDirectory, `${id}.json`)),
            ),
            sharedMemories,
            options.researchRunner,
            undefined,
            {
              research: options.researchProviderFactory
                ? options.researchProviderFactory()
                : defaultTasks
                ? defaultTasks.research.provider
                : chatProvider,
            },
          );
        })(),
        lastUsedAt: now,
        pending: Promise.resolve(),
      };
      sessions.set(id, session);
    }

    session.lastUsedAt = now;
    writeSessionCookie(request, response, id, sessionSecret, sessionTtlMs);
    return session;
  }
}

function enqueueResponse(session: MuseSession, message: string): Promise<string> {
  const response = session.pending.then(() => session.agent.respond(message));
  session.pending = response.then(
    () => undefined,
    () => undefined,
  );
  return response;
}

function readSessionId(
  request: IncomingMessage,
  secret: string,
): string | undefined {
  const cookieHeader = request.headers.cookie;
  if (!cookieHeader) return undefined;

  const cookie = cookieHeader
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${SESSION_COOKIE_NAME}=`));
  if (!cookie) return undefined;

  const value = cookie.slice(SESSION_COOKIE_NAME.length + 1);
  const [id, signature, extra] = value.split(".");
  if (
    extra !== undefined ||
    !/^[a-f0-9]{64}$/.test(id ?? "") ||
    !/^[a-f0-9]{64}$/.test(signature ?? "")
  ) {
    return undefined;
  }

  const expected = createHmac("sha256", secret).update(id).digest();
  const received = Buffer.from(signature, "hex");
  return timingSafeEqual(expected, received) ? id : undefined;
}

function writeSessionCookie(
  request: IncomingMessage,
  response: ServerResponse,
  id: string,
  secret: string,
  ttlMs: number,
): void {
  const signature = createHmac("sha256", secret).update(id).digest("hex");
  const forwardedProtocol = request.headers["x-forwarded-proto"];
  const isSecure =
    typeof forwardedProtocol === "string" &&
    forwardedProtocol.split(",")[0].trim().toLowerCase() === "https";
  const maxAgeSeconds = Math.max(1, Math.floor(ttlMs / 1_000));
  const secureAttribute = isSecure ? "; Secure" : "";
  response.setHeader(
    "Set-Cookie",
    `${SESSION_COOKIE_NAME}=${id}.${signature}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAgeSeconds}${secureAttribute}`,
  );
}

function setSecurityHeaders(response: ServerResponse): void {
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; img-src https://upload.wikimedia.org; form-action 'self'; base-uri 'none'; frame-ancestors 'none'");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("X-Frame-Options", "DENY");
}

function sendJson(
  response: ServerResponse,
  statusCode: number,
  body: Record<string, unknown>,
): void {
  response.statusCode = statusCode;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.end(JSON.stringify(body));
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const declaredLength = Number(request.headers["content-length"] ?? 0);
  if (declaredLength > MAX_REQUEST_BYTES) {
    request.resume();
    throw new RequestBodyTooLargeError();
  }

  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    let settled = false;

    const cleanup = () => {
      request.off("data", onData);
      request.off("end", onEnd);
      request.off("error", onError);
    };
    const onData = (chunk: Buffer | string) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      totalBytes += buffer.length;
      if (totalBytes > MAX_REQUEST_BYTES) {
        settled = true;
        cleanup();
        request.resume();
        reject(new RequestBodyTooLargeError());
        return;
      }
      chunks.push(buffer);
    };
    const onEnd = () => {
      if (settled) return;
      settled = true;
      cleanup();
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown);
      } catch {
        reject(new Error("Invalid JSON."));
      }
    };
    const onError = (error: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };

    request.on("data", onData);
    request.once("end", onEnd);
    request.once("error", onError);
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

class RequestBodyTooLargeError extends Error {}
