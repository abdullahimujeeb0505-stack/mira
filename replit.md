# [Project name]

_Replace the heading above with the project's name, and this line with one sentence describing what this app does for users._

## Run & Operate

- Muse chat preview: use the **Muse Chat Preview** workflow, which runs `pnpm --filter @workspace/scripts run muse-server` on port `3000`; open the workflow preview at `/`. This is separate from the API preview at `/api` and the Canvas preview at `/__mockup`.
- Muse requires `SESSION_SECRET`, `MUSE_CHAT_ACCESS_TOKEN` (at least 32 bytes), and a provider key in Replit Secrets. The default Groq provider uses `GROK_API_CODING_KEY`; AgentRouter uses `AGENTROUTER_API_KEY` when `MUSE_LLM_PROVIDER=agentrouter`.
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
