# Muse Conversational Assistant

Muse is a general-purpose conversational assistant with a Photon 2.0-connected
iMessage entry point and web research when it adds value. Its chat persona is Mira.
Mira can chat, brainstorm, plan, explain, help with writing, and answer everyday
questions. Explicit research requests, up-to-date facts, and named websites use
the existing search, page-retrieval,
citation-validation, and local-archive pipeline. Links the user supplies are
fetched directly first (see "Reading links in real time" below). Replies use
retrieved evidence internally; citation markers and source lists are shown only
when requested. Unavailable pages are not presented as retrieved sources. Muse
honors the requested format, avoids tables, and offers a follow-up only when useful.
When explicitly requested, Muse finds relevant existing images in Wikimedia
Commons and includes the image, its source page, creator attribution, and license
when available. These accompanying visuals are sourced, not generated. The browser
preview renders them; other clients may show them as links or previews. In iMessage
and browser chat, a leading explicit command such as `generate image: a red fox
under the northern lights` sends the description directly to Cloudflare Workers
AI. iMessage returns the result as an image attachment; the browser renders it
with a download link. Ordinary chat and research messages stay on their existing
paths; research images are still sourced and are never AI-generated.

The browser chat also offers explicit image generation, image understanding, text
file attachments, microphone dictation, and speech playback. Image generation
and image understanding use optional Cloudflare Workers AI credentials; ordinary
text chat remains on the configured provider (Gemini Flash Lite by default).

Muse also drafts complete general-purpose written deliverables, including
articles, essays, literature reviews, technical tutorials, reports, study
guides, outlines, and proposals. Factual work reuses the research pipeline;
creative writing and personal-narrative prompts (such as "the day I will never
forget") can proceed without an unnecessary web search unless sources or
research are explicitly requested. It carries the current writing assignment into revision requests,
formats available source metadata for the requested citation style, and flags
unsupported numeric citations and evidence limitations. Citation checks are
lexical safeguards rather than a substitute for expert fact-checking, and
generated code is not executed by the writing workflow.

## Start Muse in iMessage

Use Photon 2.0 Beta and a project with an iMessage line configured. The listener
uses the documented [Photon Beta project setup](https://photon.codes/docs/beta/get-started/project),
[iMessage setup](https://photon.codes/docs/beta/get-started/imessage), and
[Socket.IO event delivery](https://photon.codes/docs/beta/websocket). Create a
project API key with `project:read` and `project:write`, then configure:

- `PHOTON_PROJECT_ID` — Beta project ID (`pho_prj_...`).
- `PHOTON_API_KEY` — project-scoped bearer key; keep it in a secret manager.
- `MUSE_LLM_PROVIDER` — `gemini` (default when unset or blank), `groq`,
  `openrouter`, or `agentrouter`; the value is trimmed and case-insensitive.

For Gemini, set `GEMINI_API_KEY`. Muse uses the Google Gemini Developer API
model `gemini-3.5-flash-lite` by default for chat, research, and writing. The
runtime does not read a `GEMINI_MODEL` override. Google listed this model as
free-tier eligible on 2026-10-19, but free-tier quotas are project-specific and
must be checked in AI Studio; Google does not publish one fixed RPM/TPM/RPD
allowance for every project. Google may use free-tier prompts and responses to improve its products, so
avoid sending sensitive messages, text attachments, or Cloudflare-generated
image descriptions unless that data use is acceptable. Raw uploaded image bytes
go to Cloudflare vision, not Gemini. Muse's own research pipeline remains responsible
for web retrieval; Gemini Search grounding is not enabled.

For Groq, set `GROQ_API_KEY`; `GROK_API_CODING_KEY` remains supported for
backward compatibility. `GROQ_MODEL` is optional and defaults to
`openai/gpt-oss-120b`, a [recommended replacement](https://console.groq.com/docs/deprecations)
for the deprecated `llama-3.3-70b-versatile`. If overriding `GROQ_MODEL`, use
an active model ID available to your Groq account.

For OpenRouter, set `OPENROUTER_API_KEY` and `OPENROUTER_MODEL`. The model is
required so deployment explicitly selects an available model; check its current
availability, rate limits, and price in the [model catalog](https://openrouter.ai/models).
Set a per-key spending limit in the OpenRouter dashboard under **Settings →
Keys** when creating or editing the key, and inspect usage in **Activity**.
Groq usage is available in the Groq console under **Settings → Usage**. The
single-provider Photon listener does not switch providers automatically; the
browser chat server's alternate-provider behavior is documented below.

For AgentRouter, set `AGENTROUTER_API_KEY`; `AGENTROUTER_MODEL` is an optional
override. Provider credentials are isolated: only the selected adapter receives
its own key.

Chat and research default to Gemini. `MUSE_CHAT_LLM_PROVIDER` and
`MUSE_RESEARCH_LLM_PROVIDER` can override tasks independently; setting
`MUSE_LLM_PROVIDER` pins both. When the tasks use different configured
providers, each may serve as the other's request-failure fallback. If both tasks
use the same non-Groq provider, Groq is the default alternate when its
credentials are configured. Safety-filter refusals are never routed to another
provider. A Gemini-only setup without Groq credentials has no runtime failover.

### Stable Spectrum transport: iMessage

To use Spectrum instead of the default Photon 2.0 Beta transport:

1. Create or select a **stable Spectrum** project and enable its iMessage
   provider. Follow the official [Spectrum project setup](https://photon.codes/docs/spectrum-ts/getting-started)
   and [iMessage provider setup](https://photon.codes/docs/spectrum-ts/providers/imessage).
   For Free/Pro shared-pool projects, Photon says no dedicated line is assigned;
   use the number shown in the dashboard (the CLI line list may be empty). No
   upgrade is needed just to use the shared pool. For this project’s shared pool,
   follow Photon’s phone-only instruction: use a phone-number iMessage sender,
   not an email-based handle. Verify the actual sender with Photon’s
   [debug line](https://debug.photon.codes); if it reports an email, choose the
   phone number under **Settings → Messages → Send & Receive → Start New
   Conversations From** on the iPhone, then verify again. Add that exact phone
   number under the project’s **Users** tab. This allowlist affects outbound
   replies: an unregistered recipient can fail with
   `Target not allowed for this project`, but that would happen after an inbound
   event, not explain a missing `received message` log.
2. Add these runtime environment variables in GitHub Codespaces Secrets or
   another secret manager. Do not put credential values in tracked files.
   - `SPECTRUM_PROJECT_ID` — the stable Spectrum project ID.
   - `SPECTRUM_PROJECT_SECRET` — the stable Spectrum project secret.
   - `GEMINI_API_KEY` — required for the default Gemini chat, research, and
     writing provider (`gemini-3.5-flash-lite`).
3. Set `MUSE_PHOTON_TRANSPORT=spectrum`. The Spectrum platform defaults to
   iMessage; set `MUSE_SPECTRUM_PLATFORM=whatsapp_business` for WhatsApp Business
   (details below). Spectrum credentials are read only from
   `SPECTRUM_PROJECT_ID` and `SPECTRUM_PROJECT_SECRET`; the Beta variables
   `PHOTON_PROJECT_ID` and `PHOTON_API_KEY` are not used by this path. The
   default remains Photon 2.0 Beta when `MUSE_PHOTON_TRANSPORT` is unset.
4. From the repository root, start the listener:

   ```sh
   MUSE_PHOTON_TRANSPORT=spectrum pnpm --filter @workspace/scripts run muse-photon
   ```

Expected terminal logs for a successful message:

```text
Spectrum platform: imessage
Spectrum connected
received message from <handle>
Spectrum reply sent to <handle>
```

Spectrum replies are sent as plain text so Messages does not show Markdown
markers such as `###` or `**`. Research-image Markdown from Wikimedia Commons or
Openverse is sent as a bounded, type-checked image attachment instead; if the
image cannot be attached, Mira sends a short plain-text note rather than raw
Markdown.

On iMessage, Muse adds a 👍 Tapback as soon as it receives each inbound message;
inbound Tapbacks are ignored so reactions do not create a loop. JPEG, PNG, and
WebP images up to 4 MB can be sent with a question or in a separate message
before the question. A separate image is held in memory for up to 15 minutes and
is inspected only when the follow-up refers to or asks to research/analyze it.
The resulting image description is passed to Muse as untrusted context, so a
request such as `Make research on this paper` can guide the existing research
pipeline rather than being treated as ordinary chat. Image analysis uses the
optional Cloudflare Workers AI credentials documented above, allows up to 20
image inputs per running listener per hour, and may consume Cloudflare usage; an
empty or retryable primary-model result can also trigger a fallback-model request.
Check your current Cloudflare billing and quotas before using it. Tests for this flow use a mocked image describer and
do not make live AI or research-provider calls. Image-only messages receive the
Tapback immediately and do not trigger analysis until a related follow-up arrives.

A failed send logs `Spectrum reply failed for <handle>: <error message>`. The
receive log contains no message body, and the Spectrum project secret is never
logged. `Spectrum connected` confirms provider startup only;
`received message from <handle>` is evidence that the app received an inbound
event. A Photon routing notice is separate from Mira’s reply. The Spectrum path
uses `spectrum-ts` with `Spectrum({ projectId, projectSecret, providers })`,
consumes `app.messages`, and sends replies with `space.send(...)`. The provider
is selected by `MUSE_SPECTRUM_PLATFORM`. The Photon 2.0 Beta transport and its
configuration are unchanged; it does not require `PHOTON_AGENT_USER_ID`.

### WhatsApp Business with Spectrum

The stable Spectrum transport can also receive and reply to WhatsApp Business
messages. In the Mira project dashboard, open **Platforms**, choose **WhatsApp
Business → Connect**, and complete the official WhatsApp Business Cloud API
connection flow. Confirm that the platform shows as connected. This is a
WhatsApp Business Cloud API channel, not a personal WhatsApp account; use a
number and account authorized for that integration. Photon’s current API
reference says connecting itself is free and has no plan requirement, but the
organization’s billing must be ready with a payment method on file. That does
not establish that message usage is free; check current Photon and Meta pricing
before connecting or sending live messages. Muse does not change Photon
billing settings.

Keep `SPECTRUM_PROJECT_ID` and `SPECTRUM_PROJECT_SECRET` configured as above,
and set the Codespaces variable `MUSE_SPECTRUM_PLATFORM=whatsapp_business`. The
Spectrum provider retrieves its managed WhatsApp line credentials using the
Spectrum project credentials; do not put Meta tokens in Muse's environment.
Start Muse with:

```sh
MUSE_PHOTON_TRANSPORT=spectrum MUSE_SPECTRUM_PLATFORM=whatsapp_business pnpm --filter @workspace/scripts run muse-photon
```

Send a new message from an authorized WhatsApp account to the business number
to test the reply. Check current Photon and Meta terms/pricing before sending
real messages; Muse does not upgrade plans or enable paid usage.

To generate original artwork in iMessage, type a leading command such as
`generate image: a red fox under the northern lights`, `create a picture of a
paper-cut flower`, or `/imagine a quiet lake at dawn`. Muse sends only the
following description to Cloudflare Workers AI; Photon delivers the result as an
image attachment. Prompts are limited to 1,000 characters and each running
Photon process allows up to 10 image-generation requests per hour. The command
requires the Cloudflare secrets documented below. A command without a description
returns usage guidance instead of invoking either model. Regular messages and
research-image selection are unchanged.

Research is bounded to two rounds, eight searches, 16 candidate pages, and six
sources by default. `MUSE_RESEARCH_MAX_ROUNDS` (1–3),
`MUSE_RESEARCH_MAX_SEARCHES` (1–12), `MUSE_RESEARCH_MAX_CANDIDATES` (1–24),
`MUSE_RESEARCH_SOURCES` (1–10), and `MUSE_RESEARCH_MAX_PAGE_BYTES`
(10,000–1,000,000; default 250,000) tune those limits. Invalid values stop
research with a configuration error. Search and readable-page failures are
reported as limitations; when no page is readable Muse returns an insufficiency
response for research answers rather than fabricating sources. Requested writing
can proceed from general knowledge when retrieval fails, with a clear notice
that it is not independently source-verified. Retrieved page text and
archive context are passed to the model as untrusted evidence, and citations are
checked for in-range references and lexical support.

The candidate budget is distributed across search queries, with one retry for
transient network, timeout, HTTP 408, and HTTP 5xx failures; HTTP 429 and other
permanent responses are not retried. Neither retry increases the configured
search or candidate count. Browser and iMessage research replies provide a
direct answer without citation labels or an automatic source list; ask for
sources to receive the retrieved links. Detailed retrieval counts, completeness,
limitations, and unresolved questions remain in the research result/archive
and research progress diagnostics rather than being appended to the chat reply.
Short contextual follow-ups use the existing conversation without repeating a
web search; explicit research requests and substantive factual questions still
use live research.

`MUSE_PHOTON_MEMORY_DIR` optionally changes the per-conversation memory folder.
`MUSE_PHOTON_CURSOR_PATH` optionally changes the durable Photon event cursor
file, which defaults to a project-hashed file under
`scripts/data/muse-photon-beta/`. The listener uses Photon Beta's persistent
Socket.IO event stream, resumes from the last successfully handled cursor,
processes events serially, ignores duplicate event IDs, and retries transient
outbound message requests with a stable `Idempotency-Key`. Photon retains
replay history for a bounded period; this is not an exactly-once or unlimited
archive guarantee.

From the repository root, start the listener with:

```sh
pnpm --filter @workspace/scripts run muse-photon
```

Stop it with Ctrl-C or SIGTERM; the listener closes the WebSocket cleanly.
Each iMessage space has separate in-process conversation history and a
separately hashed memory file under `scripts/data/muse-photon-spaces/` by
default. The agent handles incoming plain-text iMessage events and sends
asynchronous replies through the Photon Beta Messages API, linked to the
incoming message. Explicit image-generation commands upload the Cloudflare
result to Photon and send it as an attachment; ordinary messages continue
through the configured chat model. If Photon marks a WebSocket delivery as expecting a
synchronous webhook response, Muse also submits the documented WebSocket
`reply` acknowledgement after accepting its outbound message. Research uses
public DuckDuckGo HTML/Lite search. Muse retrieves candidate pages itself and
supports HTML, JSON, XML/RSS, Markdown, and plain text; search blocks,
paywalls, dynamic pages, and conflicting evidence can still limit results.
Prior matching archive entries are identified as historical and are not treated
as freshly verified. Conversations are not restored after a process restart.
Research URLs are restricted to HTTP(S), checked against private and local
addresses, and fetched with redirect, time, and response-size limits. Hostname
validation uses a DNS preflight; DNS changes between that check and the HTTP
connection are not pinned, so this is not a general-purpose URL-fetching service.

The new Photon listener requires a long-running Node.js host with outbound
WebSocket access to `api.photon.codes` and HTTPS access to the Photon API,
Gemini, Groq, OpenRouter, or AgentRouter (whichever providers are selected), and
the existing public research sources. No public webhook endpoint is required. Configure Photon credentials
and an iMessage line, start the command above, and send a message from the
configured sender to verify a live interaction.

## Reading links in real time

A URL in a message is read directly: Muse fetches the page itself before any
search runs, so an explicit link is never lost because a search engine blocked
the request. Pages are parsed as HTML, and also as JSON, XML/RSS/Atom,
Markdown, or plain text when those are what the server serves. Thin pages fall
back to their own `og:description`/`description` metadata before giving up.

Links found on a supplied page are followed within the same registrable domain
(for example `photon.codes` leads to `docs.photon.codes`) as extra research
candidates, subject to the normal candidate budget. Binary assets, PDFs, and
image files are skipped.

Text-generation APIs do not automatically browse the web. Muse searches with
unauthenticated DuckDuckGo HTML and Lite endpoints. Both can block requests or
return no results, so retrieval failures are reported rather than replaced with
model-generated URLs. Muse fetches and validates each candidate page itself,
uses retrieved evidence rather than search snippets, and follows page links only
within the same registrable domain. Transient backend failures are retried once
before the next endpoint is tried. Diagnostics distinguish search-provider
blocks, unreadable supplied links, and pages that returned no readable text.

Automated tests use deterministic model responses and fake Photon events; they
do not call a live model, search service, or messaging API. A live iMessage
message/reply through either Spectrum or Photon 2.0 Beta has not been verified.

## Research CLI

Run one live research task and save the report in the local archive:

```sh
pnpm --filter @workspace/scripts run muse-research -- "How does TypeScript type narrowing work?"
```

## Muse CLI

Start a general-purpose local conversation with Muse:

```sh
pnpm --filter @workspace/scripts run muse
```

Enter a message at the `You:` prompt. Type `/help` for memory commands or
`/exit` to end the session. Conversation history is session-only.

## Hello HTTP server

A minimal TypeScript HTTP server using Node.js built-ins only.

Run it from the workspace root:

```sh
pnpm --filter @workspace/scripts run hello-server
```

It listens on port `3000` by default. Set `PORT` to use a different port.
Send an HTTP request to `/` and it responds with `Hello`.

## Gemini API test

With `GEMINI_API_KEY` configured, run:

```sh
pnpm --filter @workspace/scripts run gemini-api-test
```

This makes one small live request to the pinned `gemini-3.5-flash-lite` model
and prints its response. It consumes the Google project's quota and is
intentionally excluded from automated tests. Store the key in GitHub Codespaces
Secrets or another secret manager; never put it in the repository.

## Groq API test

With `GROQ_API_KEY` (or the legacy `GROK_API_CODING_KEY`) configured, run:

```sh
pnpm --filter @workspace/scripts run groq-api-test
```

The script sends a live chat completion to Groq with the selected `GROQ_MODEL`
and prints the response. This command is intentionally excluded from automated
tests.

## Muse browser demo

Check the demo prerequisites without starting the server or contacting a model provider:

```sh
pnpm --filter @workspace/scripts run muse-preflight
```

The preflight prints only prerequisite names and readiness states; it never prints secret values. It checks that `SESSION_SECRET` is non-empty, the selected chat and research providers have usable credentials, any configured alternate providers are usable, and the local `tsx` command is installed. Missing Cloudflare image credentials produce a non-blocking warning because image tools are optional. Both chat tasks default to Gemini `gemini-3.5-flash-lite`; `GEMINI_API_KEY` is needed to use Gemini. `MUSE_CHAT_LLM_PROVIDER` and `MUSE_RESEARCH_LLM_PROVIDER` override each task's provider, while `MUSE_LLM_PROVIDER` pins both. If the Gemini key is missing but Groq is configured, Groq can take over at startup; with both configured, it may also serve as request-failure fallback. Without Groq credentials, Gemini remains the only provider and its key must be present. The model is pinned in code, so `GEMINI_MODEL` is not a runtime setting. The server's non-fatal startup probe makes a small request to each configured provider; set `MUSE_LLM_STARTUP_PROBE=0` to skip it. Set provider credentials in GitHub Codespaces Secrets or the runtime's secret manager, not in tracked files. The browser chat now uses a username and password; no separate access code is used. **Security note:** the former `.replit` user-environment block contained committed credential-like values. Removing the block does not erase Git history; revoke or rotate those values, and remove any obsolete `MUSE_CHAT_ACCESS_TOKEN` from your secret manager. Its standalone tests can run with Node.js alone:

```sh
pnpm --filter @workspace/scripts run muse-preflight-test
```

Start the lightweight HTTP chat demo:

```sh
pnpm --filter @workspace/scripts run muse-server
```

The server binds `0.0.0.0` by default so container previews (GitHub
Codespaces port forwarding, the Replit workflow preview, e2b sandboxes) can
reach it; set `MUSE_BIND_HOST=127.0.0.1` to restrict it to loopback when
running on a shared machine.

Open `http://localhost:3000` locally. In **GitHub Codespaces**, forward port `3000` and open the forwarded URL at path `/`. Or use the **Muse Chat Preview** workflow in Replit at port `3000` and path `/`. The task-aware server defaults chat and research to **Gemini** (`GEMINI_API_KEY`, model `gemini-3.5-flash-lite`). `MUSE_CHAT_LLM_PROVIDER` and `MUSE_RESEARCH_LLM_PROVIDER` override each task's provider; `MUSE_LLM_PROVIDER` pins both to `gemini`, `groq`, `openrouter` (`OPENROUTER_API_KEY` + `OPENROUTER_MODEL`), or `agentrouter` (`AGENTROUTER_API_KEY`). If Gemini is unavailable and Groq credentials are configured, Groq may take over at startup and is also the default request-failure alternate; with Gemini alone there is no automatic failover. The model ID is pinned in code (`GEMINI_MODEL` is not read). `SESSION_SECRET` is required to sign the browser's HTTP-only session cookie. On the first visit, choose **Create an account** and register a username and password; later visits can sign in with the same credentials. No email or separate access code is used.

At startup, the server logs both primary providers and model identifiers
(`Muse chat LLM: …` / `Muse research LLM: …`), any configured fallback models,
and any startup fallback reason. It probes each distinct configured primary
and runtime fallback directly with a minimal request (`Muse LLM probe (…): ok`
or a classified failure such as `auth error`). HTTP status codes are reported;
provider detail is included only when available and is redacted. Set
`MUSE_LLM_STARTUP_PROBE=0` to skip these live probe requests.
Credentials are never logged. The pinned Gemini model is shown in the startup
line, as is any `GROQ_MODEL` override. The `Muse web search:` line reports the
DuckDuckGo HTML/Lite backends. Research uses Muse's existing retrieval pipeline,
not Gemini Search grounding or assumed browsing built into a model.

### Browser multimodal controls

- **Image generation:** Open the composer’s **+** menu and choose **Generate an image**, or type an explicit leading command such as `generate image: a red fox under the northern lights` or `create a picture of a paper-cut flower`, only when you want original AI-created artwork. Typed image commands go directly to Cloudflare Workers AI, bypassing the chat model; the browser renders the resulting image with a download link. This is separate from requests for an image to accompany an explanation, which retrieve existing, attributed Wikimedia Commons images. Configure `MUSE_CLOUDFLARE_ACCOUNT_ID` (a 32-character Cloudflare account ID) and `MUSE_CLOUDFLARE_AI_TOKEN` in Codespaces Secrets or the deployment secret manager. Use a Cloudflare API token with Workers AI Read and Edit permissions (or Cloudflare's Workers AI REST API token template). Prompts are capped at 1,000 characters. The web server and each Photon process cap image generation at 10 requests per hour; the web server caps image understanding at 20 analyses per hour. Muse does not save generated images.
- **Attachments:** JPEG, PNG, and WebP images up to 4 MB each, plus TXT, Markdown (`.md`/`.markdown`), and CSV files up to 512 KB each. A turn accepts at most three files and 8 MB total; temporary uploads across the server are capped at 32 MB. Text sent to the model is limited to 16,000 characters per file and 24,000 total. PDF and DOCX are not supported in this release. File bytes stay in process memory, are not written to disk, and are removed after the next chat turn, manual removal, session expiry, or server restart. Image analysis first calls Cloudflare LLaVA `@cf/llava-hf/llava-1.5-7b-hf` with the image bytes and a prompt, then tries Moondream `@cf/moondream/moondream3.1-9B-A2B` if LLaVA returns an empty/unexpected response or a retryable error. LLaVA is marked Beta by Cloudflare. If both models fail, image analysis is unconfigured, or Muse reaches its local analysis limit, chat still proceeds: the user sees an explicit notice and Mira is instructed not to guess what the image shows. Questions about an attached image use the vision/chat path rather than being auto-routed to web research; an explicit web-search request or URL still triggers research. Prompts, text-file content, and any successful vision context go to the configured chat provider (Gemini Flash Lite by default). Attachment bytes, file contents, and image-analysis details are not retained in chat history or saved-memory extraction; the transcript records attachment filenames only.
- **Accounts and chat history:** Browser users register with a username and password; email is not collected and password resets are not available. Passwords are stored as salted scrypt hashes. Registration is open to anyone who can reach the site, so sign-in separates histories but is not an invite-only gate or a quota for model usage. Each account has one ongoing conversation: the latest 120 messages are saved, and the last 40 messages (20 turns) are restored as model context to limit token use. Only new signed-in turns are saved; old anonymous, in-memory chats cannot be reliably linked to an account. Account histories are per-user JSON files on the server, not end-to-end encrypted. Generated image files and attachment bytes are not retained; the history keeps the image prompt/placeholder and attachment filenames only. The account file defaults to `scripts/data/muse-web-users.json`; histories default to `scripts/data/muse-web-history/`. Override those locations with `MUSE_WEB_AUTH_FILE` and `MUSE_WEB_HISTORY_DIR` if the host provides a persistent storage path.
- **Persistence and free hosting:** Local JSON persistence survives process restarts only when the host preserves that filesystem. It is not a shared database, and this small server expects one instance (or reliable sticky routing); an autoscaled/multi-instance deployment can split account/session state. On a free/ephemeral deployment, a restart, rebuild, or redeploy may erase accounts, saved memories, and chat history; do not assume it is durable unless the host explicitly provides persistent storage at no charge. Adding this feature does not purchase hosting, add a paid API, or change the existing provider configuration. Longer conversations can use more model input tokens (limited to the last 20 turns). Check provider free-tier quotas; the code does not enable a paid plan.
- **Voice:** The microphone icon in the composer uses browser `SpeechRecognition` when available; availability, language, and privacy behavior vary, and some browsers send recognition audio to their own remote service. Audio is not uploaded to Muse. Typed chat remains available. A speaker icon on Mira’s replies uses the browser/device `speechSynthesis` voices; no speech API key is needed. The composer supports Enter to send, Shift+Enter for a line break, and keyboard navigation in the + menu.
- **Quota:** Cloudflare Workers AI has a limited free allocation, not unlimited free usage. Requests can fail when account/model access or quota is unavailable, and Cloudflare may charge or require a paid plan beyond free usage. Check the current Cloudflare account limits and pricing before use. Muse does not automatically upgrade a plan or enable paid usage. Startup only checks whether the named secrets are present; it does not verify live Cloudflare access.
- **First-party site analytics:** Visitors see an optional consent notice; no analytics events are sent until they opt in, and they can later decline from **Privacy & analytics choices**. The private `/analytics` page reports page views, approximate unique browsers, sessions, returning browsers, feature counts, and daily/weekly/monthly rollups in UTC. This is a single-site visitor estimate, not named account tracking: it uses random signed first-party cookies and stores only hashes of those IDs. Analytics does not store chat text, prompts, filenames/file contents, IP addresses, full referrers, or raw browser IDs. Events are written to `scripts/data/muse-web-analytics.jsonl` (ignored by Git), kept for at most 90 days, and capped at 100,000 entries; override the path with `MUSE_WEB_ANALYTICS_FILE`. To unlock the dashboard, generate a random token with `node -e 'console.log(require("node:crypto").randomBytes(32).toString("hex"))'`, add it as the server-side secret `MUSE_ANALYTICS_ADMIN_TOKEN`, then open `/analytics` and enter it. The token is sent in an Authorization header and is not saved by the browser. It must be at least 32 characters; never commit it or place it in a URL. Analytics is self-hosted and uses no third-party tracking service or paid API. A free/ephemeral host may erase its local event log after restart/redeploy; set `MUSE_WEB_ANALYTICS_FILE` to a persistent path if your host provides one.

Each signed-in account gets its own `MuseAgent`, saved-memory file under `scripts/data/muse-http-sessions/`, and persisted transcript. The browser session cookie is HTTP-only, SameSite=Strict, signed with `SESSION_SECRET`, and expires after eight hours; after a server restart users sign in again and the transcript is restored from disk. User-specific memory is not shared between accounts. The page sends messages only to this server; the server then sends them to the configured model provider.

`/api/chat`, attachment endpoints, image generation, and `/api/history` require a signed-in account. Registration is intentionally open, however, so anyone who can reach a public deployment can create an account and use configured provider quotas. The login route limits repeated failed attempts per username, but this is not a general chat usage quota. In GitHub Codespaces, set port `3000` visibility to **Private** and keep the Codespace private. Do not expose the development server publicly without adding a suitable abuse/usage policy. If you previously stored `MUSE_CHAT_ACCESS_TOKEN` in Codespaces Secrets, it is no longer used and can be removed.

The Muse preview uses a separate workflow on port `3000`; it does not replace the API Server (`/api`) or Canvas (`/__mockup`). It can start only after the existing scripts dependencies, including `tsx`, are available.

The opportunity, source-ingestion, tracking, watch, learning, and decision
modules documented below remain standalone utilities. The Photon research agent
does not load them or expose their workflows in iMessage.

## Muse learning records

Learning records use a separate `LearningRepository` and persist in `scripts/data/muse-learning.json` (ignored by Git). Set `MUSE_LEARNING_PATH` to use a different file. The repository supports the categories `SUCCESS_PATTERN`, `FAILURE_PATTERN`, `PREFERENCE`, `OPPORTUNITY_PATTERN`, `CONTENT_PATTERN`, and `STRATEGY`; each record stores its pattern, evidence, outcome, confidence (0–1), and observation count.

## Muse opportunities

Normalized opportunities are evaluated by the provider-independent `OpportunityService` and existing `DecisionService`. Opportunities at `SAVE` or higher persist in `scripts/data/muse-opportunities.json` (ignored by Git); set `MUSE_OPPORTUNITIES_PATH` to use a different file. Source names and URLs are stored as plain attribution fields, with no provider-specific integration.

## Muse watch rules

`WatchService` stores provider-neutral rules in `scripts/data/muse-watch-rules.json` (ignored by Git); set `MUSE_WATCH_RULES_PATH` to use another file. Rules can target trusted accounts, projects, websites, announcement channels, keywords, or a specific opportunity, with source, keyword, opportunity-type, exclusion, enabled, and priority filters. Supply normalized updates and optional entity hints to `WatchService.processUpdate`; matching updates pass through `OpportunityService` and its existing `DecisionService` flow. Priority orders matching rules; it does not override decision scores. No notification sender is included.

## Muse source ingestion

Source configurations and polling state use `scripts/data/muse-sources.json` (ignored by Git); set `MUSE_SOURCES_PATH` to use another file. `SourceAdapter` implementations are registered separately from source configuration and domain logic. The built-in `mock` adapter makes no network requests; no live provider is included.

Inspect source registrations and configured sources, or run one explicit ingestion cycle:

```sh
pnpm --filter @workspace/scripts run muse-sources -- inspect
pnpm --filter @workspace/scripts run muse-sources -- run-once
```

The scheduler polls enabled sources at their configured intervals, stores last-check/success/error state, applies bounded retries and request timeouts, and observes a cooldown after rate limits. Retrieved text is treated as untrusted data and is never passed to Muse's LLM. Continuous scheduling is available through `SourceScheduler.start()` / `stop()`; the CLI only runs an explicit one-shot cycle.

## Muse opportunity tracking

The separate tracking layer stores user-managed opportunities in `scripts/data/muse-tracked-opportunities.json` (ignored by Git); set `MUSE_TRACKED_OPPORTUNITIES_PATH` to use another file. It supports whitelist/waitlist applications, airdrops, campaigns, quests, competitions, grants, content opportunities, public mints, product launches, and other opportunities.

Use the CLI to add and manage records, import a discovered opportunity by its existing opportunity ID, review deadlines, and record results:

```sh
pnpm --filter @workspace/scripts run muse-tracking -- help
pnpm --filter @workspace/scripts run muse-tracking -- add --title "Orbit contributor airdrop" --category AIRDROP --project Orbit --source-url https://example.com/airdrop
pnpm --filter @workspace/scripts run muse-tracking -- list --status DISCOVERED
pnpm --filter @workspace/scripts run muse-tracking -- from-opportunity <discovered-id>
pnpm --filter @workspace/scripts run muse-tracking -- eligibility <tracked-id> ELIGIBLE --evidence "Official checker result" --evidence-url https://example.com/checker
pnpm --filter @workspace/scripts run muse-tracking -- upcoming --days 7
pnpm --filter @workspace/scripts run muse-tracking -- overdue
```

Eligibility, win, and loss status changes require evidence. Verified success, failure, and neutral outcomes are recorded through the existing `LearningService`; unknown outcomes are retained in the tracking record but are not learned. Wallet references accept public addresses only; there is no wallet connection, signing, or transaction execution. The tracker never stores private-key fields and rejects recognizable key or seed-phrase material.
