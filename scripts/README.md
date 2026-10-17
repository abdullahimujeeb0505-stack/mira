# Muse Research Agent

Muse is a general-purpose research assistant with a Photon 2.0-connected
iMessage entry point. It avoids web searches for greetings and lightweight chat; factual
questions and explicit research requests use the existing DuckDuckGo search,
page retrieval, citation validation, and local archive pipeline. Replies
identify accessible pages and include their titles and URLs. Unavailable pages
are not presented as retrieved sources.

Muse also drafts complete general-purpose written deliverables, including
articles, essays, literature reviews, technical tutorials, reports, study
guides, outlines, and proposals. Factual work reuses the research pipeline;
creative or provided-material writing can proceed without an unnecessary web
search. It carries the current writing assignment into revision requests,
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
- `MUSE_LLM_PROVIDER` — `groq` (default), `openrouter`, or `agentrouter`.

For Groq, set `GROQ_API_KEY`; `GROK_API_CODING_KEY` remains supported for
backward compatibility. `GROQ_MODEL` is optional and defaults to
`llama-3.3-70b-versatile`, the model used by Groq's current [quickstart](https://console.groq.com/docs/quickstart).

For OpenRouter, set `OPENROUTER_API_KEY` and `OPENROUTER_MODEL`. The model is
required so deployment explicitly selects an available model; check its current
availability, rate limits, and price in the [model catalog](https://openrouter.ai/models).
Set a per-key spending limit in the OpenRouter dashboard under **Settings →
Keys** when creating or editing the key, and inspect usage in **Activity**.
Groq usage is available in the Groq console under **Settings → Usage**. Neither
provider is used as an automatic fallback for another.

For AgentRouter, set `AGENTROUTER_API_KEY`; `AGENTROUTER_MODEL` is an optional
override. Provider credentials are isolated: only the selected adapter receives
its own key.

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
response rather than fabricating a sourced answer. Retrieved page text and
archive context are passed to the model as untrusted evidence, and citations are
checked for in-range references and lexical support.

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
`reply` acknowledgement after accepting its outbound message. Search uses
public DuckDuckGo HTML and only retrieves
accessible HTML/text pages; search blocking, paywalls, dynamic sites, and
conflicting evidence can limit results. Prior matching archive entries are
identified as historical and are not treated as freshly verified. Conversations
are not restored after a process restart.
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

The preflight prints only prerequisite names and readiness states; it never prints secret values. It checks that `SESSION_SECRET` is non-empty, `MUSE_CHAT_ACCESS_TOKEN` is at least 32 UTF-8 bytes, the selected provider key is set, and the local `tsx` command is installed. Its standalone tests can run with Node.js alone:

```sh
pnpm --filter @workspace/scripts run muse-preflight-test
```

Start the lightweight HTTP chat demo:

```sh
pnpm --filter @workspace/scripts run muse-server
```

Open `http://localhost:3000` locally, or use the **Muse Chat Preview** workflow in Replit at port `3000` and path `/`. The server uses the selected LLM provider: configure Groq with `GROQ_API_KEY` (or the legacy `GROK_API_CODING_KEY`), OpenRouter with `OPENROUTER_API_KEY` and `OPENROUTER_MODEL`, or AgentRouter with `MUSE_LLM_PROVIDER=agentrouter` and `AGENTROUTER_API_KEY`. `SESSION_SECRET` is required to sign the browser's HTTP-only session cookie.

Each browser session gets an independent `MuseAgent` and its own saved-memory file under `scripts/data/muse-http-sessions/`. Conversation history stays in that session's server memory and resets when the server restarts. The page sends messages only to this server; the server then sends them to the configured model provider.

Development URLs are public by default. Before starting the preview, set `MUSE_CHAT_ACCESS_TOKEN` in Replit Secrets to a random value of at least 32 bytes. The page requires this access code and sends it in an authorization header; it is held in the current browser tab and is not saved to a cookie or local storage. The server fails closed if this secret is missing or too short. Keep the Replit development URL private as an additional layer, and add user-level access control and rate limits before any public deployment.

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
