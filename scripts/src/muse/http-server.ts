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
import { Buffer } from "node:buffer";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { JsonMemoryRepository } from "./memory/json-memory-repository.js";
import { MemoryService } from "./memory/memory-service.js";
import { MuseAgent } from "./muse-agent.js";
import {
  CloudflareAIConfigurationError,
  CloudflareWorkersAIProvider,
  type GeneratedImage,
  type MuseMediaProvider,
} from "./cloudflare-workers-ai.js";
import { createTaskAwareProviders } from "./provider-selection.js";
import type { TextGenerationProvider } from "./llm-provider.js";
import type { ResearchRunner } from "./muse-agent.js";

const SESSION_COOKIE_NAME = "muse_session";
const SESSION_TTL_MS = 8 * 60 * 60 * 1_000;
const MAX_ACTIVE_SESSIONS = 500;
const MAX_REQUEST_BYTES = 16 * 1_024;
const MAX_MESSAGE_LENGTH = 4_000;
const MAX_IMAGE_ATTACHMENT_BYTES = 4 * 1_024 * 1_024;
const MAX_TEXT_ATTACHMENT_BYTES = 512 * 1_024;
const MAX_ATTACHMENT_TOTAL_BYTES = 8 * 1_024 * 1_024;
const MAX_SERVER_ATTACHMENT_BYTES = 32 * 1_024 * 1_024;
const MAX_ATTACHMENTS_PER_MESSAGE = 3;
const MAX_ATTACHMENT_TEXT_CHARS = 16_000;
const MAX_TOTAL_ATTACHMENT_TEXT_CHARS = 24_000;
const MAX_IMAGE_GENERATIONS_PER_HOUR = 10;
const MAX_IMAGE_ANALYSES_PER_HOUR = 20;
const DEFAULT_MEMORY_DIRECTORY = fileURLToPath(
  new URL("../../data/muse-http-sessions/", import.meta.url),
);

const CHAT_PAGE = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="theme-color" content="#10131b">
    <title>Mira — conversational assistant by Muse</title>
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
      form { display: flex; flex-direction: column; gap: 10px; margin-top: 4px; }
      .composer-row { display: flex; gap: 10px; align-items: flex-end; }
      .composer-tools { display: flex; flex-wrap: wrap; gap: 8px; }
      textarea { flex: 1; min-height: 52px; max-height: 180px; resize: vertical; border: 1px solid #3b4354; border-radius: 14px; padding: 14px; color: inherit; background: #10131b; font: inherit; }
      textarea:focus { outline: 2px solid #91a9ff; outline-offset: 1px; }
      button { min-height: 46px; border: 0; border-radius: 12px; padding: 0 16px; color: white; background: #526de2; font: inherit; font-weight: 700; cursor: pointer; }
      .tool-button, .attachment-remove, .speak-button { min-height: 34px; padding: 0 12px; color: #d9e1ff; background: #30394c; font-size: 13px; }
      .attachment-list { display: flex; flex-wrap: wrap; gap: 8px; }
      .attachment-chip { display: inline-flex; gap: 8px; align-items: center; padding: 5px 7px 5px 11px; border: 1px solid #3b4354; border-radius: 999px; color: #dce2ee; font-size: 12px; }
      .message-actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 8px; }
      .download-link { display: inline-block; padding: 8px 12px; border-radius: 8px; color: #d9e1ff; background: #30394c; font-size: 13px; text-decoration: none; }
      .generated-image { display: block; max-width: min(100%, 680px); height: auto; border-radius: 10px; }
      button:disabled { cursor: wait; opacity: .65; }
      #status { min-height: 20px; margin: 10px 0 0; color: #a8afbe; font-size: 13px; }
      @media (max-width: 520px) { body { padding: 0; } main { min-height: 100vh; border: 0; border-radius: 0; } .composer-row { align-items: stretch; flex-direction: column; } .composer-row button { width: 100%; } .composer-tools button { width: auto; flex: 1; } }
    </style>
  </head>
  <body>
    <main>
      <div class="eyebrow">Mira · by Muse</div>
      <h1>What would you like to talk about?</h1>
      <p class="intro">Chat, brainstorm, ask a question, or request web research with sources.</p>
      <section id="messages" aria-live="polite" aria-label="Conversation">
        <div class="message muse">Hi, I’m Mira, Muse’s assistant. What would you like to work through?</div>
      </section>
      <div id="attachment-list" class="attachment-list" aria-label="Attachments"></div>
      <form id="chat-form">
        <input id="attachment-files" class="visually-hidden" type="file" multiple accept="image/jpeg,image/png,image/webp,text/plain,text/markdown,text/csv,.jpg,.jpeg,.png,.webp,.txt,.md,.markdown,.csv">
        <div class="composer-tools">
          <button id="attach" class="tool-button" type="button">Attach file</button>
          <button id="voice-input" class="tool-button" type="button" aria-label="Dictate a message">Use microphone</button>
          <button id="generate-image" class="tool-button" type="button">Create image</button>
        </div>
        <div class="composer-row">
          <label for="message" class="visually-hidden">Message to Mira</label>
          <textarea id="message" name="message" maxlength="4000" placeholder="Write a message…" required></textarea>
          <button id="send" type="submit">Send</button>
        </div>
      </form>
      <p class="notice">Attach JPEG/PNG/WebP images (4 MB max) or TXT/Markdown/CSV files (512 KB max); up to three files per turn. PDFs and DOCX are not supported. Image tools use quota-limited Cloudflare Workers AI. Image attachments are sent to Cloudflare for understanding; your message and text-file contents are sent to the configured chat model. Files stay in memory and are discarded after the next chat turn. Dictation support and privacy vary by browser; audio is not uploaded to Muse, but the browser may use its own remote speech service. Speech playback uses your device’s voices.</p>
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

      const attachmentFiles = document.querySelector("#attachment-files");
      const attachmentList = document.querySelector("#attachment-list");
      const attachButton = document.querySelector("#attach");
      const voiceButton = document.querySelector("#voice-input");
      const imageButton = document.querySelector("#generate-image");
      const supportedExtensions = {
        ".jpg": "image/jpeg",
        ".jpeg": "image/jpeg",
        ".png": "image/png",
        ".webp": "image/webp",
        ".txt": "text/plain",
        ".md": "text/markdown",
        ".markdown": "text/markdown",
        ".csv": "text/csv"
      };
      let attachments = [];
      let busy = false;

      function setBusy(value) {
        busy = value;
        button.disabled = value;
        attachButton.disabled = value;
        imageButton.disabled = value;
        voiceButton.disabled = value || !voiceRecognition;
      }

      function expectedMimeType(file) {
        const name = file.name.toLowerCase();
        const dot = name.lastIndexOf(".");
        return dot < 0 ? "" : supportedExtensions[name.slice(dot)];
      }

      function formatFileSize(size) {
        return size < 1024 * 1024
          ? Math.max(1, Math.round(size / 1024)) + " KB"
          : (size / (1024 * 1024)).toFixed(1) + " MB";
      }

      function renderAttachments() {
        attachmentList.replaceChildren();
        for (const attachment of attachments) {
          const chip = document.createElement("span");
          chip.className = "attachment-chip";
          const label = document.createElement("span");
          label.textContent = attachment.name + " · " + formatFileSize(attachment.size);
          const remove = document.createElement("button");
          remove.className = "attachment-remove";
          remove.type = "button";
          remove.textContent = "Remove";
          remove.setAttribute("aria-label", "Remove " + attachment.name);
          remove.dataset.attachmentId = attachment.id;
          chip.append(label, remove);
          attachmentList.append(chip);
        }
      }

      attachmentList.addEventListener("click", async (event) => {
        const target = event.target instanceof Element ? event.target : null;
        const remove = target && target.closest("button[data-attachment-id]");
        if (!remove || busy) return;
        const id = remove.dataset.attachmentId;
        if (!id) return;
        remove.disabled = true;
        try {
          const response = await fetch("/api/attachments/" + encodeURIComponent(id), {
            method: "DELETE"
          });
          if (!response.ok) {
            const result = await response.json().catch(() => ({}));
            throw new Error(result.error || "Could not remove that attachment.");
          }
          attachments = attachments.filter((attachment) => attachment.id !== id);
          renderAttachments();
          status.textContent = "Attachment removed.";
        } catch (error) {
          status.textContent = error instanceof Error ? error.message : "Could not remove that attachment.";
          remove.disabled = false;
        }
      });

      attachButton.addEventListener("click", () => attachmentFiles.click());
      attachmentFiles.addEventListener("change", async () => {
        const selectedFiles = Array.from(attachmentFiles.files || []);
        attachmentFiles.value = "";
        if (!selectedFiles.length || busy) return;
        setBusy(true);
        try {
          for (const file of selectedFiles) {
            if (attachments.length >= 3) {
              throw new Error("You can attach up to three files per turn.");
            }
            const mimeType = expectedMimeType(file);
            if (!mimeType) {
              throw new Error("Attach JPEG, PNG, WebP, TXT, Markdown, CSV, or JSON files only.");
            }
            const isImage = mimeType.startsWith("image/");
            const maxBytes = isImage ? 4 * 1024 * 1024 : 512 * 1024;
            if (file.size > maxBytes) {
              throw new Error(file.name + " is larger than the " + (isImage ? "4 MB image" : "512 KB text") + " limit.");
            }
            const response = await fetch("/api/attachments", {
              method: "POST",
              headers: {
                "Content-Type": mimeType,
                "X-Muse-File-Name": encodeURIComponent(file.name)
              },
              body: file
            });
            const result = await response.json().catch(() => ({}));
            if (!response.ok) throw new Error(result.error || "Could not upload " + file.name + ".");
            attachments.push(result.attachment);
            renderAttachments();
          }
          status.textContent = "Attachment ready. It will be discarded after your next message.";
        } catch (error) {
          status.textContent = error instanceof Error ? error.message : "Could not upload that file.";
        } finally {
          setBusy(false);
        }
      });

      function addMessage(kind, text) {
        const item = document.createElement("div");
        item.className = "message " + kind;
        if (kind === "muse") {
          renderMarkdown(item, text);
          if ("speechSynthesis" in window && "SpeechSynthesisUtterance" in window && text.trim()) {
            const actions = document.createElement("div");
            actions.className = "message-actions";
            const speak = document.createElement("button");
            speak.className = "speak-button";
            speak.type = "button";
            speak.textContent = "Read aloud";
            speak.addEventListener("click", () => {
              const plainText = text
                .replace(/\\x60{3}[\\s\\S]*?\\x60{3}/g, " code block omitted ")
                .replace(/!\\[([^\\]]*)\\]\\([^)]+\\)/g, "$1")
                .replace(/\\[([^\\]]+)\\]\\([^)]+\\)/g, "$1")
                .replace(/[#*_>|]/g, " ").replaceAll(String.fromCharCode(96), " ");
              window.speechSynthesis.cancel();
              const utterance = new SpeechSynthesisUtterance(plainText);
              utterance.lang = navigator.language || "en-US";
              window.speechSynthesis.speak(utterance);
            });
            actions.append(speak);
            item.append(actions);
          }
        } else {
          item.textContent = text;
        }
        messages.append(item);
        item.scrollIntoView({ block: "nearest" });
      }

      function addGeneratedImage(blob) {
        const objectUrl = URL.createObjectURL(blob);
        const item = document.createElement("div");
        item.className = "message muse";
        const image = document.createElement("img");
        image.className = "generated-image";
        image.src = objectUrl;
        image.alt = "Image generated by Mira";
        const actions = document.createElement("div");
        actions.className = "message-actions";
        const download = document.createElement("a");
        download.className = "download-link";
        download.href = objectUrl;
        const extension = blob.type === "image/png" ? "png" : blob.type === "image/webp" ? "webp" : "jpg";
        download.download = "mira-generated-image." + extension;
        download.textContent = "Download image";
        download.addEventListener("click", () => {
          window.setTimeout(() => URL.revokeObjectURL(objectUrl), 60_000);
        }, { once: true });
        actions.append(download);
        item.append(image, actions);
        messages.append(item);
        item.scrollIntoView({ block: "nearest" });
      }

      async function readError(response, fallback) {
        const result = await response.json().catch(() => ({}));
        return result.error || fallback;
      }

      form.addEventListener("submit", async (event) => {
        event.preventDefault();
        const message = input.value.trim();
        if (!message || busy) return;
        const submittedAttachments = attachments.slice();
        addMessage("you", message + (submittedAttachments.length
          ? "\\n[Attached: " + submittedAttachments.map((file) => file.name).join(", ") + "]"
          : ""));
        input.value = "";
        setBusy(true);
        status.textContent = "Mira is thinking…";
        try {
          const response = await fetch("/api/chat", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              message,
              attachmentIds: submittedAttachments.map((attachment) => attachment.id)
            })
          });
          const result = await response.json();
          if (!response.ok) throw new Error(result.error || "Mira could not reply.");
          addMessage("muse", result.reply);
          status.textContent = "";
        } catch (error) {
          status.textContent = error instanceof Error ? error.message : "Mira could not reply.";
        } finally {
          attachments = [];
          renderAttachments();
          setBusy(false);
          input.focus();
        }
      });

      imageButton.addEventListener("click", async () => {
        const prompt = input.value.trim();
        if (!prompt || busy) {
          if (!prompt) status.textContent = "Describe the image you would like Mira to create.";
          return;
        }
        if (prompt.length > 1000) {
          status.textContent = "Image prompts must be 1,000 characters or fewer.";
          return;
        }
        addMessage("you", "Create image: " + prompt);
        input.value = "";
        setBusy(true);
        status.textContent = "Mira is creating your image…";
        try {
          const response = await fetch("/api/images/generate", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ prompt })
          });
          if (!response.ok) throw new Error(await readError(response, "Image generation failed."));
          const blob = await response.blob();
          addGeneratedImage(blob);
          status.textContent = "Image ready. Use Download image to save it.";
        } catch (error) {
          status.textContent = error instanceof Error ? error.message : "Image generation failed.";
        } finally {
          setBusy(false);
          input.focus();
        }
      });

      let voiceRecognition = null;
      let voiceBaseText = "";
      let voiceFinalText = "";
      const SpeechRecognitionConstructor = window.SpeechRecognition || window.webkitSpeechRecognition;
      if (SpeechRecognitionConstructor) {
        voiceRecognition = new SpeechRecognitionConstructor();
        voiceRecognition.lang = navigator.language || "en-US";
        voiceRecognition.continuous = false;
        voiceRecognition.interimResults = true;
        voiceRecognition.onresult = (event) => {
          let interimText = "";
          for (let index = event.resultIndex; index < event.results.length; index += 1) {
            const result = event.results[index];
            if (result.isFinal) voiceFinalText += result[0].transcript;
            else interimText += result[0].transcript;
          }
          input.value = [voiceBaseText, voiceFinalText, interimText]
            .filter(Boolean)
            .join(" ")
            .trim();
        };
        voiceRecognition.onerror = (event) => {
          status.textContent = event.error === "not-allowed"
            ? "Microphone permission was denied. You can type your message instead."
            : "Speech recognition was unavailable. You can type your message instead.";
        };
        voiceRecognition.onend = () => {
          voiceButton.textContent = "Use microphone";
          if (!busy) voiceButton.disabled = false;
          if (status.textContent === "Listening…") status.textContent = "";
        };
        voiceButton.addEventListener("click", () => {
          if (busy) return;
          try {
            voiceBaseText = input.value.trim();
            voiceFinalText = "";
            voiceButton.disabled = true;
            voiceButton.textContent = "Listening…";
            status.textContent = "Listening…";
            voiceRecognition.start();
          } catch {
            voiceButton.disabled = false;
            voiceButton.textContent = "Use microphone";
            status.textContent = "Could not start speech recognition. You can type your message instead.";
          }
        });
      } else {
        voiceButton.disabled = true;
        voiceButton.title = "Speech recognition is not supported in this browser. Type your message instead.";
        voiceButton.textContent = "Mic unavailable";
      }
    </script>
  </body>
</html>`;

interface MuseAttachment {
  id: string;
  name: string;
  mimeType: string;
  bytes: Buffer;
}

interface MuseSession {
  agent: MuseAgent;
  lastUsedAt: number;
  pending: Promise<void>;
  attachments: Map<string, MuseAttachment>;
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
  mediaProviderFactory?: () => MuseMediaProvider;
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
  const imageGenerationTimestamps: number[] = [];
  const imageAnalysisTimestamps: number[] = [];
  let storedAttachmentBytes = 0;
  let mediaProvider: MuseMediaProvider | undefined;

  function getMediaProvider(): MuseMediaProvider {
    if (!mediaProvider) {
      mediaProvider = options.mediaProviderFactory
        ? options.mediaProviderFactory()
        : new CloudflareWorkersAIProvider();
    }
    return mediaProvider;
  }

  function consumeHourlyLimit(
    timestamps: number[],
    limit: number,
    now = Date.now(),
  ): number {
    while (timestamps.length > 0 && now - timestamps[0]! >= 60 * 60 * 1_000) {
      timestamps.shift();
    }
    if (timestamps.length >= limit) {
      return Math.max(
        1,
        Math.ceil((60 * 60 * 1_000 - (now - timestamps[0]!)) / 1_000),
      );
    }
    timestamps.push(now);
    return 0;
  }

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

    if (pathname === "/api/attachments") {
      await handleAttachmentUpload(request, response);
      return;
    }
    if (pathname.startsWith("/api/attachments/")) {
      await handleAttachmentDelete(request, response, pathname);
      return;
    }
    if (pathname === "/api/images/generate") {
      await handleImageGeneration(request, response);
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
    let attachmentIds: string[] = [];
    if (body.attachmentIds !== undefined) {
      if (
        !Array.isArray(body.attachmentIds) ||
        body.attachmentIds.length > MAX_ATTACHMENTS_PER_MESSAGE ||
        body.attachmentIds.some(
          (id) => typeof id !== "string" || !/^[a-f0-9]{32}$/.test(id),
        ) ||
        new Set(body.attachmentIds).size !== body.attachmentIds.length
      ) {
        sendJson(response, 400, { error: "The attachment list is invalid." });
        return;
      }
      attachmentIds = body.attachmentIds as string[];
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
      const reply = await enqueueResponse(session, message, attachmentIds);
      sendJson(response, 200, { reply });
    } catch (error) {
      console.error(
        "Muse generation failed:",
        error instanceof Error ? error.message : "unknown error",
      );
      if (error instanceof CloudflareAIConfigurationError) {
        sendJson(response, 503, {
          error:
            "Image understanding is not configured. Set MUSE_CLOUDFLARE_ACCOUNT_ID and MUSE_CLOUDFLARE_AI_TOKEN.",
        });
      } else if (error instanceof CloudflareRateLimitError) {
        response.setHeader("Retry-After", String(error.retryAfterSeconds));
        sendJson(response, 429, {
          error: "Image understanding has reached its hourly limit. Try again later.",
        });
      } else if (error instanceof MissingSessionAttachmentError) {
        sendJson(response, 400, { error: "An attachment expired or was removed. Please upload it again." });
      } else {
        sendJson(response, 502, {
          error: "Mira could not generate a reply. Check the server terminal.",
        });
      }
    }
  }

  async function handleAttachmentUpload(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    if (request.method !== "POST") {
      response.setHeader("Allow", "POST");
      sendJson(response, 405, { error: "Use POST to upload an attachment." });
      return;
    }

    const rawFileName = request.headers["x-muse-file-name"];
    let name: string;
    try {
      name = decodeAttachmentName(
        Array.isArray(rawFileName) ? rawFileName[0] ?? "" : rawFileName ?? "",
      );
    } catch {
      sendJson(response, 400, { error: "The attachment filename is invalid." });
      return;
    }
    const mimeType = getAttachmentMimeType(name);
    if (!mimeType) {
      sendJson(response, 415, {
        error: "Attach JPEG, PNG, WebP, TXT, Markdown, or CSV files only.",
      });
      return;
    }

    let session: MuseSession | undefined;
    try {
      session = getSession(request, response);
    } catch {
      sendJson(response, 503, {
        error: "Muse's chat provider is not configured. Set its API key and try again.",
      });
      return;
    }
    if (!session) {
      sendJson(response, 503, {
        error: "Muse has reached its active session limit. Try again later.",
      });
      return;
    }
    if (session.attachments.size >= MAX_ATTACHMENTS_PER_MESSAGE) {
      sendJson(response, 413, { error: "You can attach up to three files per turn." });
      return;
    }

    const maxBytes = mimeType.startsWith("image/")
      ? MAX_IMAGE_ATTACHMENT_BYTES
      : MAX_TEXT_ATTACHMENT_BYTES;
    let bytes: Buffer;
    try {
      bytes = await readBoundedRequestBody(request, maxBytes);
    } catch (error) {
      sendJson(response, error instanceof RequestBodyTooLargeError ? 413 : 400, {
        error:
          error instanceof RequestBodyTooLargeError
            ? `Attachments must be ${mimeType.startsWith("image/") ? "4 MB" : "512 KB"} or smaller.`
            : "The attachment could not be read.",
      });
      return;
    }
    if (bytes.length === 0) {
      sendJson(response, 400, { error: "The attachment is empty." });
      return;
    }
    if (
      mimeType.startsWith("image/") &&
      !matchesImageSignature(bytes, mimeType)
    ) {
      sendJson(response, 415, { error: "The file content does not match its image type." });
      return;
    }
    if (!mimeType.startsWith("image/")) {
      try {
        const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
        if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text)) {
          throw new Error("Unsupported control characters.");
        }
      } catch {
        sendJson(response, 415, { error: "Text attachments must be valid UTF-8 text." });
        return;
      }
    }

    const sessionBytes = [...session.attachments.values()].reduce(
      (total, attachment) => total + attachment.bytes.length,
      0,
    );
    if (sessionBytes + bytes.length > MAX_ATTACHMENT_TOTAL_BYTES) {
      sendJson(response, 413, { error: "Attachments for one turn must total 8 MB or less." });
      return;
    }
    if (storedAttachmentBytes + bytes.length > MAX_SERVER_ATTACHMENT_BYTES) {
      sendJson(response, 503, { error: "Muse's temporary attachment capacity is full. Try again later." });
      return;
    }

    const id = randomBytes(16).toString("hex");
    session.attachments.set(id, { id, name, mimeType, bytes });
    storedAttachmentBytes += bytes.length;
    session.lastUsedAt = Date.now();
    sendJson(response, 201, {
      attachment: { id, name, mimeType, size: bytes.length },
    });
  }

  async function handleAttachmentDelete(
    request: IncomingMessage,
    response: ServerResponse,
    pathname: string,
  ): Promise<void> {
    if (request.method !== "DELETE") {
      response.setHeader("Allow", "DELETE");
      sendJson(response, 405, { error: "Use DELETE to remove an attachment." });
      return;
    }
    const id = pathname.slice("/api/attachments/".length);
    if (!/^[a-f0-9]{32}$/.test(id)) {
      sendJson(response, 404, { error: "Attachment not found." });
      return;
    }
    const sessionId = readSessionId(request, sessionSecret);
    const session = sessionId ? sessions.get(sessionId) : undefined;
    const attachment = session?.attachments.get(id);
    if (!session || !attachment) {
      sendJson(response, 404, { error: "Attachment not found." });
      return;
    }
    session.attachments.delete(id);
    storedAttachmentBytes = Math.max(0, storedAttachmentBytes - attachment.bytes.length);
    session.lastUsedAt = Date.now();
    sendJson(response, 200, { deleted: true });
  }

  async function handleImageGeneration(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    if (request.method !== "POST") {
      response.setHeader("Allow", "POST");
      sendJson(response, 405, { error: "Use POST to generate an image." });
      return;
    }
    if (request.headers["content-type"]?.split(";")[0]?.trim() !== "application/json") {
      sendJson(response, 415, { error: "Send the image prompt as JSON." });
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
    if (!isRecord(body) || typeof body.prompt !== "string" || !body.prompt.trim()) {
      sendJson(response, 400, { error: "An image prompt is required." });
      return;
    }
    const prompt = body.prompt.trim();
    if (prompt.length > 1_000) {
      sendJson(response, 413, { error: "Image prompts must be 1,000 characters or fewer." });
      return;
    }

    try {
      const provider = getMediaProvider();
      const retryAfterSeconds = consumeHourlyLimit(
        imageGenerationTimestamps,
        MAX_IMAGE_GENERATIONS_PER_HOUR,
      );
      if (retryAfterSeconds > 0) {
        response.setHeader("Retry-After", String(retryAfterSeconds));
        sendJson(response, 429, {
          error: "This server has reached its hourly image-generation limit. Try again later.",
        });
        return;
      }
      const image: GeneratedImage = await provider.generateImage(prompt);
      if (
        image.bytes.length === 0 ||
        image.bytes.length > 8 * 1_024 * 1_024 ||
        !matchesImageSignature(image.bytes, image.mimeType)
      ) {
        throw new Error("Image provider returned invalid image data.");
      }
      response.statusCode = 200;
      response.setHeader("Content-Type", image.mimeType);
      response.setHeader("Content-Length", String(image.bytes.length));
      response.setHeader("Content-Disposition", "inline; filename=\"mira-generated-image\"");
      response.end(image.bytes);
    } catch (error) {
      if (error instanceof CloudflareAIConfigurationError) {
        sendJson(response, 503, {
          error:
            "Image generation is not configured. Set MUSE_CLOUDFLARE_ACCOUNT_ID and MUSE_CLOUDFLARE_AI_TOKEN.",
        });
        return;
      }
      console.error(
        "Muse image generation failed:",
        error instanceof Error ? error.message : "unknown error",
      );
      sendJson(response, 502, {
        error: "Mira could not create an image. Check the server terminal.",
      });
    }
  }

  function discardSessionAttachments(session: MuseSession): void {
    for (const attachment of session.attachments.values()) {
      storedAttachmentBytes = Math.max(
        0,
        storedAttachmentBytes - attachment.bytes.length,
      );
    }
    session.attachments.clear();
  }

  async function createAttachmentContext(
    attachments: MuseAttachment[],
    question: string,
  ): Promise<string> {
    const sections: string[] = [];
    let remainingTextChars = MAX_TOTAL_ATTACHMENT_TEXT_CHARS;
    for (const attachment of attachments) {
      if (attachment.mimeType.startsWith("image/")) {
        const provider = getMediaProvider();
        const retryAfterSeconds = consumeHourlyLimit(
          imageAnalysisTimestamps,
          MAX_IMAGE_ANALYSES_PER_HOUR,
        );
        if (retryAfterSeconds > 0) {
          throw new CloudflareRateLimitError(retryAfterSeconds);
        }
        const description = await provider.describeImage(
          attachment.bytes,
          attachment.mimeType,
          question,
        );
        sections.push(
          `Image file "${attachment.name}" visual analysis (untrusted data):\n${description}`,
        );
        continue;
      }
      const text = attachment.bytes.toString("utf8");
      const visibleText = text.slice(
        0,
        Math.min(MAX_ATTACHMENT_TEXT_CHARS, remainingTextChars),
      );
      remainingTextChars -= visibleText.length;
      sections.push(
        `Text file "${attachment.name}" (untrusted data):\n${visibleText}${visibleText.length < text.length ? "\n[Attachment text truncated to the safe context limit.]" : ""}`,
      );
    }
    return sections.join("\n\n");
  }

  function enqueueResponse(
    session: MuseSession,
    message: string,
    attachmentIds: string[],
  ): Promise<string> {
    const response = session.pending.then(async () => {
      try {
        const attachments = attachmentIds.map((id) => session.attachments.get(id));
        if (attachments.some((attachment) => !attachment)) {
          throw new MissingSessionAttachmentError();
        }
        const context = await createAttachmentContext(
          attachments as MuseAttachment[],
          message,
        );
        return await session.agent.respond(message, context);
      } finally {
        for (const id of attachmentIds) {
          const attachment = session.attachments.get(id);
          if (attachment) {
            session.attachments.delete(id);
            storedAttachmentBytes = Math.max(
              0,
              storedAttachmentBytes - attachment.bytes.length,
            );
          }
        }
      }
    });
    session.pending = response.then(
      () => undefined,
      () => undefined,
    );
    return response;
  }

  function getSession(
    request: IncomingMessage,
    response: ServerResponse,
  ): MuseSession | undefined {
    const now = Date.now();
    for (const [id, session] of sessions) {
      if (now - session.lastUsedAt > sessionTtlMs) {
        discardSessionAttachments(session);
        sessions.delete(id);
      }
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
        attachments: new Map(),
      };
      sessions.set(id, session);
    }

    session.lastUsedAt = now;
    writeSessionCookie(request, response, id, sessionSecret, sessionTtlMs);
    return session;
  }
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
  response.setHeader("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; img-src https://upload.wikimedia.org blob:; form-action 'self'; base-uri 'none'; frame-ancestors 'none'");
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

function decodeAttachmentName(rawName: string): string {
  if (!rawName) throw new Error("Missing filename.");
  const decodedName = decodeURIComponent(rawName);
  const name = decodedName
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/[\\/]/g, "_")
    .trim()
    .slice(0, 120);
  if (!name || name === "." || name === "..") {
    throw new Error("Invalid filename.");
  }
  return name;
}

function getAttachmentMimeType(name: string): string | undefined {
  const extension = name.slice(name.lastIndexOf(".")).toLowerCase();
  const types: Record<string, string> = {
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".webp": "image/webp",
    ".txt": "text/plain",
    ".md": "text/markdown",
    ".markdown": "text/markdown",
    ".csv": "text/csv",
  };
  return types[extension];
}

function matchesImageSignature(bytes: Uint8Array, mimeType: string): boolean {
  if (mimeType === "image/jpeg") {
    return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  }
  if (mimeType === "image/png") {
    return (
      bytes.length >= 8 &&
      bytes[0] === 0x89 &&
      bytes[1] === 0x50 &&
      bytes[2] === 0x4e &&
      bytes[3] === 0x47 &&
      bytes[4] === 0x0d &&
      bytes[5] === 0x0a &&
      bytes[6] === 0x1a &&
      bytes[7] === 0x0a
    );
  }
  if (mimeType === "image/webp") {
    return (
      bytes.length >= 12 &&
      Buffer.from(bytes.subarray(0, 4)).toString("ascii") === "RIFF" &&
      Buffer.from(bytes.subarray(8, 12)).toString("ascii") === "WEBP"
    );
  }
  return false;
}

async function readBoundedRequestBody(
  request: IncomingMessage,
  maxBytes: number,
): Promise<Buffer> {
  const declaredLength = Number(request.headers["content-length"] ?? 0);
  if (declaredLength > maxBytes) {
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
      if (totalBytes > maxBytes) {
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
      resolve(Buffer.concat(chunks));
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
class MissingSessionAttachmentError extends Error {}
class CloudflareRateLimitError extends Error {
  constructor(readonly retryAfterSeconds: number) {
    super("Cloudflare image understanding rate limit exceeded.");
  }
}
