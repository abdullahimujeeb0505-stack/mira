# Hello HTTP server

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

## Muse CLI

Start a conversation with Muse, the personal Web3 intern:

```sh
pnpm --filter @workspace/scripts run muse
```

Enter a message at the `You:` prompt. Type `/help` for memory commands or `/exit` to end the session. By default, Muse uses the `GROK_API_CODING_KEY` secret and the Groq `openai/gpt-oss-20b` model. Conversation history is session-only.

Set `MUSE_LLM_PROVIDER=agentrouter` to use AgentRouter instead. This requires `AGENTROUTER_API_KEY`; `AGENTROUTER_MODEL` optionally overrides the default `gpt-5.6-sol` model. AgentRouter models can change availability, so verify the current model list in its [AgentRouter Codex guide](https://ps.air-outer.com/docs/codex.html). Set `MUSE_LLM_PROVIDER=groq` or leave it unset to keep using Groq.

Memories persist in `scripts/data/muse-memory.json` (ignored by Git); set `MUSE_MEMORY_PATH` to use a different file.

## Muse browser demo

Start the lightweight HTTP chat demo:

```sh
pnpm --filter @workspace/scripts run muse-server
```

Open `http://localhost:3000` (or the configured `PORT`). The server uses the existing Groq provider by default; configure `GROK_API_CODING_KEY`, or choose AgentRouter with `MUSE_LLM_PROVIDER=agentrouter` and `AGENTROUTER_API_KEY`. `SESSION_SECRET` is required to sign the browser's HTTP-only session cookie.

Each browser session gets an independent `MuseAgent` and its own saved-memory file under `scripts/data/muse-http-sessions/`. Conversation history stays in that session's server memory and resets when the server restarts. The page sends messages only to this server; the server then sends them to the configured model provider.

The demo is not an authentication system: anyone who can reach its port can create a separate session. Keep it local or behind a trusted preview; add access control and request-rate limits before public deployment.

**Replit preview limitation:** this server is currently a `scripts` command, not a registered Replit artifact/workflow. Existing artifact previews do not auto-start or route to it. Run it manually on `PORT` for now; automatic preview needs a dedicated workflow/artifact registration.

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
