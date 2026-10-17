# Muse Research Agent

Muse is a general-purpose research assistant with a Photon-connected iMessage
entry point. It avoids web searches for greetings and lightweight chat; factual
questions and explicit research requests use the existing DuckDuckGo search,
page retrieval, citation validation, and local archive pipeline. Replies
identify accessible pages and include their titles and URLs. Unavailable pages
are not presented as retrieved sources.

## Start Muse in iMessage

Use Photon Spectrum Stable (`spectrum-ts` 12.11.0) and a project with an
iMessage line configured. The integration follows the official [Spectrum
TypeScript quickstart](https://photon.codes/docs/spectrum-ts/getting-started)
and [iMessage provider guide](https://photon.codes/docs/spectrum-ts/providers/imessage).
Set these environment variables:

- `SPECTRUM_PROJECT_ID` — required Photon project ID.
- `SPECTRUM_PROJECT_SECRET` — required Photon project secret.
- `GROK_API_CODING_KEY` — required by default for the existing Groq model
  provider; despite the variable name, this is the configured Groq credential.

Alternatively, set `MUSE_LLM_PROVIDER=agentrouter` and
`AGENTROUTER_API_KEY` instead of `GROK_API_CODING_KEY`.
`AGENTROUTER_MODEL` and `GROQ_MODEL` are optional model overrides.
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
No X developer account, X credentials, browser session secret, or search API
key is required by the Photon agent.

From the repository root, start the listener with:

```sh
pnpm --filter @workspace/scripts run muse-photon
```

Stop it with Ctrl-C or SIGTERM; the listener closes the Spectrum app cleanly.
Each iMessage space has separate in-process conversation history and a
separately hashed memory file under `scripts/data/muse-photon-spaces/` by
default. The agent uses Photon typing indicators while researching, ignores
outbound events and non-text content, and sends responses as replies to the
incoming message. Search uses public DuckDuckGo HTML and only retrieves
accessible HTML/text pages; search blocking, paywalls, dynamic sites, and
conflicting evidence can limit results. Prior matching archive entries are
identified as historical and are not treated as freshly verified. Conversations
are not restored after a process restart.
Research URLs are restricted to HTTP(S), checked against private and local
addresses, and fetched with redirect, time, and response-size limits. Hostname
validation uses a DNS preflight; DNS changes between that check and the HTTP
connection are not pinned, so this is not a general-purpose URL-fetching service.

Automated tests use deterministic providers and fake Photon events; they do not
call a live model, search service, X API, or messaging API. No live iMessage
interaction has been verified. Configure Photon credentials and a managed
iMessage line, start the command above, then send a message to the configured
line to complete end-to-end verification.

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

With the `GROK_API_CODING_KEY` secret configured, run:

```sh
pnpm --filter @workspace/scripts run groq-api-test
```

The script sends `Reply with exactly: GROQ WORKS` to Groq's Responses API using `openai/gpt-oss-20b` and prints the model response.

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

Open `http://localhost:3000` locally, or use the **Muse Chat Preview** workflow in Replit at port `3000` and path `/`. The server uses the existing Groq provider by default; configure `GROK_API_CODING_KEY`, or choose AgentRouter with `MUSE_LLM_PROVIDER=agentrouter` and `AGENTROUTER_API_KEY`. `SESSION_SECRET` is required to sign the browser's HTTP-only session cookie.

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
