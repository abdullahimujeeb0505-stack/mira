import {
  createHash,
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
import type { ResearchImageFinder, ResearchRunner } from "./muse-agent.js";
import {
  CloudflareAIConfigurationError,
  CloudflareAIRequestError,
  CloudflareWorkersAIProvider,
  type GeneratedImage,
  type MuseMediaProvider,
} from "./cloudflare-workers-ai.js";
import {
  IMAGE_GENERATION_MAX_PROMPT_LENGTH,
  IMAGE_GENERATION_PROMPT_TOO_LONG_REPLY,
  IMAGE_GENERATION_USAGE_REPLY,
  parseImageGenerationCommand,
} from "./image-generation-command.js";
import { createTaskAwareProviders } from "./provider-selection.js";
import type { ConversationMessage, TextGenerationProvider } from "./llm-provider.js";
import { WEB_ANALYTICS_DASHBOARD_PAGE } from "./web-analytics-page.js";
import {
  buildWebAnalyticsReport,
  DEFAULT_WEB_ANALYTICS_RETENTION_DAYS,
  JsonWebAnalyticsStore,
  WEB_ANALYTICS_EVENT_TYPES,
  type WebAnalyticsEventType,
} from "./web-analytics.js";
import {
  JsonChatHistoryStore,
  MAX_MODEL_CONTEXT_MESSAGES,
  MAX_STORED_CHAT_MESSAGES,
} from "./chat-history-store.js";
import {
  JsonWebUserStore,
  WebAuthInputError,
  WebUsernameTakenError,
  type WebUser,
} from "./web-auth.js";

const SESSION_COOKIE_NAME = "muse_session";
const SESSION_TTL_MS = 8 * 60 * 60 * 1_000;
const ANALYTICS_VISITOR_COOKIE_NAME = "muse_analytics_visitor";
const ANALYTICS_SESSION_COOKIE_NAME = "muse_analytics_session";
const ANALYTICS_VISITOR_TTL_MS = DEFAULT_WEB_ANALYTICS_RETENTION_DAYS * 24 * 60 * 60 * 1_000;
const ANALYTICS_SESSION_TTL_MS = 30 * 60 * 1_000;
const ANALYTICS_PRUNE_INTERVAL_MS = 24 * 60 * 60 * 1_000;
const MAX_ANALYTICS_REQUEST_BYTES = 2 * 1_024;
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
const MAX_LOGIN_FAILURES = 8;
const LOGIN_FAILURE_WINDOW_MS = 15 * 60 * 1_000;
const GENERATED_IMAGE_HISTORY_NOTE = "Image generated. The image file itself is not retained in chat history.";
const MAX_IMAGE_GENERATIONS_PER_HOUR = 10;
const MAX_IMAGE_ANALYSES_PER_HOUR = 20;
const DEFAULT_MEMORY_DIRECTORY = fileURLToPath(
  new URL("../../data/muse-http-sessions/", import.meta.url),
);
const DEFAULT_WEB_ANALYTICS_FILE = fileURLToPath(
  new URL("../../data/muse-web-analytics.jsonl", import.meta.url),
);
const DEFAULT_WEB_AUTH_FILE = fileURLToPath(
  new URL("../../data/muse-web-users.json", import.meta.url),
);
const DEFAULT_CHAT_HISTORY_DIRECTORY = fileURLToPath(
  new URL("../../data/muse-web-history/", import.meta.url),
);

const MIRA_FAVICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
  <defs>
    <linearGradient id="background" x1="8" y1="5" x2="58" y2="61" gradientUnits="userSpaceOnUse">
      <stop stop-color="#b49ae8"/>
      <stop offset=".55" stop-color="#8c78d1"/>
      <stop offset="1" stop-color="#df9fbd"/>
    </linearGradient>
  </defs>
  <rect width="64" height="64" rx="19" fill="url(#background)"/>
  <g fill="#fff">
    <ellipse cx="32" cy="17.5" rx="7.8" ry="12"/>
    <ellipse cx="46.5" cy="32" rx="12" ry="7.8"/>
    <ellipse cx="32" cy="46.5" rx="7.8" ry="12"/>
    <ellipse cx="17.5" cy="32" rx="12" ry="7.8"/>
  </g>
  <circle cx="32" cy="32" r="6" fill="#ffe7a6"/>
</svg>`;

const CHAT_PAGE = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="theme-color" content="#f4effa">
    <link rel="icon" type="image/svg+xml" href="/favicon.svg">
    <title>Mira — conversational assistant by Muse</title>
    <style>
      :root {
        color-scheme: light;
        font-family: "Avenir Next", "Nunito", ui-rounded, system-ui, sans-serif;
        color: #352f47;
        background: #f4effa;
        --canvas: #f4effa;
        --paper: #fffdfd;
        --ink: #352f47;
        --muted: #756e81;
        --line: #eee8f2;
        --lilac: #765fc3;
        --shadow: 0 28px 90px #5948781c;
      }
      * { box-sizing: border-box; }
      html { width: 100%; min-width: 320px; min-height: 100%; }
      body { width: 100%; min-width: 320px; min-height: 100vh; min-height: 100dvh; display: grid; place-items: center; overflow: hidden; margin: 0; padding: 20px; background: radial-gradient(ellipse at 12% 12%, #f7e9f1 0, transparent 34%), radial-gradient(ellipse at 88% 86%, #e8e5fb 0, transparent 33%), var(--canvas); }
      main { position: relative; isolation: isolate; width: min(100%, 1120px); height: min(920px, calc(100vh - 40px)); height: min(920px, calc(100dvh - 40px)); min-height: 560px; display: flex; flex-direction: column; overflow: hidden; border: 1px solid #ffffff; border-radius: 30px; background: var(--paper); box-shadow: var(--shadow); }
      main::before, main::after { position: absolute; z-index: 0; pointer-events: none; content: ""; border-radius: 50%; filter: blur(2px); }
      main::before { top: -220px; right: -110px; width: 390px; height: 390px; background: radial-gradient(circle, #e9e3ffb8 0, #f2eaff70 48%, transparent 72%); }
      main::after { bottom: -260px; left: -180px; width: 430px; height: 430px; background: radial-gradient(circle, #f8e5efb0 0, #fff2e870 48%, transparent 72%); }
      #chat-screen { position: relative; z-index: 1; min-height: 0; display: flex; flex: 1 1 auto; flex-direction: column; }
      #chat-screen[hidden], #auth-screen[hidden] { display: none; }
      .auth-screen { position: absolute; z-index: 3; inset: 0; display: grid; place-items: center; overflow-y: auto; padding: 26px 26px 150px; background: radial-gradient(ellipse at 18% 16%, #f8e9f1 0, transparent 40%), radial-gradient(ellipse at 86% 84%, #e8e4fb 0, transparent 38%), #faf7fc; }
      .auth-card { width: min(100%, 430px); padding: 34px clamp(22px, 6vw, 38px); border: 1px solid #ffffff; border-radius: 28px; background: #fffdfd; box-shadow: 0 20px 60px #5948781c; text-align: center; }
      .auth-mark { width: 54px; height: 54px; display: grid; place-items: center; margin: 0 auto 17px; border-radius: 19px; color: #fff; background: linear-gradient(145deg, #b49ae8 2%, #8c78d1 52%, #df9fbd 100%); box-shadow: 0 7px 18px #876bc52b; }
      .auth-mark svg { width: 31px; height: 31px; fill: currentColor; }
      .auth-mark .flower-center { fill: #ffe7a6; }
      .auth-eyebrow { margin: 0 0 8px; color: var(--lilac); font-size: 10px; font-weight: 800; letter-spacing: .2em; text-transform: uppercase; }
      .auth-title { margin: 0; color: var(--ink); font-size: clamp(24px, 6vw, 30px); font-weight: 760; letter-spacing: -.05em; }
      .auth-description { margin: 10px 0 22px; color: var(--muted); font-size: 14px; line-height: 1.65; }
      #auth-form { position: relative; z-index: 1; width: 100%; display: grid; gap: 9px; margin: 0; padding: 0; text-align: left; }
      .auth-label { margin-top: 4px; color: #514961; font-size: 12px; font-weight: 700; }
      .auth-input { width: 100%; min-height: 47px; padding: 11px 14px; border: 1px solid #e8e1ed; border-radius: 14px; outline: none; color: var(--ink); background: #fff; font: inherit; font-size: 14px; }
      .auth-input:focus { border-color: #b8a8dd; box-shadow: 0 0 0 4px #a890d91c; }
      .auth-note { margin: 3px 0 5px; color: #81798c; font-size: 11px; line-height: 1.55; }
      .auth-submit { width: 100%; min-height: 47px; margin-top: 3px; border-radius: 15px; color: #fff; background: linear-gradient(145deg, #9a81da, #7259bd); box-shadow: 0 5px 13px #7259bd2b; }
      .auth-submit:hover { background: linear-gradient(145deg, #8d74d0, #634cac); }
      .auth-submit:disabled { cursor: wait; opacity: .7; }
      .auth-switch { margin: 8px 0 0; color: var(--muted); font-size: 12px; text-align: center; }
      .auth-text-button { width: auto; min-width: 0; min-height: auto; margin: 0; padding: 2px 4px; border: 0; color: #7059b4; background: transparent; box-shadow: none; font-size: inherit; font-weight: 750; }
      .auth-text-button:hover { color: #59438f; background: transparent; text-decoration: underline; }
      #auth-status { min-height: 19px; margin: 1px 0 0; color: #a34e65; font-size: 12px; line-height: 1.5; text-align: center; }
      #auth-status:empty { min-height: 0; }
      .chat-header, #messages, .attachment-list, form, #status { position: relative; z-index: 1; }
      .chat-header { display: flex; align-items: center; gap: 13px; flex: 0 0 auto; min-height: 78px; padding: 13px clamp(20px, 4vw, 38px); border-bottom: 1px solid var(--line); background: #fffdfde8; backdrop-filter: blur(14px); }
      .assistant-avatar { width: 46px; height: 46px; display: grid; flex: 0 0 auto; place-items: center; border: 1px solid #ffffffb8; border-radius: 17px; color: #fff; background: linear-gradient(145deg, #b49ae8 2%, #8c78d1 52%, #df9fbd 100%); box-shadow: 0 7px 18px #876bc52b, inset 0 1px #ffffff70; }
      .assistant-avatar svg { width: 27px; height: 27px; fill: currentColor; }
      .assistant-avatar .flower-center { fill: #ffe7a6; }
      .brand-copy { display: grid; gap: 1px; }
      .eyebrow { color: var(--lilac); font-size: 9px; font-weight: 800; letter-spacing: .2em; text-transform: uppercase; }
      h1 { margin: 0; color: var(--ink); font-size: 19px; font-weight: 750; letter-spacing: -.04em; line-height: 1.2; }
      .header-note { display: flex; align-items: center; gap: 8px; margin-left: auto; padding: 8px 12px; border: 1px solid #efe8f5; border-radius: 999px; color: var(--muted); background: #fcf8ff; font-size: 12px; font-weight: 600; }
      .header-note-icon { color: #b67ea5; font-size: 15px; line-height: 1; }
      .account-controls { display: flex; flex: 0 0 auto; align-items: center; gap: 9px; margin-left: auto; }
      .account-username { max-width: 120px; overflow: hidden; color: #655a78; font-size: 12px; font-weight: 700; text-overflow: ellipsis; white-space: nowrap; }
      .sign-out { width: 34px; min-width: 34px; min-height: 34px; height: 34px; display: grid; place-items: center; padding: 0; border: 1px solid #eee8f2; border-radius: 50%; color: #756c85; background: #fff; }
      .sign-out:hover { color: #7059b4; background: #f5f1fb; }
      .sign-out svg { width: 17px; height: 17px; fill: none; stroke: currentColor; stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round; }
      .site-footer { position: relative; z-index: 4; flex: 0 0 auto; padding: 7px 14px max(11px, env(safe-area-inset-bottom)); color: #8a8294; font-size: 10px; text-align: center; }
      .site-footer a { color: #765fc3; font-weight: 750; text-decoration: none; }
      .site-footer a:hover { color: #59438f; text-decoration: underline; }
      .visually-hidden { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
      #messages { flex: 1 1 auto; min-height: 0; min-width: 0; width: 100%; display: flex; flex-direction: column; gap: 18px; overflow-y: auto; overscroll-behavior: contain; padding: 28px clamp(18px, 6vw, 70px) 26px; scroll-behavior: smooth; scrollbar-color: #d9d0e4 transparent; scrollbar-width: thin; }
      #welcome[hidden] { display: none; }
      .welcome-screen { width: min(100%, 750px); display: flex; flex-direction: column; align-items: center; margin: auto; padding: 24px 0 34px; text-align: center; }
      .welcome-art { position: relative; width: 76px; height: 76px; display: grid; place-items: center; margin-bottom: 19px; border: 1px solid #ffffff; border-radius: 27px; background: linear-gradient(145deg, #eee7ff, #fae9f1); box-shadow: 0 12px 30px #9172bb24, inset 0 1px 2px #fff; transform: rotate(-5deg); }
      .welcome-art svg { width: 42px; height: 42px; overflow: visible; }
      .welcome-art .flower-petal { fill: #987bd4; }
      .welcome-art .flower-center { fill: #f5c975; }
      .welcome-sparkle { position: absolute; top: 8px; right: 8px; color: #d38eb0; font-size: 15px; transform: rotate(12deg); }
      .welcome-kicker { margin: 0 0 10px; color: #73589f; font-size: 10px; font-weight: 800; letter-spacing: .19em; text-transform: uppercase; }
      .welcome-title { max-width: 620px; margin: 0; color: #332b46; font-size: clamp(27px, 4vw, 38px); font-weight: 760; letter-spacing: -.055em; line-height: 1.13; }
      .welcome-description { max-width: 500px; margin: 13px 0 0; color: var(--muted); font-size: 15px; line-height: 1.7; }
      .starter-prompts { width: min(100%, 670px); display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 11px; margin-top: 29px; text-align: left; }
      .starter-prompt { min-width: 0; min-height: 76px; display: flex; align-items: center; gap: 12px; justify-content: flex-start; padding: 12px 14px; border: 1px solid #eee8f2; border-radius: 18px; color: var(--ink); background: #fff; box-shadow: 0 4px 13px #59487808; text-align: left; white-space: normal; transition: transform .18s ease, border-color .18s ease, box-shadow .18s ease, background-color .18s ease; }
      .starter-prompt:hover { transform: translateY(-2px); border-color: #d9ccef; background: #fefcff; box-shadow: 0 10px 24px #59487812; }
      .starter-prompt:focus-visible { outline: 3px solid #b4a3e7; outline-offset: 3px; }
      .prompt-icon { width: 38px; height: 38px; display: grid; flex: 0 0 auto; place-items: center; border-radius: 13px; color: #765fc3; background: #f0ebff; }
      .starter-prompt:nth-child(2) .prompt-icon { color: #ab7097; background: #fbedf4; }
      .starter-prompt:nth-child(3) .prompt-icon { color: #9a7b41; background: #fbf4df; }
      .starter-prompt:nth-child(4) .prompt-icon { color: #668d83; background: #eaf5f0; }
      .prompt-icon svg { width: 19px; height: 19px; fill: none; stroke: currentColor; stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round; }
      .prompt-copy { min-width: 0; display: grid; gap: 3px; }
      .prompt-title { color: #433a53; font-size: 13px; font-weight: 720; line-height: 1.3; }
      .prompt-description { color: #787183; font-size: 11px; font-weight: 450; line-height: 1.4; }
      .message { width: min(100%, 820px); max-width: 100%; min-width: 0; align-self: flex-start; padding: 15px 18px; border: 1px solid #eee9f2; border-radius: 8px 21px 21px 21px; background: #fff; box-shadow: 0 5px 18px #54476d09; color: #484153; line-height: 1.72; overflow-wrap: break-word; word-break: normal; white-space: pre-wrap; }
      .message.muse { align-self: flex-start; width: min(100%, 820px); padding: 14px 18px; border: 1px solid #eee9f2; border-radius: 8px 21px 21px 21px; background: #fff; color: #484153; white-space: normal; }
      .message.muse::before { display: block; margin: 0 0 7px; color: #765fa0; content: "Mira"; font-size: 11px; font-weight: 800; letter-spacing: .02em; }
      .message.muse h1, .message.muse h2, .message.muse h3, .message.muse h4, .message.muse h5, .message.muse h6 { margin: .75em 0 .4em; color: #3a314a; font-weight: 700; letter-spacing: -.025em; line-height: 1.3; }
      .message.muse p { margin: .62em 0; }
      .message.muse p:first-child { margin-top: 0; }
      .message.muse p:last-of-type { margin-bottom: 0; }
      .message.muse ul, .message.muse ol { margin: .65em 0; padding-left: 1.5em; }
      .message.muse li + li { margin-top: .28em; }
      .message.muse a { color: #7056b7; text-decoration: underline; text-decoration-color: #b3a3dc; text-underline-offset: 3px; }
      .message.muse img { display: block; max-width: min(100%, 680px); height: auto; margin: 14px 0; border-radius: 16px; box-shadow: 0 12px 36px #493c5a1a; }
      .message.muse table { border-collapse: collapse; table-layout: fixed; display: block; width: 100%; max-width: 100%; overflow-x: auto; border-radius: 12px; white-space: normal; }
      .message.muse th, .message.muse td { border: 1px solid #e8e1ed; padding: 9px 11px; text-align: left; vertical-align: top; overflow-wrap: anywhere; word-break: normal; }
      .message.muse th { color: #4b405d; background: #f7f3fb; }
      .message.muse pre { max-width: 100%; overflow-x: auto; border: 1px solid #e9e3ee; border-radius: 14px; padding: 14px 16px; background: #f8f6fb; white-space: pre; }
      .message.muse code { border-radius: 6px; padding: .12em .35em; color: #684e9b; background: #f1ecf8; overflow-wrap: anywhere; white-space: break-spaces; }
      .message.muse pre code { padding: 0; color: inherit; background: transparent; }
      .message.you { width: auto; max-width: min(78%, 760px); align-self: flex-end; margin-left: auto; border: 1px solid #e5dcf7; border-radius: 21px 21px 6px 21px; padding: 12px 17px; background: #f0eaff; box-shadow: 0 5px 16px #6652910b; color: #4e4267; }
      form { width: min(100%, 850px); flex: 0 0 auto; display: flex; flex-direction: column; gap: 9px; margin: 0 auto; padding: 0 clamp(16px, 5vw, 54px) 3px; }
      .composer-shell { display: grid; grid-template-columns: 46px minmax(0, 1fr); align-items: end; gap: 10px; }
      .action-area { position: relative; }
      button { display: inline-flex; align-items: center; justify-content: center; min-width: 44px; min-height: 44px; border: 0; border-radius: 999px; padding: 0 14px; color: #f9f7ff; background: #765fc3; font: inherit; font-weight: 700; cursor: pointer; touch-action: manipulation; transition: background-color .16s ease, border-color .16s ease, transform .16s ease, box-shadow .16s ease; }
      button:focus-visible { outline: 3px solid #a997df; outline-offset: 3px; }
      button:disabled { cursor: wait; opacity: .58; }
      .icon-button { width: 46px; height: 46px; padding: 0; border: 1px solid #e9e2ef; color: #8068ae; background: #fff; box-shadow: 0 4px 14px #5948780b; font-size: 25px; font-weight: 450; }
      .icon-button:hover { border-color: #d9cdec; color: #6852a7; background: #fcfaff; }
      .icon-button svg, .composer-icon svg { width: 20px; height: 20px; fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
      #attachment-menu { position: absolute; z-index: 3; left: 0; bottom: calc(100% + 12px); width: max-content; min-width: 220px; display: flex; flex-direction: column; gap: 4px; padding: 7px; border: 1px solid #ece5f1; border-radius: 17px; background: #fffdfd; box-shadow: 0 16px 44px #40334f24; }
      #attachment-menu[hidden] { display: none; }
      .menu-item { justify-content: flex-start; width: 100%; min-height: 44px; border-radius: 12px; padding: 0 12px; color: #51465f; background: transparent; font-size: 13px; text-align: left; }
      .menu-item:hover, .menu-item:focus-visible { color: #59438f; background: #f5f1fb; }
      .composer-box { min-width: 0; display: flex; align-items: flex-end; gap: 5px; padding: 6px 7px 6px 16px; border: 1px solid #e8e1ed; border-radius: 25px; background: #fff; box-shadow: 0 8px 26px #57476910; transition: border-color .16s ease, box-shadow .16s ease; }
      .composer-box:focus-within { border-color: #b8a8dd; box-shadow: 0 0 0 4px #a890d91c, 0 8px 26px #57476910; }
      textarea { flex: 1; width: 100%; min-width: 0; min-height: 44px; max-height: 160px; overflow-y: auto; resize: none; border: 0; outline: 0; padding: 10px 2px; color: var(--ink); background: transparent; font: inherit; font-size: 15px; line-height: 1.5; }
      textarea::placeholder { color: var(--muted); }
      .composer-icon { flex: 0 0 auto; width: 40px; height: 40px; min-width: 40px; min-height: 40px; padding: 0; border-radius: 50%; color: #9a8baa; background: transparent; }
      .composer-icon:hover { color: #7059b4; background: #f3eff9; }
      .composer-icon.listening { color: #fff; background: #c87391; box-shadow: 0 0 0 4px #f5e2eb; }
      #send { flex: 0 0 auto; width: 40px; height: 40px; min-width: 40px; min-height: 40px; padding: 0; border-radius: 50%; color: #fff; background: linear-gradient(145deg, #9a81da, #7259bd); box-shadow: 0 5px 13px #7259bd38; }
      #send:hover { background: linear-gradient(145deg, #8d74d0, #634cac); box-shadow: 0 7px 17px #7259bd4a; transform: translateY(-1px); }
      #send svg { width: 19px; height: 19px; fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
      .attachment-list { width: min(100%, 850px); display: flex; flex-wrap: wrap; gap: 8px; margin: 0 auto; padding: 0 clamp(16px, 5vw, 54px); }
      .attachment-chip { display: inline-flex; gap: 8px; align-items: center; max-width: 100%; padding: 5px 7px 5px 11px; border: 1px solid #e9e2ef; border-radius: 999px; color: #655973; background: #fff; box-shadow: 0 3px 10px #59487808; font-size: 12px; }
      .attachment-chip > span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .attachment-remove { min-height: 30px; padding: 0 9px; color: #7059a4; background: #f1ecf9; font-size: 12px; }
      .message-actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 10px; }
      .speak-button, .download-button { width: 38px; min-width: 38px; min-height: 38px; height: 38px; display: inline-flex; align-items: center; justify-content: center; padding: 0; border: 1px solid #e7deef; border-radius: 50%; color: #735ca8; background: #f5f1fb; box-shadow: 0 3px 10px #5948780a; cursor: pointer; text-decoration: none; transition: transform .16s ease, background-color .16s ease, border-color .16s ease, box-shadow .16s ease; }
      .speak-button:hover, .download-button:hover { transform: translateY(-1px); border-color: #d8ccea; color: #634cae; background: #eee8f8; box-shadow: 0 5px 14px #59487814; }
      .speak-button:focus-visible, .download-button:focus-visible { outline: 3px solid #b4a3e7; outline-offset: 3px; }
      .speak-button svg, .download-button svg { width: 18px; height: 18px; fill: none; stroke: currentColor; stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round; }
      .generated-image { display: block; max-width: min(100%, 680px); height: auto; border-radius: 16px; box-shadow: 0 12px 36px #493c5a1a; }
      .composer-hint { width: min(100%, 850px); margin: 0 auto; padding: 0 clamp(16px, 5vw, 54px) 12px; color: #786f83; font-size: 10px; line-height: 1.4; text-align: center; }
      .composer-hint span { color: #b38fc0; }
      #status { width: min(100%, 850px); align-self: center; flex: 0 0 auto; margin: 0 auto; padding: 0 clamp(16px, 5vw, 54px) 10px; color: var(--muted); font-size: 12px; line-height: 1.5; text-align: center; overflow-wrap: anywhere; }
      #status:empty { display: none; }
      .analytics-preferences { flex: 0 0 auto; margin: 0 auto 8px; text-align: center; }
      #analytics-settings { min-width: 0; min-height: 30px; padding: 0 8px; color: #796e8a; background: transparent; box-shadow: none; font-size: 10px; font-weight: 650; }
      #analytics-settings:hover { color: #624b9c; text-decoration: underline; }
      .analytics-preferences a { color: #796e8a; font-size: 10px; font-weight: 650; text-decoration: none; }
      .analytics-preferences a:hover { color: #624b9c; text-decoration: underline; }
      #analytics-consent { width: min(calc(100% - 32px), 820px); display: flex; flex: 0 0 auto; align-items: center; justify-content: space-between; gap: 14px; margin: 0 auto 10px; padding: 12px 15px; border: 1px solid #e8e1ed; border-radius: 16px; color: #544b62; background: #fcf9ff; box-shadow: 0 7px 22px #59487812; }
      #analytics-consent[hidden] { display: none; }
      .analytics-consent-copy { min-width: 0; }
      .analytics-consent-title { margin: 0 0 3px; color: #443a55; font-size: 12px; font-weight: 800; }
      .analytics-consent-description { margin: 0; color: #756e81; font-size: 11px; line-height: 1.5; }
      .analytics-consent-actions { display: flex; flex: 0 0 auto; align-items: center; gap: 7px; }
      .analytics-consent-actions button { min-width: 0; min-height: 36px; padding: 0 12px; font-size: 11px; }
      #analytics-decline { border: 1px solid #e7deef; color: #695a82; background: #fff; box-shadow: none; }
      #analytics-decline:hover { background: #f6f2fb; }
      @media (max-width: 620px) {
        body { padding: 0; }
        main { width: 100%; height: 100vh; height: 100dvh; min-height: 0; border: 0; border-radius: 0; box-shadow: none; }
        .auth-screen { padding: 18px 18px 150px; }
        .auth-card { padding: 29px 23px; border-radius: 25px; }
        .chat-header { min-height: 68px; gap: 9px; padding: 10px max(16px, env(safe-area-inset-left)); }
        .assistant-avatar { width: 42px; height: 42px; border-radius: 15px; }
        .header-note { display: none; }
        .account-controls { gap: 6px; }
        .account-username { max-width: 90px; font-size: 11px; }
        .site-footer { padding-bottom: max(11px, env(safe-area-inset-bottom)); }
        #messages { gap: 14px; padding: 22px 16px 18px; }
        .welcome-screen { padding: 18px 0 24px; }
        .welcome-art { width: 67px; height: 67px; margin-bottom: 16px; border-radius: 23px; }
        .welcome-art svg { width: 38px; height: 38px; }
        .welcome-title { font-size: clamp(27px, 8vw, 34px); }
        .welcome-description { max-width: 360px; margin-top: 10px; font-size: 14px; }
        .starter-prompts { grid-template-columns: 1fr; gap: 8px; margin-top: 22px; }
        .starter-prompt { min-height: 65px; padding: 9px 11px; border-radius: 16px; }
        .prompt-icon { width: 35px; height: 35px; border-radius: 12px; }
        .message.you { max-width: 91%; }
        .message.muse { padding: 13px 15px; }
        form { padding: 0 12px max(2px, env(safe-area-inset-bottom)); }
        .composer-shell { grid-template-columns: 42px minmax(0, 1fr); gap: 8px; }
        .icon-button { width: 42px; height: 42px; min-width: 42px; min-height: 42px; }
        .composer-box { gap: 2px; padding-left: 11px; }
        .composer-icon { width: 36px; height: 36px; min-width: 36px; min-height: 36px; }
        #send { width: 38px; height: 38px; min-width: 38px; min-height: 38px; }
        .attachment-list { padding-right: 12px; padding-left: 12px; }
        #status { padding-right: 12px; padding-left: 12px; }
        .composer-hint { padding-right: 12px; padding-left: 12px; }
        #analytics-consent { width: calc(100% - 24px); align-items: stretch; flex-direction: column; gap: 9px; margin-bottom: 8px; padding: 11px 12px; }
        .analytics-consent-actions { justify-content: flex-end; }
      }
      @media (max-width: 380px) {
        .header-note { padding: 7px; }
        .header-note-copy { display: none; }
        .welcome-title { font-size: 27px; }
      }
      @media (max-height: 640px) {
        body { padding: 0; }
        main { height: 100vh; height: 100dvh; min-height: 0; border-radius: 0; }
        .chat-header { min-height: 62px; }
        #messages { padding-top: 16px; padding-bottom: 14px; }
        .welcome-screen { padding: 8px 0 16px; }
        .welcome-art { width: 58px; height: 58px; margin-bottom: 10px; }
        .welcome-art svg { width: 32px; height: 32px; }
        .welcome-kicker { margin-bottom: 7px; }
        .welcome-title { font-size: 27px; }
        .welcome-description { margin-top: 7px; }
        .starter-prompts { margin-top: 16px; }
      }
      @media (prefers-reduced-motion: reduce) {
        #messages { scroll-behavior: auto; }
        button, .composer-box { transition: none; }
      }
    </style>
  </head>
  <body>
    <main>
      <section id="auth-screen" class="auth-screen" aria-labelledby="auth-title">
        <div class="auth-card">
          <div class="auth-mark" aria-hidden="true">
            <svg viewBox="0 0 32 32"><ellipse cx="16" cy="8.8" rx="4.2" ry="6.4"/><ellipse cx="23.2" cy="16" rx="6.4" ry="4.2"/><ellipse cx="16" cy="23.2" rx="4.2" ry="6.4"/><ellipse cx="8.8" cy="16" rx="6.4" ry="4.2"/><circle class="flower-center" cx="16" cy="16" r="3.1"/></svg>
          </div>
          <p class="auth-eyebrow">MUSE AI · YOUR PRIVATE SPACE</p>
          <h1 id="auth-title" class="auth-title">Welcome back</h1>
          <p id="auth-description" class="auth-description">Sign in to pick up where you left off. Your conversation history is saved to your account.</p>
          <form id="auth-form">
            <label class="auth-label" for="auth-username">Username</label>
            <input id="auth-username" class="auth-input" name="username" type="text" autocomplete="username" autocapitalize="none" spellcheck="false" minlength="3" maxlength="24" required>
            <label class="auth-label" for="auth-password">Password</label>
            <input id="auth-password" class="auth-input" name="password" type="password" autocomplete="current-password" minlength="8" maxlength="128" required>
            <p id="auth-note" class="auth-note">No email is needed. Keep your password safe; there is no email reset yet.</p>
            <button id="auth-submit" class="auth-submit" type="submit">Sign in</button>
            <p class="auth-switch"><span id="auth-switch-copy">New to Mira?</span> <button id="auth-toggle" class="auth-text-button" type="button">Create an account</button></p>
            <p id="auth-status" role="status" aria-live="polite"></p>
          </form>
        </div>
      </section>
      <div id="chat-screen" hidden>
      <header class="chat-header">
        <div class="assistant-avatar" aria-hidden="true">
          <svg viewBox="0 0 32 32"><ellipse cx="16" cy="8.8" rx="4.2" ry="6.4"/><ellipse cx="23.2" cy="16" rx="6.4" ry="4.2"/><ellipse cx="16" cy="23.2" rx="4.2" ry="6.4"/><ellipse cx="8.8" cy="16" rx="6.4" ry="4.2"/><circle class="flower-center" cx="16" cy="16" r="3.1"/></svg>
        </div>
        <div class="brand-copy">
          <div class="eyebrow">MUSE AI</div>
          <h1>Mira</h1>
        </div>
        <div class="header-note"><span class="header-note-icon" aria-hidden="true">✿</span><span class="header-note-copy">Here for your next idea</span></div>
        <div class="account-controls">
          <span id="account-username" class="account-username"></span>
          <button id="sign-out" class="sign-out" type="button" aria-label="Sign out" title="Sign out">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M10 17l5-5-5-5M15 12H3"/><path d="M12 3h6a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-6"/></svg>
          </button>
        </div>
      </header>
      <section id="messages" aria-live="polite" aria-label="Conversation" aria-relevant="additions">
        <div id="welcome" class="welcome-screen">
          <div class="welcome-art" aria-hidden="true">
            <svg viewBox="0 0 48 48"><ellipse class="flower-petal" cx="24" cy="11.5" rx="6.2" ry="9.4"/><ellipse class="flower-petal" cx="36.5" cy="24" rx="9.4" ry="6.2"/><ellipse class="flower-petal" cx="24" cy="36.5" rx="6.2" ry="9.4"/><ellipse class="flower-petal" cx="11.5" cy="24" rx="9.4" ry="6.2"/><circle class="flower-center" cx="24" cy="24" r="4.8"/></svg>
            <span class="welcome-sparkle">✦</span>
          </div>
          <p class="welcome-kicker">A LITTLE SPACE FOR BIG IDEAS</p>
          <h2 class="welcome-title">Hi, I’m Mira. How can I help?</h2>
          <p class="welcome-description">Bring me a question, a half-formed thought, or a little task. We’ll figure it out together.</p>
          <div class="starter-prompts" role="group" aria-label="Suggested ways to start">
            <button class="starter-prompt" type="button" data-prompt="Help me brainstorm some fresh ideas for a project.">
              <span class="prompt-icon" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M12 3 13.8 9.2 20 11l-6.2 1.8L12 19l-1.8-6.2L4 11l6.2-1.8L12 3Z"/><path d="m19 15 .9 2.1L22 18l-2.1.9L19 21l-.9-2.1L16 18l2.1-.9L19 15Z"/></svg></span>
              <span class="prompt-copy"><span class="prompt-title">Brainstorm with me</span><span class="prompt-description">Find a fresh angle for your idea.</span></span>
            </button>
            <button class="starter-prompt" type="button" data-prompt="Research a topic and give me a clear, sourced summary.">
              <span class="prompt-icon" aria-hidden="true"><svg viewBox="0 0 24 24"><circle cx="10.8" cy="10.8" r="6.8"/><path d="m16 16 4.5 4.5M8.5 10.8h4.6M10.8 8.5v4.6"/></svg></span>
              <span class="prompt-copy"><span class="prompt-title">Explore a question</span><span class="prompt-description">Get a thoughtful, sourced answer.</span></span>
            </button>
            <button class="starter-prompt" type="button" data-prompt="Help me draft a warm, polished message.">
              <span class="prompt-icon" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="m4 16.5 9.8-9.8a2.1 2.1 0 0 1 3 0l.5.5a2.1 2.1 0 0 1 0 3L7.5 20H4v-3.5Z"/><path d="m12.5 8 3.5 3.5M4 21h16"/></svg></span>
              <span class="prompt-copy"><span class="prompt-title">Make it sound lovely</span><span class="prompt-description">Draft, polish, or reshape your words.</span></span>
            </button>
            <button class="starter-prompt" type="button" data-prompt="Help me turn my goal into a simple plan.">
              <span class="prompt-icon" aria-hidden="true"><svg viewBox="0 0 24 24"><rect x="4" y="5" width="16" height="15" rx="3"/><path d="M8 3v4M16 3v4M4 10h16M8 14h3M8 17h6"/></svg></span>
              <span class="prompt-copy"><span class="prompt-title">Make a gentle plan</span><span class="prompt-description">Turn a big goal into small steps.</span></span>
            </button>
          </div>
        </div>
      </section>
      <div id="attachment-list" class="attachment-list" aria-label="Pending attachments"></div>
      <form id="chat-form">
        <input id="attachment-files" class="visually-hidden" type="file" tabindex="-1" multiple accept="image/jpeg,image/png,image/webp,text/plain,text/markdown,text/csv,.jpg,.jpeg,.png,.webp,.txt,.md,.markdown,.csv">
        <div class="composer-shell">
          <div class="action-area">
            <button id="attachment-menu-toggle" class="icon-button" type="button" aria-label="Open attachments and image actions" aria-haspopup="menu" aria-expanded="false" aria-controls="attachment-menu">
              <span aria-hidden="true">+</span>
            </button>
            <div id="attachment-menu" role="menu" aria-label="Composer actions" hidden>
              <button id="attach" class="menu-item" type="button" role="menuitem">Attach photos or files</button>
              <button id="generate-image" class="menu-item" type="button" role="menuitem">Generate an image</button>
            </div>
          </div>
          <div class="composer-box">
            <label for="message" class="visually-hidden">Message to Mira</label>
            <textarea id="message" name="message" rows="1" maxlength="4000" placeholder="Message Mira…" required></textarea>
            <button id="voice-input" class="composer-icon" type="button" aria-label="Dictate a message" title="Dictate a message">
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 14a3 3 0 0 0 3-3V6a3 3 0 0 0-6 0v5a3 3 0 0 0 3 3Z"/><path d="M19 11a7 7 0 0 1-14 0M12 18v4m-4 0h8"/></svg>
            </button>
            <button id="send" type="submit" aria-label="Send message" title="Send message">
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 19V5m-7 7 7-7 7 7"/></svg>
            </button>
          </div>
        </div>
      </form>
      <p class="composer-hint"><span aria-hidden="true">✦</span> Any question, big idea, or tiny task is welcome.</p>
      <p id="status" role="status" aria-live="polite"></p>
      </div>
      <footer class="site-footer">
        <section id="analytics-consent" aria-labelledby="analytics-consent-title" aria-describedby="analytics-consent-description" hidden>
          <div class="analytics-consent-copy">
            <p id="analytics-consent-title" class="analytics-consent-title">Help improve Mira?</p>
            <p id="analytics-consent-description" class="analytics-consent-description">Allow anonymous, first-party visit and feature counts. Analytics does not record chat text, prompts, file contents, IP addresses, or full referrers. You can change this choice later.</p>
          </div>
          <div class="analytics-consent-actions">
            <button id="analytics-decline" type="button">No thanks</button>
            <button id="analytics-accept" type="button">Allow analytics</button>
          </div>
        </section>
        <p class="analytics-preferences"><button id="analytics-settings" type="button">Privacy &amp; analytics choices</button><span aria-hidden="true"> · </span><a href="/analytics">Site analytics</a></p>
        <span class="site-credit">Built by <a href="https://x.com/Great_mujey" target="_blank" rel="noopener noreferrer">Great_mujey</a></span>
      </footer>
    </main>
    <script>
      const form = document.querySelector("#chat-form");
      const input = document.querySelector("#message");
      const button = document.querySelector("#send");
      const messages = document.querySelector("#messages");
      const welcome = document.querySelector("#welcome");
      const status = document.querySelector("#status");
      const analyticsConsentPanel = document.querySelector("#analytics-consent");
      const analyticsAcceptButton = document.querySelector("#analytics-accept");
      const analyticsDeclineButton = document.querySelector("#analytics-decline");
      const analyticsSettingsButton = document.querySelector("#analytics-settings");
      const ANALYTICS_CONSENT_KEY = "muse-analytics-consent";
      let analyticsRequestQueue = Promise.resolve();
      let analyticsConsent = "unknown";
      try {
        analyticsConsent = localStorage.getItem(ANALYTICS_CONSENT_KEY) || "unknown";
      } catch {}

      function recordAnalyticsEvent(type) {
        if (analyticsConsent !== "accepted") return;
        analyticsRequestQueue = analyticsRequestQueue
          .then(() => fetch("/api/analytics/collect", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ type, path: location.pathname }),
            keepalive: true,
          }))
          .catch(() => {});
      }

      function isExplicitImageGenerationCommand(message) {
        return /^(?:\\/(?:imagine|image|generate-image)\\b|(?:please\\s+)?(?:(?:can|could|would)\\s+you\\s+)?(?:please\\s+)?(?:generate|create|make|draw|paint|illustrate)\\s+(?:me\\s+)?(?:an?\\s+)?(?:image|picture|illustration|artwork|visual)\\b)/i.test(message.trim());
      }

      function chooseAnalyticsConsent(choice) {
        analyticsConsent = choice;
        try { localStorage.setItem(ANALYTICS_CONSENT_KEY, choice); } catch {}
        analyticsConsentPanel.hidden = true;
        if (choice === "accepted") {
          recordAnalyticsEvent("page_view");
        } else {
          analyticsRequestQueue = analyticsRequestQueue
            .then(() => fetch("/api/analytics/forget", { method: "POST", keepalive: true }))
            .catch(() => {});
        }
      }

      analyticsAcceptButton.addEventListener("click", () => chooseAnalyticsConsent("accepted"));
      analyticsDeclineButton.addEventListener("click", () => chooseAnalyticsConsent("declined"));
      analyticsSettingsButton.addEventListener("click", () => {
        analyticsConsentPanel.hidden = false;
        analyticsAcceptButton.focus();
      });
      if (analyticsConsent === "accepted") {
        analyticsConsentPanel.hidden = true;
        recordAnalyticsEvent("page_view");
      } else if (analyticsConsent === "declined") {
        analyticsConsentPanel.hidden = true;
      } else {
        analyticsConsentPanel.hidden = false;
      }

      const authScreen = document.querySelector("#auth-screen");
      const chatScreen = document.querySelector("#chat-screen");
      const authForm = document.querySelector("#auth-form");
      const authUsername = document.querySelector("#auth-username");
      const authPassword = document.querySelector("#auth-password");
      const authTitle = document.querySelector("#auth-title");
      const authDescription = document.querySelector("#auth-description");
      const authNote = document.querySelector("#auth-note");
      const authSubmit = document.querySelector("#auth-submit");
      const authToggle = document.querySelector("#auth-toggle");
      const authSwitchCopy = document.querySelector("#auth-switch-copy");
      const authStatus = document.querySelector("#auth-status");
      const accountUsername = document.querySelector("#account-username");
      const signOutButton = document.querySelector("#sign-out");
      let authMode = "login";

      messages.addEventListener("click", (event) => {
        const promptButton = event.target?.closest?.("button[data-prompt]");
        const prompt = promptButton?.dataset?.prompt;
        if (typeof prompt !== "string" || !prompt) return;
        input.value = prompt;
        updateComposerHeight();
        input.focus();
      });

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
            if (match && url && url.protocol === "https:" && (url.hostname === "upload.wikimedia.org" || url.hostname === "api.openverse.org")) {
              const image = document.createElement("img");
              // Long replies can place images outside the active scroll area.
              image.loading = "eager";
              image.referrerPolicy = "no-referrer";
              image.src = url.href;
              image.alt = match[1];
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
      const actionMenuToggle = document.querySelector("#attachment-menu-toggle");
      const actionMenu = document.querySelector("#attachment-menu");
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
      let actionMenuOpen = false;

      function setActionMenuOpen(open, returnFocus = false) {
        actionMenuOpen = open;
        actionMenu.hidden = !open;
        actionMenuToggle.setAttribute("aria-expanded", String(open));
        if (open) attachButton.focus();
        else if (returnFocus) actionMenuToggle.focus();
      }

      actionMenuToggle.addEventListener("click", () => {
        if (busy) return;
        setActionMenuOpen(!actionMenuOpen);
      });
      document.addEventListener("click", (event) => {
        if (
          actionMenuOpen &&
          !actionMenu.contains(event.target) &&
          !actionMenuToggle.contains(event.target)
        ) {
          setActionMenuOpen(false);
        }
      });
      actionMenu.addEventListener("keydown", (event) => {
        const menuItems = [attachButton, imageButton];
        const activeIndex = menuItems.indexOf(event.target);
        if (event.key === "Escape") {
          event.preventDefault();
          setActionMenuOpen(false, true);
          return;
        }
        if (
          event.key === "Tab" &&
          ((!event.shiftKey && activeIndex === menuItems.length - 1) ||
            (event.shiftKey && activeIndex === 0))
        ) {
          event.preventDefault();
          setActionMenuOpen(false);
          if (event.shiftKey) actionMenuToggle.focus();
          else input.focus();
          return;
        }
        if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
          event.preventDefault();
          const nextIndex = event.key === "Home"
            ? 0
            : event.key === "End"
              ? menuItems.length - 1
              : (activeIndex + (event.key === "ArrowDown" ? 1 : -1) + menuItems.length) % menuItems.length;
          menuItems[nextIndex].focus();
        }
      });

      function setBusy(value) {
        busy = value;
        button.disabled = value;
        signOutButton.disabled = value;
        actionMenuToggle.disabled = value;
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
            if (response.status === 401) {
              setAuthMode("login");
              showAuth("Your sign-in expired. Please sign in again.");
            }
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

      attachButton.addEventListener("click", () => {
        setActionMenuOpen(false, true);
        attachmentFiles.click();
      });
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
              throw new Error("Attach JPEG, PNG, WebP, TXT, Markdown, or CSV files only.");
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
            if (!response.ok) {
              if (response.status === 401) {
                setAuthMode("login");
                showAuth("Your sign-in expired. Please sign in again.");
              }
              throw new Error(result.error || "Could not upload " + file.name + ".");
            }
            attachments.push(result.attachment);
            recordAnalyticsEvent("attachment_uploaded");
            renderAttachments();
          }
          status.textContent = "Attachment ready. It will be discarded after your next message.";
        } catch (error) {
          status.textContent = error instanceof Error ? error.message : "Could not upload that file.";
        } finally {
          setBusy(false);
        }
      });

      function createActionIcon(paths) {
        const namespace = "http://www.w3.org/2000/svg";
        const svg = document.createElementNS(namespace, "svg");
        svg.setAttribute("viewBox", "0 0 24 24");
        svg.setAttribute("aria-hidden", "true");
        svg.setAttribute("focusable", "false");
        for (const pathData of paths) {
          const path = document.createElementNS(namespace, "path");
          path.setAttribute("d", pathData);
          svg.append(path);
        }
        return svg;
      }

      function addMessage(kind, text) {
        if (welcome) welcome.hidden = true;
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
            speak.setAttribute("aria-label", "Read Mira's response aloud");
            speak.append(createActionIcon([
              "M11 5 6 9H3v6h3l5 4V5Z",
              "M15.5 8.5a5 5 0 0 1 0 7",
              "M18.5 5.5a9 9 0 0 1 0 13",
            ]));
            speak.title = "Read aloud";
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
        download.className = "download-button";
        download.href = objectUrl;
        download.setAttribute("aria-label", "Download image");
        download.title = "Download image";
        const extension = blob.type === "image/png" ? "png" : blob.type === "image/webp" ? "webp" : "jpg";
        download.download = "mira-generated-image." + extension;
        download.append(createActionIcon([
          "M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4",
          "m7 10 5 5 5-5",
          "M12 15V3",
        ]));
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
        if (response.status === 401) {
          setAuthMode("login");
          showAuth("Your sign-in expired. Please sign in again.");
        }
        return result.error || fallback;
      }

      function setAuthMode(mode) {
        authMode = mode === "register" ? "register" : "login";
        const registering = authMode === "register";
        authTitle.textContent = registering ? "Create your Mira account" : "Welcome back";
        authDescription.textContent = registering
          ? "Choose a username and password to keep your conversation history for next time."
          : "Sign in to pick up where you left off. Your conversation history is saved to your account.";
        authNote.textContent = registering
          ? "Usernames use 3–24 letters, numbers, or underscores. Passwords need at least 8 characters; there is no email reset yet."
          : "No email is needed. Keep your password safe; there is no email reset yet.";
        authPassword.autocomplete = registering ? "new-password" : "current-password";
        authSwitchCopy.textContent = registering ? "Already have an account?" : "New to Mira?";
        authToggle.textContent = registering ? "Sign in" : "Create an account";
        authSubmit.textContent = registering ? "Create my account" : "Sign in";
        authStatus.textContent = "";
      }

      function showAuth(message = "") {
        authScreen.hidden = false;
        chatScreen.hidden = true;
        authStatus.textContent = message;
        authPassword.value = "";
        authUsername.focus();
      }

      async function loadChatHistory() {
        messages.replaceChildren();
        welcome.hidden = false;
        messages.append(welcome);
        try {
          const response = await fetch("/api/history");
          if (response.status === 401) {
            setAuthMode("login");
            showAuth("Your sign-in expired. Please sign in again.");
            return;
          }
          if (!response.ok) throw new Error("Chat history could not be loaded.");
          const result = await response.json();
          const history = Array.isArray(result.messages) ? result.messages : [];
          const validMessages = history.filter((item) =>
            item &&
            (item.role === "user" || item.role === "assistant") &&
            typeof item.content === "string",
          );
          if (!validMessages.length) return;
          welcome.hidden = true;
          for (const item of validMessages) {
            addMessage(item.role === "user" ? "you" : "muse", item.content);
          }
          messages.scrollTop = messages.scrollHeight;
        } catch (error) {
          status.textContent = error instanceof Error
            ? error.message
            : "Chat history could not be loaded.";
        }
      }

      async function enterChat(user) {
        authScreen.hidden = true;
        chatScreen.hidden = false;
        accountUsername.textContent = user.username;
        status.textContent = "";
        authPassword.value = "";
        await loadChatHistory();
        if (!chatScreen.hidden) input.focus();
      }

      authToggle.addEventListener("click", () => {
        setAuthMode(authMode === "login" ? "register" : "login");
      });

      authForm.addEventListener("submit", async (event) => {
        event.preventDefault();
        if (authSubmit.disabled) return;
        authStatus.textContent = "";
        authSubmit.disabled = true;
        authToggle.disabled = true;
        try {
          const endpoint = authMode === "register"
            ? "/api/auth/register"
            : "/api/auth/login";
          const response = await fetch(endpoint, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              username: authUsername.value.trim(),
              password: authPassword.value,
            }),
          });
          const result = await response.json().catch(() => ({}));
          if (!response.ok) {
            throw new Error(result.error || "Could not sign in. Please try again.");
          }
          if (!result.user || typeof result.user.username !== "string") {
            throw new Error("Mira could not verify this account.");
          }
          await enterChat(result.user);
        } catch (error) {
          authStatus.textContent = error instanceof Error
            ? error.message
            : "Could not sign in. Please try again.";
        } finally {
          authSubmit.disabled = false;
          authToggle.disabled = false;
        }
      });

      signOutButton.addEventListener("click", async () => {
        signOutButton.disabled = true;
        try {
          const response = await fetch("/api/auth/logout", { method: "POST" });
          if (!response.ok) throw new Error("Could not sign out. Please try again.");
          messages.replaceChildren(welcome);
          welcome.hidden = false;
          attachments = [];
          renderAttachments();
          input.value = "";
          updateComposerHeight();
          setAuthMode("login");
          showAuth();
        } catch (error) {
          status.textContent = error instanceof Error
            ? error.message
            : "Could not sign out. Please try again.";
        } finally {
          signOutButton.disabled = false;
        }
      });

      async function checkAuth() {
        try {
          const response = await fetch("/api/auth/me");
          const result = await response.json();
          if (response.ok && result.authenticated && result.user) {
            await enterChat(result.user);
          } else {
            showAuth();
          }
        } catch {
          showAuth("Could not reach the sign-in service. Please try again.");
        }
      }

      form.addEventListener("submit", async (event) => {
        event.preventDefault();
        const message = input.value.trim();
        if (!message || busy) return;
        setActionMenuOpen(false);
        const submittedAttachments = attachments.slice();
        addMessage("you", message + (submittedAttachments.length
          ? "\\n[Attached: " + submittedAttachments.map((file) => file.name).join(", ") + "]"
          : ""));
        input.value = "";
        updateComposerHeight();
        setBusy(true);
        status.textContent = "Mira is thinking…";
        recordAnalyticsEvent(
          isExplicitImageGenerationCommand(message)
            ? "image_generation_requested"
            : "chat_message_sent",
        );
        try {
          const response = await fetch("/api/chat", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              message,
              attachmentIds: submittedAttachments.map((attachment) => attachment.id)
            })
          });
          if (!response.ok) {
            throw new Error(await readError(response, "Mira could not reply."));
          }
          const contentType = response.headers.get("content-type") || "";
          if (contentType.startsWith("image/")) {
            addGeneratedImage(await response.blob());
            status.textContent = "Image ready. Use the download icon to save it.";
          } else {
            const result = await response.json();
            addMessage("muse", result.reply);
            status.textContent = Array.isArray(result.notices)
              ? result.notices.filter((notice) => typeof notice === "string").join(" ")
              : "";
          }
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
        setActionMenuOpen(false);
        input.focus();
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
        updateComposerHeight();
        setBusy(true);
        status.textContent = "Mira is creating your image…";
        recordAnalyticsEvent("image_generation_requested");
        try {
          const response = await fetch("/api/images/generate", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ prompt })
          });
          if (!response.ok) throw new Error(await readError(response, "Image generation failed."));
          const blob = await response.blob();
          addGeneratedImage(blob);
          status.textContent = "Image ready. Use the download icon to save it.";
        } catch (error) {
          status.textContent = error instanceof Error ? error.message : "Image generation failed.";
        } finally {
          setBusy(false);
          input.focus();
        }
      });

      function updateComposerHeight() {
        input.style.height = "auto";
        input.style.height = Math.min(input.scrollHeight, 144) + "px";
      }

      input.addEventListener("input", updateComposerHeight);
      input.addEventListener("keydown", (event) => {
        if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
          event.preventDefault();
          form.requestSubmit();
        }
      });

      let voiceRecognition = null;
      let voiceBaseText = "";
      let voiceFinalText = "";
      function setVoiceButtonListening(listening) {
        voiceButton.className = listening ? "composer-icon listening" : "composer-icon";
        voiceButton.setAttribute(
          "aria-label",
          listening ? "Listening for your message" : "Dictate a message",
        );
        voiceButton.title = listening ? "Listening…" : "Dictate a message";
      }

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
          updateComposerHeight();
        };
        voiceRecognition.onerror = (event) => {
          status.textContent = event.error === "not-allowed"
            ? "Microphone permission was denied. You can type your message instead."
            : "Speech recognition was unavailable. You can type your message instead.";
        };
        voiceRecognition.onend = () => {
          setVoiceButtonListening(false);
          voiceButton.disabled = busy;
          if (status.textContent === "Listening…") status.textContent = "";
        };
        voiceButton.addEventListener("click", () => {
          if (busy) return;
          try {
            voiceBaseText = input.value.trim();
            voiceFinalText = "";
            voiceButton.disabled = true;
            setVoiceButtonListening(true);
            status.textContent = "Listening…";
            recordAnalyticsEvent("voice_input_started");
            voiceRecognition.start();
          } catch {
            voiceButton.disabled = false;
            setVoiceButtonListening(false);
            status.textContent = "Could not start speech recognition. You can type your message instead.";
          }
        });
      } else {
        voiceButton.disabled = true;
        voiceButton.title = "Speech recognition is not supported in this browser. Type your message instead.";
        voiceButton.setAttribute(
          "aria-label",
          "Speech recognition is not supported in this browser",
        );
      }

      void checkAuth();
    </script>
  </body>
</html>`;

interface MuseAttachment {
  id: string;
  name: string;
  mimeType: string;
  bytes: Buffer;
}

interface AttachmentContextResult {
  context: string;
  notices: string[];
}

interface MuseSession {
  agent?: MuseAgent;
  userId: string;
  username: string;
  history: ConversationMessage[];
  lastUsedAt: number;
  pending: Promise<void>;
  historyPending: Promise<void>;
  attachments: Map<string, MuseAttachment>;
}

export interface MuseHttpServerOptions {
  sessionSecret?: string;
  memoryDirectory?: string;
  sharedMemoryPath?: string;
  /** File for username/password account records. Defaults to scripts/data/muse-web-users.json. */
  authFilePath?: string;
  /** Directory for per-user chat transcripts. Defaults to scripts/data/muse-web-history/. */
  historyDirectory?: string;
  /** Defaults to true. Disable only in isolated tests that exercise legacy anonymous sessions. */
  authEnabled?: boolean;
  providerFactory?: () => TextGenerationProvider;
  /** Provider for research planning, synthesis, and long-form writing.
   *  Defaults to `providerFactory` (or the task-aware research provider when
   *  neither factory is supplied). */
  researchProviderFactory?: () => TextGenerationProvider;
  researchRunner?: ResearchRunner;
  researchImageFinder?: ResearchImageFinder;
  mediaProviderFactory?: () => MuseMediaProvider;
  /** Local append-only first-party event log. Defaults to scripts/data/muse-web-analytics.jsonl. */
  analyticsFilePath?: string;
  /** Server-only bearer token for the private /analytics dashboard. */
  analyticsAdminToken?: string;
  /** Number of days to keep raw pseudonymous analytics events; defaults to 90. */
  analyticsRetentionDays?: number;
  maxActiveSessions?: number;
  sessionTtlMs?: number;
}

export function createMuseHttpServer(
  options: MuseHttpServerOptions = {},
): Server {
  const sessionSecret =
    options.sessionSecret ?? process.env.SESSION_SECRET ?? "";
  if (!sessionSecret.trim()) {
    throw new Error(
      "SESSION_SECRET is required to start the Muse HTTP server.",
    );
  }
  const memoryDirectory =
    options.memoryDirectory ??
    process.env.MUSE_HTTP_MEMORY_DIR ??
    DEFAULT_MEMORY_DIRECTORY;
  const analyticsFilePath =
    options.analyticsFilePath?.trim() ||
    process.env.MUSE_WEB_ANALYTICS_FILE?.trim() ||
    DEFAULT_WEB_ANALYTICS_FILE;
  const analyticsRetentionDays =
    options.analyticsRetentionDays ?? DEFAULT_WEB_ANALYTICS_RETENTION_DAYS;
  const analyticsAdminToken = (
    options.analyticsAdminToken ?? process.env.MUSE_ANALYTICS_ADMIN_TOKEN ?? ""
  ).trim();
  const analyticsAdminEnabled = Buffer.byteLength(analyticsAdminToken, "utf8") >= 32;
  const analyticsStore = new JsonWebAnalyticsStore(
    analyticsFilePath,
    analyticsRetentionDays,
  );
  const authEnabled = options.authEnabled ?? true;
  const userStore = new JsonWebUserStore(
    options.authFilePath ??
      process.env.MUSE_WEB_AUTH_FILE ??
      DEFAULT_WEB_AUTH_FILE,
  );
  const chatHistoryStore = new JsonChatHistoryStore(
    options.historyDirectory ??
      process.env.MUSE_WEB_HISTORY_DIR ??
      DEFAULT_CHAT_HISTORY_DIRECTORY,
  );
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
  const activeUserSessions = new Map<string, MuseSession>();
  const loginFailures = new Map<string, { count: number; resetAt: number }>();
  const imageGenerationTimestamps: number[] = [];
  const imageAnalysisTimestamps: number[] = [];
  let storedAttachmentBytes = 0;
  let mediaProvider: MuseMediaProvider | undefined;

  function createAgent(
    userId: string,
    history: readonly ConversationMessage[],
  ): MuseAgent {
    const chatProvider = providerFactory();
    const agent = new MuseAgent(
      chatProvider,
      new MemoryService(
        new JsonMemoryRepository(join(memoryDirectory, `${userId}.json`)),
      ),
      authEnabled ? undefined : sharedMemories,
      options.researchRunner,
      options.researchImageFinder,
      {
        research: options.researchProviderFactory
          ? options.researchProviderFactory()
          : defaultTasks
            ? defaultTasks.research.provider
            : chatProvider,
      },
    );
    agent.restoreConversationHistory(
      history.slice(-MAX_MODEL_CONTEXT_MESSAGES),
    );
    return agent;
  }

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

  async function generateImageForPrompt(
    prompt: string,
  ): Promise<GeneratedImage> {
    const provider = getMediaProvider();
    const retryAfterSeconds = consumeHourlyLimit(
      imageGenerationTimestamps,
      MAX_IMAGE_GENERATIONS_PER_HOUR,
    );
    if (retryAfterSeconds > 0) {
      throw new ImageGenerationRateLimitError(retryAfterSeconds);
    }
    const image = await provider.generateImage(prompt);
    if (
      image.bytes.length === 0 ||
      image.bytes.length > 8 * 1_024 * 1_024 ||
      !matchesImageSignature(image.bytes, image.mimeType)
    ) {
      throw new Error("Image provider returned invalid image data.");
    }
    return image;
  }

  function sendGeneratedImage(
    response: ServerResponse,
    image: GeneratedImage,
  ): void {
    response.statusCode = 200;
    response.setHeader("Content-Type", image.mimeType);
    response.setHeader("Content-Length", String(image.bytes.length));
    response.setHeader(
      "Content-Disposition",
      'inline; filename="mira-generated-image"',
    );
    response.end(image.bytes);
  }

  function sendImageGenerationError(
    response: ServerResponse,
    error: unknown,
  ): void {
    if (error instanceof CloudflareAIConfigurationError) {
      sendJson(response, 503, {
        error:
          "Image generation is not configured. Set MUSE_CLOUDFLARE_ACCOUNT_ID and MUSE_CLOUDFLARE_AI_TOKEN.",
      });
      return;
    }
    if (error instanceof ImageGenerationRateLimitError) {
      response.setHeader("Retry-After", String(error.retryAfterSeconds));
      sendJson(response, 429, {
        error:
          "This server has reached its hourly image-generation limit. Try again later.",
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

  async function createAuthenticatedSession(
    user: WebUser,
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<MuseSession | undefined> {
    expireSessions();
    if (sessions.size >= maxActiveSessions) return undefined;

    let session = activeUserSessions.get(user.id);
    if (!session || Date.now() - session.lastUsedAt > sessionTtlMs) {
      const history = await chatHistoryStore.load(user.id);
      session = {
        userId: user.id,
        username: user.username,
        history: history.slice(-MAX_STORED_CHAT_MESSAGES),
        lastUsedAt: Date.now(),
        pending: Promise.resolve(),
        historyPending: Promise.resolve(),
        attachments: new Map(),
      };
      activeUserSessions.set(user.id, session);
    } else {
      session.username = user.username;
    }

    const sessionId = randomBytes(32).toString("hex");
    sessions.set(sessionId, session);
    session.lastUsedAt = Date.now();
    writeSessionCookie(request, response, sessionId, sessionSecret, sessionTtlMs);
    return session;
  }

  async function handleAuthRequest(
    request: IncomingMessage,
    response: ServerResponse,
    pathname: string,
  ): Promise<void> {
    if (pathname === "/api/auth/me") {
      if (request.method !== "GET") {
        response.setHeader("Allow", "GET");
        sendJson(response, 405, { error: "Use GET to check your sign-in." });
        return;
      }
      if (!authEnabled) {
        sendJson(response, 200, {
          authenticated: true,
          user: { id: "preview-user", username: "Preview" },
        });
        return;
      }
      const session = getSession(request, response);
      if (!session) {
        sendJson(response, 200, { authenticated: false });
        return;
      }
      sendJson(response, 200, {
        authenticated: true,
        user: { id: session.userId, username: session.username },
      });
      return;
    }

    if (pathname === "/api/auth/logout") {
      if (request.method !== "POST") {
        response.setHeader("Allow", "POST");
        sendJson(response, 405, { error: "Use POST to sign out." });
        return;
      }
      const sessionId = readSessionId(request, sessionSecret);
      const session = sessionId ? sessions.get(sessionId) : undefined;
      if (sessionId) sessions.delete(sessionId);
      if (
        session &&
        ![...sessions.values()].includes(session)
      ) {
        activeUserSessions.delete(session.userId);
        discardSessionAttachments(session);
      }
      clearSessionCookie(request, response);
      sendJson(response, 200, { signedOut: true });
      return;
    }

    if (pathname !== "/api/auth/register" && pathname !== "/api/auth/login") {
      sendJson(response, 404, { error: "Not found." });
      return;
    }
    if (!authEnabled) {
      sendJson(response, 404, { error: "Sign-in is not enabled in this test server." });
      return;
    }
    if (request.method !== "POST") {
      response.setHeader("Allow", "POST");
      sendJson(response, 405, { error: "Use POST to sign in." });
      return;
    }
    if (
      request.headers["content-type"]?.split(";")[0]?.trim() !==
      "application/json"
    ) {
      sendJson(response, 415, { error: "Send your sign-in details as JSON." });
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
              ? "The sign-in request is too large."
              : "The request body must be valid JSON.",
        },
      );
      return;
    }
    if (
      !isRecord(body) ||
      typeof body.username !== "string" ||
      typeof body.password !== "string"
    ) {
      sendJson(response, 400, { error: "Enter a username and password." });
      return;
    }

    if (pathname === "/api/auth/register") {
      let user: WebUser;
      try {
        user = await userStore.register(body.username, body.password);
      } catch (error) {
        if (error instanceof WebAuthInputError) {
          sendJson(response, 400, { error: error.message });
        } else if (error instanceof WebUsernameTakenError) {
          sendJson(response, 409, { error: error.message });
        } else {
          throw error;
        }
        return;
      }
      const session = await createAuthenticatedSession(user, request, response);
      if (!session) {
        sendJson(response, 503, { error: "Muse is busy. Please try again shortly." });
        return;
      }
      sendJson(response, 201, {
        authenticated: true,
        user: { id: user.id, username: user.username },
      });
      return;
    }

    const attemptKey = body.username.trim().toLowerCase().slice(0, 32);
    const now = Date.now();
    for (const [key, attempt] of loginFailures) {
      if (attempt.resetAt <= now) loginFailures.delete(key);
    }
    const priorFailure = loginFailures.get(attemptKey);
    if (priorFailure && priorFailure.count >= MAX_LOGIN_FAILURES) {
      response.setHeader(
        "Retry-After",
        String(Math.max(1, Math.ceil((priorFailure.resetAt - now) / 1_000))),
      );
      sendJson(response, 429, {
        error: "Too many sign-in attempts for that username. Try again later.",
      });
      return;
    }

    const user = await userStore.authenticate(body.username, body.password);
    if (!user) {
      const currentFailure = loginFailures.get(attemptKey);
      loginFailures.set(attemptKey, {
        count: currentFailure ? currentFailure.count + 1 : 1,
        resetAt: currentFailure?.resetAt ?? now + LOGIN_FAILURE_WINDOW_MS,
      });
      sendJson(response, 401, { error: "Username or password is incorrect." });
      return;
    }
    loginFailures.delete(attemptKey);
    const session = await createAuthenticatedSession(user, request, response);
    if (!session) {
      sendJson(response, 503, { error: "Muse is busy. Please try again shortly." });
      return;
    }
    sendJson(response, 200, {
      authenticated: true,
      user: { id: user.id, username: user.username },
    });
  }

  async function handleAnalyticsCollect(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    if (request.method !== "POST") {
      response.setHeader("Allow", "POST");
      sendJson(response, 405, { error: "Use POST to record an analytics event." });
      return;
    }
    if (
      request.headers["content-type"]?.split(";")[0]?.trim() !==
      "application/json"
    ) {
      sendJson(response, 415, { error: "Send analytics events as JSON." });
      return;
    }

    let body: unknown;
    try {
      const bytes = await readBoundedRequestBody(
        request,
        MAX_ANALYTICS_REQUEST_BYTES,
      );
      body = JSON.parse(bytes.toString("utf8")) as unknown;
    } catch (error) {
      sendJson(
        response,
        error instanceof RequestBodyTooLargeError ? 413 : 400,
        { error: "The analytics event is invalid." },
      );
      return;
    }
    if (
      !isRecord(body) ||
      typeof body.type !== "string" ||
      !WEB_ANALYTICS_EVENT_TYPES.includes(
        body.type as WebAnalyticsEventType,
      )
    ) {
      sendJson(response, 400, { error: "The analytics event type is invalid." });
      return;
    }

    const visitorId =
      readSignedAnalyticsCookie(
        request,
        ANALYTICS_VISITOR_COOKIE_NAME,
        sessionSecret,
      ) ?? randomBytes(32).toString("hex");
    const sessionId =
      readSignedAnalyticsCookie(
        request,
        ANALYTICS_SESSION_COOKIE_NAME,
        sessionSecret,
      ) ?? randomBytes(32).toString("hex");
    const now = Date.now();
    await analyticsStore.record({
      timestamp: now,
      visitorHash: hashAnalyticsId(visitorId),
      sessionHash: hashAnalyticsId(sessionId),
      type: body.type as WebAnalyticsEventType,
      path: normalizeAnalyticsPath(body.path),
    });
    response.setHeader("Set-Cookie", [
      writeAnalyticsCookie(
        request,
        ANALYTICS_VISITOR_COOKIE_NAME,
        visitorId,
        sessionSecret,
        ANALYTICS_VISITOR_TTL_MS,
      ),
      writeAnalyticsCookie(
        request,
        ANALYTICS_SESSION_COOKIE_NAME,
        sessionId,
        sessionSecret,
        ANALYTICS_SESSION_TTL_MS,
      ),
    ]);
    sendJson(response, 202, { recorded: true });
  }

  function handleAnalyticsForget(
    request: IncomingMessage,
    response: ServerResponse,
  ): void {
    if (request.method !== "POST") {
      response.setHeader("Allow", "POST");
      sendJson(response, 405, { error: "Use POST to clear analytics cookies." });
      return;
    }
    response.setHeader("Set-Cookie", [
      clearAnalyticsCookie(request, ANALYTICS_VISITOR_COOKIE_NAME),
      clearAnalyticsCookie(request, ANALYTICS_SESSION_COOKIE_NAME),
    ]);
    sendJson(response, 200, { cleared: true });
  }

  async function handleAnalyticsReport(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    if (request.method !== "GET") {
      response.setHeader("Allow", "GET");
      sendJson(response, 405, { error: "Use GET to load analytics." });
      return;
    }
    if (!analyticsAdminEnabled) {
      sendJson(response, 503, {
        error:
          "Analytics dashboard is locked until MUSE_ANALYTICS_ADMIN_TOKEN is set to a secret with at least 32 characters.",
      });
      return;
    }
    if (!isAnalyticsAdminRequest(request, analyticsAdminToken)) {
      sendJson(response, 401, { error: "Analytics admin token is incorrect." });
      return;
    }

    const url = new URL(request.url ?? "/api/analytics/report", "http://localhost");
    const days = Number(url.searchParams.get("days") ?? "30");
    if (![7, 30, 90].includes(days)) {
      sendJson(response, 400, { error: "Choose a report period of 7, 30, or 90 days." });
      return;
    }
    const now = Date.now();
    const events = await analyticsStore.readEvents(now);
    const report = buildWebAnalyticsReport(
      events,
      days,
      now,
      analyticsRetentionDays,
    );
    sendJson(response, 200, report as unknown as Record<string, unknown>);
  }

  void analyticsStore.prune().catch(() => {});
  const analyticsPruneTimer = setInterval(() => {
    void analyticsStore.prune().catch(() => {});
  }, ANALYTICS_PRUNE_INTERVAL_MS);
  analyticsPruneTimer.unref();
  const server = createServer((request, response) => {
    void handleRequest(request, response).catch(() => {
      if (!response.headersSent && !response.destroyed) {
        sendJson(response, 500, {
          error: "Muse could not handle this request.",
        });
      }
    });
  });
  server.once("close", () => clearInterval(analyticsPruneTimer));
  return server;

  async function handleRequest(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    setSecurityHeaders(response);
    const pathname = new URL(request.url ?? "/", "http://localhost").pathname;

    if (request.method === "GET" && pathname === "/favicon.svg") {
      response.statusCode = 200;
      response.setHeader("Content-Type", "image/svg+xml; charset=utf-8");
      response.setHeader("Cache-Control", "public, max-age=86400");
      response.end(MIRA_FAVICON_SVG);
      return;
    }

    if (request.method === "GET" && pathname === "/") {
      response.statusCode = 200;
      response.setHeader("Content-Type", "text/html; charset=utf-8");
      response.end(CHAT_PAGE);
      return;
    }

    if (request.method === "GET" && pathname === "/analytics") {
      response.statusCode = 200;
      response.setHeader("Content-Type", "text/html; charset=utf-8");
      response.end(WEB_ANALYTICS_DASHBOARD_PAGE);
      return;
    }

    if (pathname === "/api/analytics/collect") {
      await handleAnalyticsCollect(request, response);
      return;
    }
    if (pathname === "/api/analytics/forget") {
      handleAnalyticsForget(request, response);
      return;
    }
    if (pathname === "/api/analytics/report") {
      await handleAnalyticsReport(request, response);
      return;
    }

    if (request.method === "GET" && pathname === "/api/healthz") {
      sendJson(response, 200, { status: "ok" });
      return;
    }

    if (pathname === "/api/auth/me" || pathname.startsWith("/api/auth/")) {
      await handleAuthRequest(request, response, pathname);
      return;
    }

    if (pathname === "/api/history") {
      if (request.method !== "GET") {
        response.setHeader("Allow", "GET");
        sendJson(response, 405, { error: "Use GET to load chat history." });
        return;
      }
      const session = getSession(request, response);
      if (!session) {
        sendJson(response, 401, { error: "Sign in to view chat history." });
        return;
      }
      sendJson(response, 200, {
        messages: session.history.slice(-MAX_STORED_CHAT_MESSAGES),
      });
      return;
    }

    if (
      authEnabled &&
      isProtectedApiPath(pathname) &&
      !getSession(request, response)
    ) {
      sendJson(response, 401, { error: "Sign in to continue." });
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
    if (
      request.headers["content-type"]?.split(";")[0]?.trim() !==
      "application/json"
    ) {
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

    const imageCommand = parseImageGenerationCommand(message);
    if (imageCommand) {
      let attachmentSession: MuseSession | undefined;
      try {
        attachmentSession = getSession(request, response);
      } catch {
        // Image generation can work even when the text model is unavailable.
      }
      try {
        if (imageCommand.kind === "missing-prompt") {
          sendJson(response, 400, { error: IMAGE_GENERATION_USAGE_REPLY });
        } else if (imageCommand.kind === "prompt-too-long") {
          sendJson(response, 413, {
            error: IMAGE_GENERATION_PROMPT_TOO_LONG_REPLY,
          });
        } else {
          const image = await generateImageForPrompt(imageCommand.prompt);
          if (attachmentSession) {
            await appendHistoryTurn(
              attachmentSession,
              message,
              GENERATED_IMAGE_HISTORY_NOTE,
            );
          }
          sendGeneratedImage(response, image);
        }
      } catch (error) {
        sendImageGenerationError(response, error);
      } finally {
        if (attachmentSession) {
          discardSessionAttachments(attachmentSession, attachmentIds);
          attachmentSession.lastUsedAt = Date.now();
        }
      }
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
      session.agent ??= createAgent(session.userId, session.history);
    } catch {
      sendJson(response, 503, {
        error:
          "Muse's model provider is not configured. Set a provider key and try again.",
      });
      return;
    }

    try {
      const result = await enqueueResponse(session, message, attachmentIds);
      sendJson(response, 200, {
        reply: result.reply,
        ...(result.notices.length ? { notices: result.notices } : {}),
      });
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
          error:
            "Image understanding has reached its hourly limit. Try again later.",
        });
      } else if (error instanceof MissingSessionAttachmentError) {
        sendJson(response, 400, {
          error:
            "An attachment expired or was removed. Please upload it again.",
        });
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
        Array.isArray(rawFileName)
          ? (rawFileName[0] ?? "")
          : (rawFileName ?? ""),
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
        error:
          "Muse's chat provider is not configured. Set its API key and try again.",
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
      sendJson(response, 413, {
        error: "You can attach up to three files per turn.",
      });
      return;
    }

    const maxBytes = mimeType.startsWith("image/")
      ? MAX_IMAGE_ATTACHMENT_BYTES
      : MAX_TEXT_ATTACHMENT_BYTES;
    let bytes: Buffer;
    try {
      bytes = await readBoundedRequestBody(request, maxBytes);
    } catch (error) {
      sendJson(
        response,
        error instanceof RequestBodyTooLargeError ? 413 : 400,
        {
          error:
            error instanceof RequestBodyTooLargeError
              ? `Attachments must be ${mimeType.startsWith("image/") ? "4 MB" : "512 KB"} or smaller.`
              : "The attachment could not be read.",
        },
      );
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
      sendJson(response, 415, {
        error: "The file content does not match its image type.",
      });
      return;
    }
    if (!mimeType.startsWith("image/")) {
      try {
        const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
        if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text)) {
          throw new Error("Unsupported control characters.");
        }
      } catch {
        sendJson(response, 415, {
          error: "Text attachments must be valid UTF-8 text.",
        });
        return;
      }
    }

    const sessionBytes = [...session.attachments.values()].reduce(
      (total, attachment) => total + attachment.bytes.length,
      0,
    );
    if (sessionBytes + bytes.length > MAX_ATTACHMENT_TOTAL_BYTES) {
      sendJson(response, 413, {
        error: "Attachments for one turn must total 8 MB or less.",
      });
      return;
    }
    if (storedAttachmentBytes + bytes.length > MAX_SERVER_ATTACHMENT_BYTES) {
      sendJson(response, 503, {
        error: "Muse's temporary attachment capacity is full. Try again later.",
      });
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
    storedAttachmentBytes = Math.max(
      0,
      storedAttachmentBytes - attachment.bytes.length,
    );
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
    if (
      request.headers["content-type"]?.split(";")[0]?.trim() !==
      "application/json"
    ) {
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
    if (
      !isRecord(body) ||
      typeof body.prompt !== "string" ||
      !body.prompt.trim()
    ) {
      sendJson(response, 400, { error: "An image prompt is required." });
      return;
    }
    const prompt = body.prompt.trim();
    if (prompt.length > IMAGE_GENERATION_MAX_PROMPT_LENGTH) {
      sendJson(response, 413, {
        error: `Image prompts must be ${IMAGE_GENERATION_MAX_PROMPT_LENGTH.toLocaleString("en-US")} characters or fewer.`,
      });
      return;
    }

    let session: MuseSession | undefined;
    try {
      session = getSession(request, response);
    } catch {
      // Image generation can work even when the text model is unavailable.
    }
    try {
      const image = await generateImageForPrompt(prompt);
      if (session) {
        await appendHistoryTurn(
          session,
          `Create image: ${prompt}`,
          GENERATED_IMAGE_HISTORY_NOTE,
        );
      }
      sendGeneratedImage(response, image);
    } catch (error) {
      sendImageGenerationError(response, error);
    }
  }

  function discardSessionAttachments(
    session: MuseSession,
    attachmentIds?: readonly string[],
  ): void {
    const attachments = attachmentIds
      ? attachmentIds
          .map((id) => session.attachments.get(id))
          .filter((attachment): attachment is MuseAttachment =>
            Boolean(attachment),
          )
      : [...session.attachments.values()];
    for (const attachment of attachments) {
      session.attachments.delete(attachment.id);
      storedAttachmentBytes = Math.max(
        0,
        storedAttachmentBytes - attachment.bytes.length,
      );
    }
  }

  async function createAttachmentContext(
    attachments: MuseAttachment[],
    question: string,
  ): Promise<AttachmentContextResult> {
    const sections: string[] = [];
    const notices: string[] = [];
    let remainingTextChars = MAX_TOTAL_ATTACHMENT_TEXT_CHARS;
    for (const attachment of attachments) {
      if (attachment.mimeType.startsWith("image/")) {
        try {
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
        } catch (error) {
          console.error(
            "Muse image attachment analysis failed:",
            error instanceof Error ? error.message : "unknown error",
          );
          const reason =
            error instanceof CloudflareAIConfigurationError
              ? "Cloudflare image analysis is not configured"
              : error instanceof CloudflareRateLimitError
                ? "Muse's hourly image-analysis limit has been reached"
                : error instanceof CloudflareAIRequestError &&
                    error.status === 429
                  ? "Cloudflare Workers AI rate-limited the image-analysis request"
                  : "image analysis was unavailable";
          notices.push(
            `Mira could not inspect "${attachment.name}" because ${reason}. She has been told not to guess what it shows.`,
          );
          sections.push(
            `Image file "${attachment.name}" could not be inspected because ${reason}. Do not infer or invent visual details. Tell the user you could not inspect the image and ask them to describe it or try again.`,
          );
        }
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
    return { context: sections.join("\n\n"), notices };
  }

  function appendHistoryTurn(
    session: MuseSession,
    userMessage: string,
    assistantMessage: string,
  ): Promise<boolean> {
    const operation = session.historyPending.then(async () => {
      session.history = [
        ...session.history,
        { role: "user", content: userMessage },
        { role: "assistant", content: assistantMessage },
      ].slice(-MAX_STORED_CHAT_MESSAGES);
      session.lastUsedAt = Date.now();
      if (!authEnabled) return true;
      try {
        await chatHistoryStore.save(session.userId, session.history);
        return true;
      } catch (error) {
        console.error(
          "Muse chat history could not be saved:",
          error instanceof Error ? error.message : "unknown error",
        );
        return false;
      }
    });
    session.historyPending = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  function enqueueResponse(
    session: MuseSession,
    message: string,
    attachmentIds: string[],
  ): Promise<{ reply: string; notices: string[] }> {
    const response = session.pending.then(async () => {
      try {
        const attachments = attachmentIds.map((id) =>
          session.attachments.get(id),
        );
        if (attachments.some((attachment) => !attachment)) {
          throw new MissingSessionAttachmentError();
        }
        const resolvedAttachments = attachments as MuseAttachment[];
        const attachmentContext = await createAttachmentContext(
          resolvedAttachments,
          message,
        );
        const hasImageAttachment = resolvedAttachments.some((attachment) =>
          attachment.mimeType.startsWith("image/"),
        );
        const agent = session.agent;
        if (!agent) throw new Error("The chat agent was not initialized.");
        const reply = await agent.respond(
          message,
          attachmentContext.context,
          hasImageAttachment,
        );
        agent.trimConversationHistory(MAX_MODEL_CONTEXT_MESSAGES);
        const attachmentNames = resolvedAttachments.map(
          (attachment) => attachment.name,
        );
        const historyUserMessage = attachmentNames.length
          ? `${message}\n[Attached: ${attachmentNames.join(", ")}]`
          : message;
        const notices = [...attachmentContext.notices];
        const historySaved = await appendHistoryTurn(
          session,
          historyUserMessage,
          reply,
        );
        if (!historySaved) {
          notices.push("This reply could not be saved to your chat history.");
        }
        return { reply, notices };
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

  function expireSessions(now = Date.now()): void {
    const expiredSessions = new Set<MuseSession>();
    for (const [id, session] of sessions) {
      if (now - session.lastUsedAt > sessionTtlMs) {
        sessions.delete(id);
        expiredSessions.add(session);
      }
    }
    for (const [userId, session] of activeUserSessions) {
      if (now - session.lastUsedAt > sessionTtlMs) {
        activeUserSessions.delete(userId);
        expiredSessions.add(session);
      }
    }
    for (const session of expiredSessions) {
      if (![...sessions.values()].includes(session)) {
        discardSessionAttachments(session);
        if (activeUserSessions.get(session.userId) === session) {
          activeUserSessions.delete(session.userId);
        }
      }
    }
  }

  function getSession(
    request: IncomingMessage,
    response: ServerResponse,
  ): MuseSession | undefined {
    const now = Date.now();
    expireSessions(now);

    const cookieSessionId = readSessionId(request, sessionSecret);
    if (authEnabled) {
      if (!cookieSessionId) return undefined;
      const session = sessions.get(cookieSessionId);
      if (!session) return undefined;
      session.lastUsedAt = now;
      writeSessionCookie(
        request,
        response,
        cookieSessionId,
        sessionSecret,
        sessionTtlMs,
      );
      return session;
    }

    const id = cookieSessionId ?? randomBytes(32).toString("hex");
    let session = sessions.get(id);
    if (!session) {
      if (sessions.size >= maxActiveSessions) return undefined;
      session = {
        userId: id,
        username: "Guest",
        history: [],
        lastUsedAt: now,
        pending: Promise.resolve(),
        historyPending: Promise.resolve(),
        attachments: new Map(),
      };
      sessions.set(id, session);
    }

    session.lastUsedAt = now;
    writeSessionCookie(request, response, id, sessionSecret, sessionTtlMs);
    return session;
  }
}

function hashAnalyticsId(id: string): string {
  return createHash("sha256").update(id).digest("hex");
}

function normalizeAnalyticsPath(value: unknown): string {
  if (typeof value !== "string") return "/";
  const path = (value.split(/[?#]/, 1)[0] ?? "/").trim();
  if (
    !path.startsWith("/") ||
    path.startsWith("//") ||
    path.length > 120 ||
    !/^\/[a-zA-Z0-9/_-]*$/.test(path)
  ) {
    return "/";
  }
  return path || "/";
}

function readSignedAnalyticsCookie(
  request: IncomingMessage,
  name: string,
  secret: string,
): string | undefined {
  const cookieHeader = request.headers.cookie;
  if (!cookieHeader) return undefined;
  const cookie = cookieHeader
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${name}=`));
  if (!cookie) return undefined;
  const [id, signature, extra] = cookie.slice(name.length + 1).split(".");
  if (
    extra !== undefined ||
    !/^[a-f0-9]{64}$/.test(id ?? "") ||
    !/^[a-f0-9]{64}$/.test(signature ?? "")
  ) {
    return undefined;
  }
  const expected = createHmac("sha256", secret)
    .update(name)
    .update("\u0000")
    .update(id)
    .digest();
  const received = Buffer.from(signature, "hex");
  return timingSafeEqual(expected, received) ? id : undefined;
}

function writeAnalyticsCookie(
  request: IncomingMessage,
  name: string,
  id: string,
  secret: string,
  ttlMs: number,
): string {
  const signature = createHmac("sha256", secret)
    .update(name)
    .update("\u0000")
    .update(id)
    .digest("hex");
  const maxAgeSeconds = Math.max(1, Math.floor(ttlMs / 1_000));
  return `${name}=${id}.${signature}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}${secureCookieAttribute(request)}`;
}

function clearAnalyticsCookie(
  request: IncomingMessage,
  name: string,
): string {
  return `${name}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secureCookieAttribute(request)}`;
}

function secureCookieAttribute(request: IncomingMessage): string {
  const forwardedProtocol = request.headers["x-forwarded-proto"];
  const isSecure =
    typeof forwardedProtocol === "string" &&
    forwardedProtocol.split(",")[0].trim().toLowerCase() === "https";
  return isSecure ? "; Secure" : "";
}

function isAnalyticsAdminRequest(
  request: IncomingMessage,
  expectedToken: string,
): boolean {
  const authorization = request.headers.authorization;
  if (typeof authorization !== "string" || !authorization.startsWith("Bearer ")) {
    return false;
  }
  const suppliedToken = authorization.slice("Bearer ".length).trim();
  if (!suppliedToken) return false;
  const expectedHash = createHash("sha256").update(expectedToken).digest();
  const suppliedHash = createHash("sha256").update(suppliedToken).digest();
  return timingSafeEqual(expectedHash, suppliedHash);
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

function clearSessionCookie(
  request: IncomingMessage,
  response: ServerResponse,
): void {
  const forwardedProtocol = request.headers["x-forwarded-proto"];
  const isSecure =
    typeof forwardedProtocol === "string" &&
    forwardedProtocol.split(",")[0].trim().toLowerCase() === "https";
  response.setHeader(
    "Set-Cookie",
    `${SESSION_COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${isSecure ? "; Secure" : ""}`,
  );
}

function isProtectedApiPath(pathname: string): boolean {
  return (
    pathname === "/api/chat" ||
    pathname === "/api/images/generate" ||
    pathname === "/api/attachments" ||
    pathname.startsWith("/api/attachments/")
  );
}

function setSecurityHeaders(response: ServerResponse): void {
  response.setHeader("Cache-Control", "no-store");
  response.setHeader(
    "Content-Security-Policy",
    "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; img-src 'self' https://upload.wikimedia.org https://api.openverse.org blob:; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
  );
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
    return (
      bytes.length >= 3 &&
      bytes[0] === 0xff &&
      bytes[1] === 0xd8 &&
      bytes[2] === 0xff
    );
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
class ImageGenerationRateLimitError extends Error {
  constructor(readonly retryAfterSeconds: number) {
    super("Muse hourly image-generation limit exceeded.");
  }
}
