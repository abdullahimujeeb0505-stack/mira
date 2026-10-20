# Muse

Muse is a conversational assistant whose chat persona is **Mira**. The browser chat supports everyday questions, brainstorming, writing, web research, sourced images, and optional image tools.

## Run the browser chat

Use Node.js and pnpm. Install the repository dependencies and configure the required secrets in your environment or secret manager:

```sh
pnpm install
```

- `SESSION_SECRET` — a strong random secret used to sign the browser session cookie.
- `GEMINI_API_KEY` — required for the default chat and research provider, Gemini `gemini-3.5-flash-lite`.

Start the server from the repository root:

```sh
pnpm --filter @workspace/scripts run muse-server
```

Open <http://localhost:3000>. In GitHub Codespaces, forward port `3000` and use its forwarded URL.

Run the prerequisite check before startup with:

```sh
pnpm --filter @workspace/scripts run muse-preflight
```

Cloudflare Workers AI image generation and image understanding are optional. Configure `MUSE_CLOUDFLARE_ACCOUNT_ID` and `MUSE_CLOUDFLARE_AI_TOKEN` to enable them. Chat and research provider overrides, attachment handling, limits, and additional commands are documented in [`scripts/README.md`](scripts/README.md).

## Security note

The browser chat API does not authenticate `/api/chat`. Keep Codespaces port `3000` **Private**, and do not expose this development server on a public or shared network. Anyone who can reach it may send messages through the configured provider credentials.

## Development

Run the Muse test suite and TypeScript check with:

```sh
pnpm --filter @workspace/scripts test
pnpm --filter @workspace/scripts typecheck
```

See [`scripts/README.md`](scripts/README.md) for iMessage setup, live research, provider configuration, and the broader Muse utilities.
