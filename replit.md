# [Project name]

_Replace the heading above with the project's name, and this line with one sentence describing what this app does for users._

## Run & Operate

- Muse chat preview: use the **Muse Chat Preview** workflow, which runs `pnpm --filter @workspace/scripts run muse-server` on port `3000`; open the workflow preview at `/`. This is separate from the API preview at `/api` and the Canvas preview at `/__mockup`.
- Muse chat requires `SESSION_SECRET` and provider credentials; it has no access-code prompt or authentication on `/api/chat`. The task-aware chat server defaults both chat and research to Groq (`GROQ_API_KEY` or legacy `GROK_API_CODING_KEY`) with Gemini (`GEMINI_API_KEY`, optional `GEMINI_MODEL` default `gemini-3.5-flash`) as the request-failure fallback. An eligible Groq request failure retries once through Gemini; safety refusals do not. If a primary provider cannot be constructed (for example, because its key or required model is missing), the other configured provider is selected at startup; if Gemini is missing, Groq stays usable without failover. Override chat/research primaries with `MUSE_CHAT_LLM_PROVIDER` / `MUSE_RESEARCH_LLM_PROVIDER`, or pin both with `MUSE_LLM_PROVIDER` to one of `groq`, `openrouter` (`OPENROUTER_API_KEY` plus `OPENROUTER_MODEL`), `agentrouter` (`AGENTROUTER_API_KEY`), or `gemini`. Keep Codespaces port 3000 private: anyone who can reach `/api/chat` can use the configured providers and consume quota. The Photon listener defaults to Photon 2.0 Beta and requires `PHOTON_PROJECT_ID` and `PHOTON_API_KEY`; set `MUSE_PHOTON_TRANSPORT=spectrum` to opt into legacy Spectrum.
- The Muse workflow requires the workspace dependencies, including `tsx`. If its log says `tsx: not found`, the dependencies are not installed; do not replace the existing API or Canvas workflows to work around that.
- `pnpm --filter @workspace/api-server run dev` — run the API server (port 5000)
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from the OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- Required env: `DATABASE_URL` — Postgres connection string

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- API: Express 5
- DB: PostgreSQL + Drizzle ORM
- Validation: Zod (`zod/v4`), `drizzle-zod`
- API codegen: Orval (from OpenAPI spec)
- Build: esbuild (CJS bundle)

## Where things live

_Populate as you build — short repo map plus pointers to the source-of-truth file for DB schema, API contracts, theme files, etc._

## Architecture decisions

_Populate as you build — non-obvious choices a reader couldn't infer from the code (3-5 bullets)._

## Product

_Describe the high-level user-facing capabilities of this app once they exist._

## User preferences

_Populate as you build — explicit user instructions worth remembering across sessions._

## Gotchas

_Populate as you build — sharp edges, "always run X before Y" rules._

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
