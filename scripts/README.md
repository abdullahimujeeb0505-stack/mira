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
When explicitly requested, Muse can find relevant images in Wikimedia Commons
and include the image, its source page, creator attribution, and license when
available. The browser preview renders these sourced images; other clients may
show them as links or previews.

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
- `MUSE_LLM_PROVIDER` — `groq` (default when unset or blank), `openrouter`, or
  `agentrouter`; the value is trimmed and case-insensitive.

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

Gemini has been removed from Muse's model and search integrations. The
`GEMINI_API_KEY`, `GEMINI_MODEL`, and `MUSE_GEMINI_SEARCH` settings are no longer
used and can be removed from the runtime's secrets. Change any provider
selection still set to `gemini` to `groq`, `openrouter`, or `agentrouter`, or
clear it to use the Groq default. Chat and research default to Groq. When the two
tasks are explicitly configured with different providers,
the other task's provider can serve as the request-failure fallback; non-Groq
primaries otherwise use Groq. A Groq-only setup has no automatic provider
fallback.

Set `MUSE_PHOTON_TRANSPORT=spectrum` only to explicitly run the legacy
Spectrum transport. That mode continues to require `SPECTRUM_PROJECT_ID` and
`SPECTRUM_PROJECT_SECRET`; the default is Photon 2.0 Beta. The Beta transport
does not require `PHOTON_AGENT_USER_ID`.

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
incoming message. If Photon marks a WebSocket delivery as expecting a
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
Groq/OpenRouter (whichever is selected), and the existing public research
sources. No public webhook endpoint is required. Configure Photon credentials
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
do not call a live model, search service, or messaging API. A real Photon
message/reply has not been verified.

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

The preflight prints only prerequisite names and readiness states; it never prints secret values. It checks that `SESSION_SECRET` is non-empty, the selected chat and research providers have usable credentials, any configured alternate providers are usable, and the local `tsx` command is installed. Both tasks default to Groq. `MUSE_CHAT_LLM_PROVIDER` and `MUSE_RESEARCH_LLM_PROVIDER` override each task's provider, while `MUSE_LLM_PROVIDER` pins both. A distinct configured provider may serve as an alternate; a Groq-only setup has no automatic fallback. Gemini has been removed, so `GEMINI_API_KEY`, `GEMINI_MODEL`, and `MUSE_GEMINI_SEARCH` are no longer used and can be removed from runtime secrets. Set active provider credentials in GitHub Codespaces Secrets or the runtime's secret manager, not in tracked files. Muse no longer requires a chat access code. **Security note:** the former `.replit` user-environment block contained committed credential-like values. Removing the block does not erase Git history; revoke or rotate those values, and remove any obsolete `MUSE_CHAT_ACCESS_TOKEN` from your secret manager. Its standalone tests can run with Node.js alone:

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

Open `http://localhost:3000` locally. In **GitHub Codespaces**, forward port `3000` and open the forwarded URL at path `/`. Or use the **Muse Chat Preview** workflow in Replit at port `3000` and path `/`. The server is task-aware: chat and research both default to **Groq** (`GROQ_API_KEY` or legacy `GROK_API_CODING_KEY`, model `openai/gpt-oss-120b`). `MUSE_CHAT_LLM_PROVIDER` and `MUSE_RESEARCH_LLM_PROVIDER` override each task's provider; `MUSE_LLM_PROVIDER` pins both tasks to `groq`, `openrouter` (`OPENROUTER_API_KEY` + `OPENROUTER_MODEL`), or `agentrouter` (`AGENTROUTER_API_KEY`). Eligible failures retry once only when an alternate provider is configured; with the default Groq-only setup, there is no automatic model fallback. Gemini has been removed, so `GEMINI_API_KEY`, `GEMINI_MODEL`, and `MUSE_GEMINI_SEARCH` are no longer used and may be removed from runtime secrets. Change any provider selection still set to `gemini` to `groq`, `openrouter`, or `agentrouter`, or clear it to use Groq. `SESSION_SECRET` is required to sign the browser's HTTP-only session cookie. No `MUSE_CHAT_ACCESS_TOKEN` or access-code entry is required to use the chat page.

At startup, the server logs both primary providers and model identifiers
(`Muse chat LLM: …` / `Muse research LLM: …`), any configured fallback models,
and any startup fallback reason. It probes each distinct configured primary
and runtime fallback directly with a minimal request (`Muse LLM probe (…): ok`
or a classified failure such as `auth error`). HTTP failures include a short,
redacted provider message, so model/endpoint errors (such as HTTP 404) are
distinguishable from key or quota issues. Set `MUSE_LLM_STARTUP_PROBE=0` to skip
the probe requests.
Credentials are never logged. A `GROQ_MODEL` override is visible in the startup
line, including an override that still points to a deprecated model. The
`Muse web search:` line reports the DuckDuckGo HTML/Lite backends. Research does
not use Gemini or assumed browsing built into ordinary text-generation models.

Each browser session gets an independent `MuseAgent` and its own saved-memory file under `scripts/data/muse-http-sessions/`. Conversation history stays in that session's server memory and resets when the server restarts. The page sends messages only to this server; the server then sends them to the configured model provider.

Muse does not authenticate `/api/chat`; any client that can reach the server can send messages and use the configured model providers. In GitHub Codespaces, set port `3000` visibility to **Private** and keep the Codespace private. Anyone able to reach a shared or public port may consume provider quota or incur API charges. Do not expose this development server publicly; add authentication and rate limits before any shared or production deployment. If you previously stored `MUSE_CHAT_ACCESS_TOKEN` in Codespaces Secrets, it is no longer used and can be removed.

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
