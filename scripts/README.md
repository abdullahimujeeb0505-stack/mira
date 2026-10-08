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
