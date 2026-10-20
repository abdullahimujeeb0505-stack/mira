# [Project name]

_Replace the heading above with the project's name, and this line with one sentence describing what this app does for users._

## Run & Operate

- Muse chat preview: use the **Muse Chat Preview** workflow, which runs `pnpm --filter @workspace/scripts run muse-server` on port `3000`; open the workflow preview at `/`. This is separate from the API preview at `/api` and the Canvas preview at `/__mockup`.
- Muse chat is a general-purpose conversational assistant with web research when useful; bare domains, full URLs, and Markdown links are read directly before search, with a crawl limited to the same registrable domain. It requires `SESSION_SECRET` and provider credentials and has no access-code prompt or authentication on `/api/chat`. The task-aware server defaults chat and research to Gemini (`GEMINI_API_KEY`, model `gemini-3.5-flash-lite`); Groq can serve as a fallback when configured. Supported providers are `gemini`, `groq`, `openrouter` (`OPENROUTER_API_KEY` plus `OPENROUTER_MODEL`), and `agentrouter` (`AGENTROUTER_API_KEY`); configure `MUSE_CHAT_LLM_PROVIDER` / `MUSE_RESEARCH_LLM_PROVIDER` per task or pin both with `MUSE_LLM_PROVIDER`. Gemini's model is pinned in code; `GEMINI_MODEL` is not read. Google may use free-tier content to improve its products, so avoid sending sensitive messages, text attachments, or image-analysis descriptions unless that data use is acceptable; raw image bytes go to Cloudflare vision, not Gemini. Keep Codespaces port 3000 private: anyone who can reach `/api/chat` can use the configured providers and consume quota. The Photon listener defaults to Photon 2.0 Beta and requires `PHOTON_PROJECT_ID` and `PHOTON_API_KEY`; set `MUSE_PHOTON_TRANSPORT=spectrum` to opt into legacy Spectrum.
- Browser multimodal features are optional: topic illustrations come from existing, attributed Wikimedia Commons images; Cloudflare FLUX Schnell runs only when the user explicitly chooses **+ → Generate an image**. Set `MUSE_CLOUDFLARE_ACCOUNT_ID` and `MUSE_CLOUDFLARE_AI_TOKEN` for image generation, LLaVA-first image analysis, and Moondream fallback. Image-analysis failures or missing vision configuration do not block chat; Mira is told not to guess image contents, and the UI shows an explicit notice. Per server process, generation is capped at 10 requests/hour and vision at 20 analyses/hour; Cloudflare's free usage is quota-limited, and Muse never automatically enables a paid plan. Uploads are JPEG/PNG/WebP (4 MB each) or TXT/Markdown/CSV (512 KB each), at most three files/8 MB per turn; data stays in memory and is discarded after the turn. PDF/DOCX are not supported. The responsive chat composer puts attachments and image generation under a + menu, with microphone dictation and speaker read-aloud icons. Browser dictation availability and privacy vary; some browser speech services may process audio remotely, while speech playback uses device voices.
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
