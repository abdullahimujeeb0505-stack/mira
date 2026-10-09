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

Enter a message at the `You:` prompt. Type `/help` for memory commands or `/exit` to end the session. Muse uses the `GROK_API_CODING_KEY` secret and the Groq `openai/gpt-oss-20b` model. Conversation history is session-only.

Memories persist in `scripts/data/muse-memory.json` (ignored by Git); set `MUSE_MEMORY_PATH` to use a different file.

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
