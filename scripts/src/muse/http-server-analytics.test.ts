import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Script } from "node:vm";
import test from "node:test";
import type { TextGenerationProvider } from "./llm-provider.js";
import {
  createMuseHttpServer,
  type MuseHttpServerOptions,
} from "./http-server.js";

type FakeElement = {
  hidden: boolean;
  disabled: boolean;
  value: string;
  textContent: string;
  style: { height: string };
  scrollHeight: number;
  dataset: Record<string, string>;
  listeners: Record<string, (event: any) => void | Promise<void>>;
  children: FakeElement[];
  className: string;
  attributes: Record<string, string>;
  addEventListener(name: string, listener: (event: any) => void | Promise<void>): void;
  setAttribute(name: string, value: string): void;
  append(...children: FakeElement[]): void;
  replaceChildren(...children: FakeElement[]): void;
  focus(): void;
  click(): void;
  scrollIntoView(): void;
  requestSubmit(): void;
  contains(node: unknown): boolean;
};

function fakeElement(tagName = "div"): FakeElement {
  return {
    hidden: false,
    disabled: false,
    value: "",
    textContent: "",
    style: { height: "" },
    scrollHeight: 0,
    dataset: {},
    listeners: {},
    children: [],
    className: tagName,
    attributes: {},
    addEventListener(name, listener) {
      this.listeners[name] = listener;
    },
    setAttribute(name, value) {
      this.attributes[name] = value;
    },
    append(...children) {
      this.children.push(...children);
    },
    replaceChildren(...children) {
      this.children = [...children];
    },
    focus() {},
    click() {},
    scrollIntoView() {},
    requestSubmit() {},
    contains(node) {
      return node === this || this.children.includes(node as FakeElement);
    },
  };
}

async function withAnalyticsServer(
  run: (baseUrl: string, dataDirectory: string) => Promise<void>,
  options: Partial<MuseHttpServerOptions> = {},
): Promise<void> {
  const dataDirectory = await mkdtemp(join(tmpdir(), "muse-analytics-http-"));
  const providerFactory = (): TextGenerationProvider => ({
    generateText: async () => "Unused in analytics tests.",
  });
  const server = createMuseHttpServer({
    sessionSecret: "muse-analytics-test-signing-secret",
    memoryDirectory: dataDirectory,
    analyticsFilePath: join(dataDirectory, "events.jsonl"),
    researchImageFinder: async () => [],
    providerFactory,
    ...options,
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("The analytics test server did not bind to a TCP port.");
  }
  try {
    await run(`http://127.0.0.1:${address.port}`, dataDirectory);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
    await rm(dataDirectory, { recursive: true, force: true });
  }
}

function analyticsCookieHeader(response: Response): string {
  const raw = response.headers.get("set-cookie") ?? "";
  const matches = raw.match(/(?:^|,\s*)(muse_analytics_(?:visitor|session)=[^;,]+)/g) ?? [];
  return matches.map((cookie) => cookie.replace(/^,\s*/, "")).join("; ");
}

function browserSandbox(
  script: string,
  initialConsent: string | null,
): {
  elements: Map<string, FakeElement>;
  requests: Array<{ url: string; options?: RequestInit }>;
  consent: { getItem(key: string): string | null; setItem(key: string, value: string): void };
} {
  const selectors = [
    "#analytics-consent",
    "#analytics-accept",
    "#analytics-decline",
    "#analytics-settings",
  ];
  const elements = new Map(selectors.map((selector) => [selector, fakeElement()]));
  const requests: Array<{ url: string; options?: RequestInit }> = [];
  let storedConsent = initialConsent;
  const consent = {
    getItem: (key: string) => key === "muse-analytics-consent" ? storedConsent : null,
    setItem: (key: string, value: string) => {
      if (key === "muse-analytics-consent") storedConsent = value;
    },
  };
  const document = {
    querySelector: (selector: string) => elements.get(selector) ?? fakeElement(),
    createElement: (tagName: string) => fakeElement(tagName),
    createElementNS: (_namespace: string, tagName: string) => fakeElement(tagName),
    createTextNode: (text: string) => {
      const node = fakeElement("#text");
      node.textContent = text;
      return node;
    },
    addEventListener() {},
  };
  const sandbox = {
    document,
    URL,
    window: {},
    navigator: { language: "en" },
    location: { pathname: "/" },
    localStorage: consent,
    fetch: (url: string, options?: RequestInit) => {
      requests.push({ url, options });
      const authCheck = url === "/api/auth/me";
      return Promise.resolve({
        ok: true,
        status: authCheck ? 200 : 202,
        json: async () => authCheck ? { authenticated: false } : { recorded: true },
      });
    },
  };
  new Script(script).runInNewContext(sandbox);
  return { elements, requests, consent };
}

test("analytics only starts after opt-in, records no message content, and can be declined", async () => {
  await withAnalyticsServer(async (baseUrl) => {
    const page = await fetch(baseUrl);
    const html = await page.text();
    const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
    assert.ok(script);

    const preview = browserSandbox(script, null);
    assert.equal(preview.elements.get("#analytics-consent")?.hidden, false);
    assert.equal(
      preview.requests.filter(({ url }) => url === "/api/analytics/collect").length,
      0,
    );
    preview.elements.get("#analytics-accept")?.listeners.click?.({});
    await Promise.resolve();
    assert.equal(preview.elements.get("#analytics-consent")?.hidden, true);
    assert.equal(preview.consent.getItem("muse-analytics-consent"), "accepted");
    const collectionRequests = preview.requests.filter(({ url }) => url === "/api/analytics/collect");
    assert.equal(collectionRequests.length, 1);
    const pageViewBody = JSON.parse(String(collectionRequests[0]?.options?.body));
    assert.deepEqual(pageViewBody, { type: "page_view", path: "/" });

    const declined = browserSandbox(script, null);
    declined.elements.get("#analytics-decline")?.listeners.click?.({});
    await Promise.resolve();
    assert.equal(declined.consent.getItem("muse-analytics-consent"), "declined");
    assert.deepEqual(
      declined.requests
        .filter(({ url }) => url.startsWith("/api/analytics/"))
        .map(({ url }) => url),
      ["/api/analytics/forget"],
    );
  });
});

test("analytics collection is pseudonymous and reports are protected by a server-only token", async () => {
  const adminToken = "muse-private-dashboard-token-32-characters-long";
  await withAnalyticsServer(
    async (baseUrl, dataDirectory) => {
      const dashboard = await fetch(`${baseUrl}/analytics`);
      assert.equal(dashboard.status, 200);
      assert.equal(dashboard.headers.get("cache-control"), "no-store");
      const dashboardHtml = await dashboard.text();
      assert.match(dashboardHtml, /Site analytics/);
      assert.match(dashboardHtml, /Authorization: "Bearer " \+ token/);
      assert.doesNotMatch(dashboardHtml, /sessionStorage|localStorage/);
      const dashboardScript = dashboardHtml.match(/<script>([\s\S]*?)<\/script>/)?.[1];
      assert.ok(dashboardScript);
      assert.doesNotThrow(() => new Script(dashboardScript));

      const unauthorized = await fetch(`${baseUrl}/api/analytics/report?days=30`);
      assert.equal(unauthorized.status, 401);

      const firstEvent = await fetch(`${baseUrl}/api/analytics/collect`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Forwarded-Proto": "https",
        },
        body: JSON.stringify({
          type: "page_view",
          path: "/?email=person@example.com&private=1",
          message: "This private message must never be retained.",
        }),
      });
      assert.equal(firstEvent.status, 202);
      const cookies = analyticsCookieHeader(firstEvent);
      assert.match(cookies, /muse_analytics_visitor=/);
      assert.match(cookies, /muse_analytics_session=/);
      const setCookies = firstEvent.headers.get("set-cookie") ?? "";
      assert.match(setCookies, /HttpOnly/);
      assert.match(setCookies, /SameSite=Lax/);
      assert.match(setCookies, /Secure/);

      const secondEvent = await fetch(`${baseUrl}/api/analytics/collect`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: cookies,
        },
        body: JSON.stringify({
          type: "chat_message_sent",
          path: "/",
          prompt: "Do not retain this prompt either.",
        }),
      });
      assert.equal(secondEvent.status, 202);

      const invalidEvent = await fetch(`${baseUrl}/api/analytics/collect`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "raw_message", message: "must not be accepted as a type" }),
      });
      assert.equal(invalidEvent.status, 400);

      const log = await readFile(join(dataDirectory, "events.jsonl"), "utf8");
      assert.equal(log.split("\n").filter(Boolean).length, 2);
      assert.doesNotMatch(
        log,
        /person@example\.com|private message|Do not retain|muse_analytics_visitor=|muse_analytics_session=/,
      );
      assert.match(log, /"path":"\/"/);
      assert.match(log, /"visitorHash":"[a-f0-9]{64}"/);

      const wrongToken = await fetch(`${baseUrl}/api/analytics/report?days=7`, {
        headers: { Authorization: "Bearer not-the-admin-token" },
      });
      assert.equal(wrongToken.status, 401);

      const reportResponse = await fetch(`${baseUrl}/api/analytics/report?days=7`, {
        headers: { Authorization: `Bearer ${adminToken}` },
      });
      assert.equal(reportResponse.status, 200);
      const report = await reportResponse.json() as {
        days: number;
        totals: { pageViews: number; uniqueVisitors: number; sessions: number; interactions: number };
        daily: Array<{ pageViews: number }>;
        weekly: Array<{ pageViews: number }>;
        monthly: Array<{ pageViews: number }>;
      };
      assert.equal(report.days, 7);
      assert.deepEqual(report.totals, {
        pageViews: 1,
        uniqueVisitors: 1,
        newVisitors: 1,
        returningVisitors: 0,
        sessions: 1,
        interactions: 1,
      });
      assert.equal(report.daily.length, 7);
      assert.equal(report.daily.at(-1)?.pageViews, 1);
      assert.equal(report.weekly.at(-1)?.pageViews, 1);
      assert.equal(report.monthly.at(-1)?.pageViews, 1);

      const forget = await fetch(`${baseUrl}/api/analytics/forget`, { method: "POST" });
      assert.equal(forget.status, 200);
      assert.match(forget.headers.get("set-cookie") ?? "", /Max-Age=0/);
    },
    { analyticsAdminToken: adminToken },
  );
});

test("analytics reports remain unavailable until a strong admin token is configured", async () => {
  await withAnalyticsServer(
    async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/analytics/report`);
      assert.equal(response.status, 503);
      assert.match((await response.json()).error, /MUSE_ANALYTICS_ADMIN_TOKEN/);
    },
    { analyticsAdminToken: "" },
  );
});
