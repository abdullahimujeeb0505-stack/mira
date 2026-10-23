# Muse

Muse is a conversational assistant whose chat persona is **Mira**. The browser chat supports everyday questions, brainstorming, writing, web research, sourced images, and optional image tools.

## Run the browser chat

Use Node.js and pnpm. Install the repository dependencies and configure the required secrets in your environment or secret manager:

```sh
pnpm install
```

- `SESSION_SECRET` — a strong random secret used to sign the HTTP-only browser session cookie.
- `GEMINI_API_KEY` — required for the default chat and research provider, Gemini `gemini-3.5-flash-lite`.
- Optional `MUSE_WEB_AUTH_FILE` and `MUSE_WEB_HISTORY_DIR` — override the local JSON paths for accounts and chat transcripts when the host provides persistent storage.

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

## Accounts, history, and hosting

The browser chat requires a username and password (no email); passwords are stored as salted scrypt hashes. Each account has a separate saved conversation and memory file. Signup is open to visitors who can reach the site, so accounts separate chat history but do not create an invite-only service or a provider-usage quota. The server stores chat transcripts as local JSON files; they are not end-to-end encrypted or shared between server instances. This release expects one instance (or sticky routing). On a free host with an ephemeral filesystem, accounts and history may be erased by a restart or redeploy. Keep the Codespaces port **Private**, and do not rely on persistence unless your host explicitly provides a persistent disk at no charge. This change does not enable paid hosting, activate a provider, or upgrade a plan; when using the live service, existing provider requests remain subject to that provider’s quotas and pricing. Check free-tier access before enabling live model calls.

## First-party site analytics

The chat page includes an optional, first-party analytics notice. Visitors must opt in before a page view or feature-use event is sent; they can decline or change their choice later. The self-hosted dashboard at `/analytics` reports page views, approximate unique browsers, sessions, returning browsers, and daily, weekly, and monthly summaries in UTC. Only allowlisted event names and a cleaned page path are stored—never chat text, prompts, attachment content, IP addresses, full referrers, or raw browser IDs. “Unique browsers” are pseudonymous opt-in browser cookies, not verified people or account identities. The chat, sign-in, and analytics screens also provide a persistent light/dark theme switch that follows the device preference until changed.

To unlock the private dashboard, generate a strong server-side token and add it as `MUSE_ANALYTICS_ADMIN_TOKEN` in the host's secret settings (do not put it in source code or a URL):

```sh
node -e 'console.log(require("node:crypto").randomBytes(32).toString("hex"))'
```

Then open `https://your-site/analytics` and enter that token. It is sent only in an Authorization header and held in page memory. Events are stored locally at `scripts/data/muse-web-analytics.jsonl` (ignored by Git), kept for up to 90 days, and capped at 100,000 events. Set `MUSE_WEB_ANALYTICS_FILE` if the host provides a persistent disk. A free host may erase the log on restart or redeploy; the analytics feature adds no third-party service or paid plan.

## Development

Run the Muse test suite and TypeScript check with:

```sh
pnpm --filter @workspace/scripts test
pnpm --filter @workspace/scripts typecheck
```

See [`scripts/README.md`](scripts/README.md) for iMessage setup, live research, provider configuration, and the broader Muse utilities.
