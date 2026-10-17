import {
  createHash,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import {
  chmod,
  mkdir,
  readFile,
  rename,
  writeFile,
} from "node:fs/promises";
import { dirname, resolve } from "node:path";

const AUTHORIZE_URL = "https://twitter.com/i/oauth2/authorize";
const TOKEN_URL = "https://api.x.com/2/oauth2/token";
const PROFILE_URL = "https://api.x.com/2/users/me";
const REQUIRED_SCOPES = [
  "tweet.read",
  "tweet.write",
  "users.read",
  "offline.access",
];

interface PendingAuthorization {
  state: string;
  verifier: string;
  expiresAt: number;
}

interface StoredTokens {
  accessToken: string;
  refreshToken?: string;
  expiresAt: number;
  scope: string;
  tokenType: string;
  updatedAt: string;
}

export interface XOAuthOptions {
  clientId?: string;
  clientSecret?: string;
  redirectUri?: string;
  tokenFile?: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

export interface XAccountStatus {
  connected: boolean;
  expiresAt?: string;
  scopes: string[];
  username?: string;
  error?: string;
}

function randomUrlSafe(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

function sha256Base64Url(value: string): string {
  return createHash("sha256").update(value).digest("base64url");
}

function safeEqual(a: string, b: string): boolean {
  const left = createHash("sha256").update(a).digest();
  const right = createHash("sha256").update(b).digest();
  return timingSafeEqual(left, right);
}

function parseExpiry(value: unknown, now: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new Error("X returned an invalid token expiry.");
  }
  return now + value * 1000;
}


function extractBestTweetText(payload: unknown): string | undefined {
  if (typeof payload !== "object" || payload === null) return undefined;

  const root = payload as Record<string, unknown>;
  const data = typeof root.data === "object" && root.data !== null
    ? root.data as Record<string, unknown>
    : undefined;
  const legacy = typeof root.legacy === "object" && root.legacy !== null
    ? root.legacy as Record<string, unknown>
    : undefined;
  const note = typeof root.note_tweet === "object" && root.note_tweet !== null
    ? root.note_tweet as Record<string, unknown>
    : undefined;
  const dataLegacy = data && typeof data.legacy === "object" && data.legacy !== null
    ? data.legacy as Record<string, unknown>
    : undefined;
  const dataNote = data && typeof data.note_tweet === "object" && data.note_tweet !== null
    ? data.note_tweet as Record<string, unknown>
    : undefined;

  const candidates = [
    dataNote?.text,
    dataLegacy?.full_text,
    dataLegacy?.text,
    note?.text,
    legacy?.full_text,
    legacy?.text,
    data?.text,
    root.text,
  ].filter((value): value is string =>
    typeof value === "string" && value.trim().length > 0
  );

  return candidates.sort((a, b) => b.length - a.length)[0]?.trim();
}

export class XOAuthService {
  private readonly clientId: string;
  private readonly clientSecret: string;
  private readonly redirectUri: string;
  private readonly tokenFile: string;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private pending?: PendingAuthorization;
  private refreshInFlight?: Promise<StoredTokens>;

  constructor(options: XOAuthOptions = {}) {
    this.clientId = options.clientId ?? process.env.X_CLIENT_ID ?? "";
    this.clientSecret = options.clientSecret ?? process.env.X_CLIENT_SECRET ?? "";
    this.redirectUri = options.redirectUri ?? process.env.X_REDIRECT_URI ?? "";
    this.tokenFile = resolve(
      options.tokenFile ??
      process.env.MUSE_X_TOKEN_FILE ??
      "scripts/data/muse-x-tokens.json",
    );
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? Date.now;

    if (!this.clientId.trim()) throw new Error("X_CLIENT_ID is required.");
    if (!this.clientSecret.trim()) throw new Error("X_CLIENT_SECRET is required.");

    let redirect: URL;
    try {
      redirect = new URL(this.redirectUri);
    } catch {
      throw new Error("X_REDIRECT_URI must be a valid URL.");
    }

    if (
      redirect.protocol !== "https:" &&
      !(redirect.protocol === "http:" &&
        ["localhost", "127.0.0.1", "[::1]"].includes(redirect.hostname))
    ) {
      throw new Error("X redirect URI must use HTTPS, except for localhost.");
    }
  }

  createAuthorizationUrl(): string {
    this.pending = {
      state: randomUrlSafe(32),
      verifier: randomUrlSafe(64),
      expiresAt: this.now() + 10 * 60 * 1000,
    };

    const url = new URL(AUTHORIZE_URL);
    url.search = new URLSearchParams({
      response_type: "code",
      client_id: this.clientId,
      redirect_uri: this.redirectUri,
      scope: REQUIRED_SCOPES.join(" "),
      state: this.pending.state,
      code_challenge: sha256Base64Url(this.pending.verifier),
      code_challenge_method: "S256",
    }).toString();

    return url.toString();
  }

  async handleCallback(code: string, state: string): Promise<void> {
    const pending = this.pending;
    this.pending = undefined;

    if (
      !pending ||
      pending.expiresAt < this.now() ||
      !code ||
      !state ||
      !safeEqual(state, pending.state)
    ) {
      throw new Error("X authorization state is missing, expired, or invalid.");
    }

    const body = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: this.redirectUri,
      code_verifier: pending.verifier,
    });

    const tokens = await this.requestTokens(body);
    await this.saveTokens(tokens);
  }

  async status(): Promise<XAccountStatus> {
    let tokens: StoredTokens;
    try {
      tokens = await this.readTokens();
    } catch {
      return { connected: false, scopes: [] };
    }

    try {
      const current = await this.getUsableTokens(tokens);
      const response = await this.fetchImpl(PROFILE_URL, {
        headers: { Authorization: `Bearer ${current.accessToken}` },
        signal: AbortSignal.timeout(15_000),
      });

      if (!response.ok) {
        return {
          connected: false,
          expiresAt: new Date(current.expiresAt).toISOString(),
          scopes: current.scope.split(" ").filter(Boolean),
          error: `X profile check failed with HTTP ${response.status}.`,
        };
      }

      const data: unknown = await response.json();
      const username =
        typeof data === "object" && data !== null &&
        "data" in data &&
        typeof data.data === "object" && data.data !== null &&
        "username" in data.data &&
        typeof data.data.username === "string"
          ? data.data.username
          : undefined;

      return {
        connected: true,
        expiresAt: new Date(current.expiresAt).toISOString(),
        scopes: current.scope.split(" ").filter(Boolean),
        ...(username ? { username } : {}),
      };
    } catch {
      return {
        connected: false,
        expiresAt: new Date(tokens.expiresAt).toISOString(),
        scopes: tokens.scope.split(" ").filter(Boolean),
        error: "Could not verify the X connection. Check connectivity and credentials.",
      };
    }
  }

  async fetchPostTextFromUrl(
    sourceUrl: string,
  ): Promise<{ sourceUrl: string; sourceText: string }> {
    let url: URL;
    try {
      url = new URL(sourceUrl);
    } catch {
      throw new Error("Provide a valid X post URL.");
    }

    if (
      url.protocol !== "https:" ||
      !["x.com", "www.x.com", "twitter.com", "www.twitter.com"].includes(url.hostname)
    ) {
      throw new Error("Provide a post URL from x.com or twitter.com.");
    }

    const match = url.pathname.match(
      /^\/(?:[^/]+\/status|i\/web\/status)\/(\d+)\/?$/,
    );
    if (!match) {
      throw new Error("That URL does not look like an individual X post.");
    }

    const postId = match[1]!;
    const stored = await this.readTokens();
    const tokens = await this.getUsableTokens(stored);

    if (!tokens.scope.split(" ").includes("tweet.read")) {
      throw new Error(
        "The connected X account lacks tweet.read permission. Reconnect X and approve read access.",
      );
    }

    const apiUrl = new URL(`https://api.x.com/2/tweets/${postId}`);
    apiUrl.searchParams.set("tweet.fields", "created_at,author_id");

    const response = await this.fetchImpl(apiUrl, {
      headers: {
        Authorization: `Bearer ${tokens.accessToken}`,
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(15000),
    });

    if (!response.ok) {
      if (response.status === 402) {
        try {
          const fallbackUrl = new URL(
            "https://cdn.syndication.twimg.com/tweet-result",
          );
          fallbackUrl.searchParams.set("id", postId);
          fallbackUrl.searchParams.set("lang", "en");
          fallbackUrl.searchParams.set(
            "token",
            ((Number(postId) / 1e15) * Math.PI)
              .toString(36)
              .replace(/(0+|\.)/g, ""),
          );

          const fallbackResponse = await this.fetchImpl(fallbackUrl, {
            headers: { Accept: "application/json" },
            signal: AbortSignal.timeout(12000),
          });

          if (fallbackResponse.ok) {
            const fallbackPayload: unknown = await fallbackResponse.json();
            const sourceText = extractBestTweetText(fallbackPayload);
            if (sourceText) {
              return {
                sourceUrl: `https://x.com/i/web/status/${postId}`,
                sourceText,
              };
            }
          }
        } catch {
          // Keep the official API error if the fallback fails.
        }
      }

      throw new Error(
        `Could not fetch that X post (HTTP ${response.status}). It may be private, deleted, unavailable, or inaccessible to this account.`,
      );
    }

    const payload: unknown = await response.json();
    if (
      typeof payload !== "object" || payload === null ||
      !("data" in payload) ||
      typeof payload.data !== "object" || payload.data === null ||
      !("id" in payload.data) || payload.data.id !== postId
    ) {
      throw new Error("X returned no readable text for that post.");
    }

    const sourceText = extractBestTweetText(payload);
    if (!sourceText) {
      throw new Error("X returned no readable text for that post.");
    }

    return {
      sourceUrl: `https://x.com/i/web/status/${postId}`,
      sourceText,
    };
  }

  async publishPost(text: string): Promise<{ id: string; text: string }> {
    const content = text.trim();
    if (!content) throw new Error("Post text cannot be empty.");
    if (content.length > 280) {
      throw new Error("Post text exceeds 280 characters.");
    }

    const stored = await this.readTokens();
    const tokens = await this.getUsableTokens(stored);

    if (!tokens.scope.split(" ").includes("tweet.write")) {
      throw new Error("The connected X account has no tweet.write permission. Reconnect X and approve posting access.");
    }

    const response = await this.fetchImpl("https://api.x.com/2/tweets", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${tokens.accessToken}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({ text: content }),
      signal: AbortSignal.timeout(20_000),
    });

    if (!response.ok) {
      throw new Error(`X post creation failed with HTTP ${response.status}.`);
    }

    const payload: unknown = await response.json();
    if (
      typeof payload !== "object" || payload === null ||
      !("data" in payload) ||
      typeof payload.data !== "object" || payload.data === null ||
      !("id" in payload.data) || typeof payload.data.id !== "string" ||
      !("text" in payload.data) || typeof payload.data.text !== "string"
    ) {
      throw new Error("X returned an invalid post response.");
    }

    return { id: payload.data.id, text: payload.data.text };
  }

  private async getUsableTokens(tokens: StoredTokens): Promise<StoredTokens> {
    if (tokens.expiresAt > this.now() + 60_000) return tokens;
    if (!tokens.refreshToken) {
      throw new Error("X token expired and no refresh token is available.");
    }

    if (!this.refreshInFlight) {
      this.refreshInFlight = this.refresh(tokens).finally(() => {
        this.refreshInFlight = undefined;
      });
    }
    return this.refreshInFlight;
  }

  private async refresh(tokens: StoredTokens): Promise<StoredTokens> {
    const body = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: tokens.refreshToken!,
    });
    const refreshed = await this.requestTokens(body);
    await this.saveTokens(refreshed);
    return refreshed;
  }

  private async requestTokens(body: URLSearchParams): Promise<StoredTokens> {
    const basic = Buffer.from(
      `${this.clientId}:${this.clientSecret}`,
      "utf8",
    ).toString("base64");

    const response = await this.fetchImpl(TOKEN_URL, {
      method: "POST",
      headers: {
        Authorization: `Basic ${basic}`,
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body,
      signal: AbortSignal.timeout(20_000),
    });

    if (!response.ok) {
      // Never relay X's raw response, which may contain sensitive details.
      throw new Error(`X token exchange failed with HTTP ${response.status}.`);
    }

    const data: unknown = await response.json();
    if (typeof data !== "object" || data === null) {
      throw new Error("X returned an invalid token response.");
    }

    const record = data as Record<string, unknown>;
    if (
      typeof record.access_token !== "string" ||
      typeof record.expires_in !== "number" ||
      typeof record.token_type !== "string" ||
      typeof record.scope !== "string"
    ) {
      throw new Error("X token response is missing required fields.");
    }

    return {
      accessToken: record.access_token,
      ...(typeof record.refresh_token === "string"
        ? { refreshToken: record.refresh_token }
        : {}),
      expiresAt: parseExpiry(record.expires_in, this.now()),
      scope: record.scope,
      tokenType: record.token_type,
      updatedAt: new Date(this.now()).toISOString(),
    };
  }

  private async readTokens(): Promise<StoredTokens> {
    const text = await readFile(this.tokenFile, "utf8");
    const value: unknown = JSON.parse(text);
    if (
      typeof value !== "object" || value === null ||
      !("accessToken" in value) ||
      typeof value.accessToken !== "string" ||
      !("expiresAt" in value) || typeof value.expiresAt !== "number" ||
      !("scope" in value) || typeof value.scope !== "string" ||
      !("tokenType" in value) || typeof value.tokenType !== "string"
    ) {
      throw new Error("Stored X token data is invalid.");
    }
    return value as StoredTokens;
  }

  private async saveTokens(tokens: StoredTokens): Promise<void> {
    await mkdir(dirname(this.tokenFile), { recursive: true, mode: 0o700 });
    const temporary = `${this.tokenFile}.${randomUrlSafe(8)}.tmp`;
    await writeFile(temporary, JSON.stringify(tokens, null, 2), {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    await chmod(temporary, 0o600);
    await rename(temporary, this.tokenFile);
    await chmod(this.tokenFile, 0o600);
  }
}
