import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { XOAuthService } from "./x-oauth.js";

const clientId = "test-client-id";
const clientSecret = "test-client-secret";
const redirectUri = "http://127.0.0.1:3000/api/x/callback";

async function fixture(run: (path: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), "muse-x-oauth-"));
  try {
    await run(join(dir, "tokens.json"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("authorization URL uses PKCE S256 and required scopes", async () => {
  await fixture(async (tokenFile) => {
    const service = new XOAuthService({
      clientId, clientSecret, redirectUri, tokenFile,
    });
    const url = new URL(service.createAuthorizationUrl());

    assert.equal(url.origin, "https://twitter.com");
    assert.equal(url.pathname, "/i/oauth2/authorize");
    assert.equal(url.searchParams.get("client_id"), clientId);
    assert.equal(url.searchParams.get("redirect_uri"), redirectUri);
    assert.equal(url.searchParams.get("code_challenge_method"), "S256");
    assert.ok(url.searchParams.get("code_challenge"));
    assert.ok(url.searchParams.get("state"));
    assert.match(url.searchParams.get("scope") ?? "", /tweet\.write/);
    assert.match(url.searchParams.get("scope") ?? "", /offline\.access/);
  });
});

test("callback rejects an incorrect state before requesting a token", async () => {
  await fixture(async (tokenFile) => {
    let calls = 0;
    const service = new XOAuthService({
      clientId, clientSecret, redirectUri, tokenFile,
      fetchImpl: (async () => {
        calls += 1;
        throw new Error("Network should not be called");
      }) as typeof fetch,
    });

    service.createAuthorizationUrl();
    await assert.rejects(
      service.handleCallback("authorization-code", "wrong-state"),
      /state is missing, expired, or invalid/,
    );
    assert.equal(calls, 0);
  });
});

test("callback exchanges code and stores tokens with private permissions", async () => {
  await fixture(async (tokenFile) => {
    let requestBody = "";
    const service = new XOAuthService({
      clientId, clientSecret, redirectUri, tokenFile,
      fetchImpl: (async (_input, init) => {
        requestBody = String(init?.body ?? "");
        return new Response(JSON.stringify({
          access_token: "test-access-token",
          refresh_token: "test-refresh-token",
          expires_in: 3600,
          token_type: "bearer",
          scope: "tweet.read tweet.write users.read offline.access",
        }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }) as typeof fetch,
    });

    const authorization = new URL(service.createAuthorizationUrl());
    const state = authorization.searchParams.get("state");
    assert.ok(state);

    await service.handleCallback("test-code", state);

    const body = new URLSearchParams(requestBody);
    assert.equal(body.get("grant_type"), "authorization_code");
    assert.equal(body.get("code"), "test-code");
    assert.equal(body.get("redirect_uri"), redirectUri);
    assert.ok(body.get("code_verifier"));

    const saved = JSON.parse(await readFile(tokenFile, "utf8"));
    assert.equal(saved.accessToken, "test-access-token");
    assert.equal(saved.refreshToken, "test-refresh-token");
    assert.equal((await stat(tokenFile)).mode & 0o777, 0o600);
  });
});

test("fetches a public X post using its URL and connected read permission", async () => {
  await fixture(async (tokenFile) => {
    const calls: string[] = [];
    const service = new XOAuthService({
      clientId, clientSecret, redirectUri, tokenFile,
      fetchImpl: (async (input, init) => {
        const url = String(input);
        calls.push(url);

        if (url === "https://api.x.com/2/oauth2/token") {
          return new Response(JSON.stringify({
            access_token: "test-access-token",
            refresh_token: "test-refresh-token",
            expires_in: 3600,
            token_type: "bearer",
            scope: "tweet.read tweet.write users.read offline.access",
          }), { status: 200 });
        }

        assert.match(url, /^https:\/\/api\.x\.com\/2\/tweets\/123456789/);
        assert.equal(
          new Headers(init?.headers).get("Authorization"),
          "Bearer test-access-token",
        );

        return new Response(JSON.stringify({
          data: {
            id: "123456789",
            text: "A real post text returned by the mocked X API.",
          },
        }), { status: 200 });
      }) as typeof fetch,
    });

    const authorization = new URL(service.createAuthorizationUrl());
    await service.handleCallback(
      "test-code",
      authorization.searchParams.get("state")!,
    );

    const result = await service.fetchPostTextFromUrl(
      "https://x.com/example/status/123456789?s=20",
    );

    assert.deepEqual(result, {
      sourceUrl: "https://x.com/i/web/status/123456789",
      sourceText: "A real post text returned by the mocked X API.",
    });
    assert.equal(calls.length, 2);
  });
});

test("rejects non-X URLs before making a network request", async () => {
  await fixture(async (tokenFile) => {
    let calls = 0;
    const service = new XOAuthService({
      clientId, clientSecret, redirectUri, tokenFile,
      fetchImpl: (async () => {
        calls += 1;
        throw new Error("Network should not be called");
      }) as typeof fetch,
    });

    await assert.rejects(
      service.fetchPostTextFromUrl("https://example.com/not-an-x-post"),
      /post URL from x\.com or twitter\.com/,
    );
    assert.equal(calls, 0);
  });
});

test("callback state can only be consumed once", async () => {
  await fixture(async (tokenFile) => {
    const service = new XOAuthService({
      clientId, clientSecret, redirectUri, tokenFile,
      fetchImpl: (async () => new Response(JSON.stringify({
        access_token: "token",
        expires_in: 3600,
        token_type: "bearer",
        scope: "tweet.read",
      }), { status: 200 })) as typeof fetch,
    });

    const authorization = new URL(service.createAuthorizationUrl());
    const state = authorization.searchParams.get("state")!;
    await service.handleCallback("code", state);

    await assert.rejects(
      service.handleCallback("code", state),
      /state is missing, expired, or invalid/,
    );
  });
});
