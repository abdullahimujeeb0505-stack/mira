import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  buildWebAnalyticsReport,
  JsonWebAnalyticsStore,
  type WebAnalyticsEvent,
} from "./web-analytics.js";

const now = Date.UTC(2026, 9, 23, 12, 0, 0);
const visitorA = "a".repeat(64);
const visitorB = "b".repeat(64);
const sessionA = "c".repeat(64);
const sessionB = "d".repeat(64);

function event(
  timestamp: number,
  visitorHash: string,
  sessionHash: string,
  type: WebAnalyticsEvent["type"],
  path = "/",
): WebAnalyticsEvent {
  return { timestamp, visitorHash, sessionHash, type, path };
}

test("analytics store serializes writes, applies retention, and protects its local log", async () => {
  const directory = await mkdtemp(join(tmpdir(), "muse-web-analytics-"));
  const path = join(directory, "events.jsonl");
  const store = new JsonWebAnalyticsStore(path, 30);
  const currentTime = Date.now();
  try {
    await writeFile(
      path,
      `${JSON.stringify(event(currentTime - 31 * 24 * 60 * 60 * 1_000, visitorA, sessionA, "page_view"))}\n`,
    );
    await Promise.all([
      store.record(event(currentTime - 10 * 24 * 60 * 60 * 1_000, visitorA, sessionA, "page_view")),
      store.record(event(currentTime, visitorB, sessionB, "chat_message_sent")),
    ]);
    const saved = await store.readEvents(currentTime);
    assert.equal(saved.length, 2);
    assert.deepEqual(saved.map(({ type }) => type), ["page_view", "chat_message_sent"]);
    assert.equal((await stat(path)).mode & 0o777, 0o600);

    const raw = await readFile(path, "utf8");
    assert.equal(raw.trim().split("\n").length, 2);
    assert.doesNotMatch(raw, /username|email|prompt|message text|127\.0\.0\.1/);
    assert.match(raw, /visitorHash/);
    assert.match(raw, /sessionHash/);

    await assert.rejects(
      () => store.record({
        ...event(now, visitorA, sessionA, "page_view"),
        path: "/?email=someone@example.com",
      }),
      /analytics event is invalid/i,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("analytics report groups page visits by UTC day, week, and month", () => {
  const events = [
    event(Date.UTC(2026, 9, 10, 9), visitorA, sessionA, "page_view"),
    event(Date.UTC(2026, 9, 19, 10), visitorA, sessionA, "page_view"),
    event(Date.UTC(2026, 9, 23, 8), visitorA, sessionA, "page_view"),
    event(Date.UTC(2026, 9, 23, 9), visitorB, sessionB, "page_view", "/about"),
    event(Date.UTC(2026, 9, 23, 9, 5), visitorB, sessionB, "chat_message_sent"),
  ];

  const report = buildWebAnalyticsReport(events, 7, now, 90);
  assert.deepEqual(report.totals, {
    pageViews: 3,
    uniqueVisitors: 2,
    newVisitors: 1,
    returningVisitors: 1,
    sessions: 2,
    interactions: 1,
  });
  assert.equal(report.daily.length, 7);
  assert.equal(report.daily.at(-1)?.period, "2026-10-23");
  assert.equal(report.daily.at(-1)?.pageViews, 2);
  assert.equal(report.daily.find(({ period }) => period === "2026-10-19")?.uniqueVisitors, 1);
  assert.equal(report.weekly.length, 2);
  assert.equal(report.weekly.at(-1)?.period, "2026-10-19");
  assert.equal(report.weekly.at(-1)?.uniqueVisitors, 2);
  assert.equal(report.monthly.length, 1);
  assert.equal(report.monthly[0]?.period, "2026-10");
  assert.deepEqual(report.topPages, [
    { path: "/", pageViews: 2, uniqueVisitors: 1 },
    { path: "/about", pageViews: 1, uniqueVisitors: 1 },
  ]);
  assert.deepEqual(report.eventBreakdown, [
    { type: "page_view", count: 3 },
    { type: "chat_message_sent", count: 1 },
  ]);
});
