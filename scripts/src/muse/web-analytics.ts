import { randomUUID } from "node:crypto";
import {
  access,
  appendFile,
  chmod,
  mkdir,
  readFile,
  rename,
  writeFile,
} from "node:fs/promises";
import { dirname } from "node:path";

export const WEB_ANALYTICS_EVENT_TYPES = [
  "page_view",
  "chat_message_sent",
  "image_generation_requested",
  "attachment_uploaded",
  "voice_input_started",
] as const;

export type WebAnalyticsEventType = (typeof WEB_ANALYTICS_EVENT_TYPES)[number];

export interface WebAnalyticsEvent {
  timestamp: number;
  visitorHash: string;
  sessionHash: string;
  type: WebAnalyticsEventType;
  path: string;
}

export interface WebAnalyticsBucket {
  period: string;
  pageViews: number;
  uniqueVisitors: number;
  sessions: number;
  interactions: number;
}

export interface WebAnalyticsReport {
  generatedAt: string;
  days: 7 | 30 | 90;
  retentionDays: number;
  timeZone: "UTC";
  totals: {
    pageViews: number;
    uniqueVisitors: number;
    newVisitors: number;
    returningVisitors: number;
    sessions: number;
    interactions: number;
  };
  daily: WebAnalyticsBucket[];
  weekly: WebAnalyticsBucket[];
  monthly: WebAnalyticsBucket[];
  topPages: Array<{
    path: string;
    pageViews: number;
    uniqueVisitors: number;
  }>;
  eventBreakdown: Array<{ type: WebAnalyticsEventType; count: number }>;
}

const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1_000;
export const DEFAULT_WEB_ANALYTICS_RETENTION_DAYS = 90;
const MAX_RETAINED_EVENTS = 100_000;
const COMPACT_AFTER_EVENTS = 1_000;
const COMPACT_INTERVAL_MS = 24 * MILLISECONDS_PER_DAY;
const VALID_DAYS = new Set([7, 30, 90]);

export class JsonWebAnalyticsStore {
  private writeQueue: Promise<void> = Promise.resolve();
  private writesSinceCompaction = 0;
  private lastCompactionAt = 0;

  constructor(
    private readonly filePath: string,
    private readonly retentionDays = DEFAULT_WEB_ANALYTICS_RETENTION_DAYS,
  ) {
    if (!Number.isInteger(retentionDays) || retentionDays < 1) {
      throw new RangeError("retentionDays must be a positive integer.");
    }
  }

  record(event: WebAnalyticsEvent): Promise<void> {
    if (!isWebAnalyticsEvent(event)) {
      return Promise.reject(new TypeError("The analytics event is invalid."));
    }

    const operation = this.writeQueue.then(async () => {
      await mkdir(dirname(this.filePath), { recursive: true, mode: 0o700 });
      await appendFile(this.filePath, `${JSON.stringify(event)}\n`, {
        encoding: "utf8",
        mode: 0o600,
      });
      await chmod(this.filePath, 0o600);
      this.writesSinceCompaction += 1;
      const now = Date.now();
      if (
        this.writesSinceCompaction >= COMPACT_AFTER_EVENTS ||
        now - this.lastCompactionAt >= COMPACT_INTERVAL_MS
      ) {
        await this.compact(now);
      }
    });
    this.writeQueue = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  readEvents(now = Date.now()): Promise<WebAnalyticsEvent[]> {
    const operation = this.writeQueue.then(async () => {
      if (now - this.lastCompactionAt >= COMPACT_INTERVAL_MS) {
        await this.compact(now);
      }
      const events = await this.readValidEvents();
      const cutoff = now - this.retentionDays * MILLISECONDS_PER_DAY;
      return events
        .filter((event) => event.timestamp >= cutoff && event.timestamp <= now)
        .slice(-MAX_RETAINED_EVENTS);
    });
    this.writeQueue = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  prune(now = Date.now()): Promise<void> {
    const operation = this.writeQueue.then(async () => {
      if (now - this.lastCompactionAt >= COMPACT_INTERVAL_MS) {
        await this.compact(now);
      }
    });
    this.writeQueue = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  private async compact(now: number): Promise<void> {
    const cutoff = now - this.retentionDays * MILLISECONDS_PER_DAY;
    const events = (await this.readValidEvents())
      .filter((event) => event.timestamp >= cutoff && event.timestamp <= now)
      .slice(-MAX_RETAINED_EVENTS);
    if (events.length === 0) {
      try {
        await access(this.filePath);
      } catch (error) {
        if (isNodeError(error) && error.code === "ENOENT") {
          this.writesSinceCompaction = 0;
          this.lastCompactionAt = now;
          return;
        }
        throw error;
      }
    }
    await mkdir(dirname(this.filePath), { recursive: true, mode: 0o700 });
    const temporaryPath = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
    const contents = events.map((event) => JSON.stringify(event)).join("\n");
    await writeFile(temporaryPath, contents ? `${contents}\n` : "", {
      encoding: "utf8",
      mode: 0o600,
    });
    await rename(temporaryPath, this.filePath);
    await chmod(this.filePath, 0o600);
    this.writesSinceCompaction = 0;
    this.lastCompactionAt = now;
  }

  private async readValidEvents(): Promise<WebAnalyticsEvent[]> {
    let contents: string;
    try {
      contents = await readFile(this.filePath, "utf8");
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") return [];
      throw error;
    }

    const events: WebAnalyticsEvent[] = [];
    for (const line of contents.split("\n")) {
      if (!line) continue;
      try {
        const parsed: unknown = JSON.parse(line);
        if (isWebAnalyticsEvent(parsed)) events.push(parsed);
      } catch {
        // Ignore a partial or corrupt line and retain the rest of the log.
      }
    }
    return events;
  }
}

export function buildWebAnalyticsReport(
  events: readonly WebAnalyticsEvent[],
  days: number,
  now = Date.now(),
  retentionDays = DEFAULT_WEB_ANALYTICS_RETENTION_DAYS,
): WebAnalyticsReport {
  if (!VALID_DAYS.has(days)) {
    throw new RangeError("days must be 7, 30, or 90.");
  }

  const currentDayStart = startOfUtcDay(now);
  const firstDayStart = currentDayStart - (days - 1) * MILLISECONDS_PER_DAY;
  const validEvents = events.filter(
    (event) =>
      isWebAnalyticsEvent(event) &&
      event.timestamp <= now &&
      event.timestamp >= now - retentionDays * MILLISECONDS_PER_DAY,
  );
  const rangeEvents = validEvents.filter(
    (event) => event.timestamp >= firstDayStart,
  );
  const priorVisitors = new Set(
    validEvents
      .filter(
        (event) =>
          event.type === "page_view" && event.timestamp < firstDayStart,
      )
      .map((event) => event.visitorHash),
  );

  const daily = createBuckets(
    firstDayStart,
    currentDayStart,
    MILLISECONDS_PER_DAY,
    (start) => new Date(start).toISOString().slice(0, 10),
  );
  const firstWeekStart = startOfUtcWeek(firstDayStart);
  const currentWeekStart = startOfUtcWeek(currentDayStart);
  const weekly = createBuckets(
    firstWeekStart,
    currentWeekStart,
    7 * MILLISECONDS_PER_DAY,
    (start) => new Date(start).toISOString().slice(0, 10),
  );
  const firstMonthStart = startOfUtcMonth(firstDayStart);
  const currentMonthStart = startOfUtcMonth(currentDayStart);
  const monthly = createMonthBuckets(firstMonthStart, currentMonthStart);

  const dailyByPeriod = new Map(daily.map((bucket) => [bucket.period, bucket]));
  const weeklyByPeriod = new Map(weekly.map((bucket) => [bucket.period, bucket]));
  const monthlyByPeriod = new Map(monthly.map((bucket) => [bucket.period, bucket]));
  const visitorSets = new Map<string, Set<string>>();
  const sessionSets = new Map<string, Set<string>>();
  const pageVisitors = new Map<string, Set<string>>();
  const pageViews = new Map<string, number>();
  const eventCounts = new Map<WebAnalyticsEventType, number>();
  const totalVisitors = new Set<string>();
  const totalSessions = new Set<string>();
  const returningVisitors = new Set<string>();
  let totalPageViews = 0;
  let totalInteractions = 0;

  for (const event of rangeEvents) {
    const date = new Date(event.timestamp);
    const dayPeriod = date.toISOString().slice(0, 10);
    const weekPeriod = new Date(startOfUtcWeek(event.timestamp))
      .toISOString()
      .slice(0, 10);
    const monthPeriod = date.toISOString().slice(0, 7);
    const keys = [`day:${dayPeriod}`, `week:${weekPeriod}`, `month:${monthPeriod}`];
    const buckets = [
      dailyByPeriod.get(dayPeriod),
      weeklyByPeriod.get(weekPeriod),
      monthlyByPeriod.get(monthPeriod),
    ];
    eventCounts.set(event.type, (eventCounts.get(event.type) ?? 0) + 1);

    for (let index = 0; index < buckets.length; index += 1) {
      const bucket = buckets[index];
      const key = keys[index];
      if (!bucket || !key) continue;
      if (event.type === "page_view") {
        bucket.pageViews += 1;
        bucket.uniqueVisitors += addToSet(visitorSets, key, event.visitorHash);
        bucket.sessions += addToSet(sessionSets, key, event.sessionHash);
      } else {
        bucket.interactions += 1;
      }
    }

    if (event.type === "page_view") {
      totalPageViews += 1;
      totalVisitors.add(event.visitorHash);
      totalSessions.add(event.sessionHash);
      if (priorVisitors.has(event.visitorHash)) {
        returningVisitors.add(event.visitorHash);
      }
      pageViews.set(event.path, (pageViews.get(event.path) ?? 0) + 1);
      let pathVisitors = pageVisitors.get(event.path);
      if (!pathVisitors) {
        pathVisitors = new Set<string>();
        pageVisitors.set(event.path, pathVisitors);
      }
      pathVisitors.add(event.visitorHash);
    } else {
      totalInteractions += 1;
    }
  }

  const topPages = [...pageViews]
    .map(([path, count]) => ({
      path,
      pageViews: count,
      uniqueVisitors: pageVisitors.get(path)?.size ?? 0,
    }))
    .sort((left, right) => right.pageViews - left.pageViews || left.path.localeCompare(right.path))
    .slice(0, 10);
  const eventBreakdown = WEB_ANALYTICS_EVENT_TYPES.map((type) => ({
    type,
    count: eventCounts.get(type) ?? 0,
  })).filter((event) => event.count > 0);

  return {
    generatedAt: new Date(now).toISOString(),
    days: days as 7 | 30 | 90,
    retentionDays,
    timeZone: "UTC",
    totals: {
      pageViews: totalPageViews,
      uniqueVisitors: totalVisitors.size,
      newVisitors: Math.max(0, totalVisitors.size - returningVisitors.size),
      returningVisitors: returningVisitors.size,
      sessions: totalSessions.size,
      interactions: totalInteractions,
    },
    daily,
    weekly,
    monthly,
    topPages,
    eventBreakdown,
  };
}

function createBuckets(
  firstStart: number,
  lastStart: number,
  step: number,
  format: (start: number) => string,
): WebAnalyticsBucket[] {
  const buckets: WebAnalyticsBucket[] = [];
  for (let start = firstStart; start <= lastStart; start += step) {
    buckets.push(emptyBucket(format(start)));
  }
  return buckets;
}

function createMonthBuckets(
  firstMonthStart: number,
  lastMonthStart: number,
): WebAnalyticsBucket[] {
  const buckets: WebAnalyticsBucket[] = [];
  let year = new Date(firstMonthStart).getUTCFullYear();
  let month = new Date(firstMonthStart).getUTCMonth();
  const lastDate = new Date(lastMonthStart);
  while (
    year < lastDate.getUTCFullYear() ||
    (year === lastDate.getUTCFullYear() && month <= lastDate.getUTCMonth())
  ) {
    buckets.push(emptyBucket(`${year}-${String(month + 1).padStart(2, "0")}`));
    month += 1;
    if (month > 11) {
      month = 0;
      year += 1;
    }
  }
  return buckets;
}

function emptyBucket(period: string): WebAnalyticsBucket {
  return {
    period,
    pageViews: 0,
    uniqueVisitors: 0,
    sessions: 0,
    interactions: 0,
  };
}

function addToSet(
  sets: Map<string, Set<string>>,
  key: string,
  value: string,
): number {
  let values = sets.get(key);
  if (!values) {
    values = new Set<string>();
    sets.set(key, values);
  }
  if (values.has(value)) return 0;
  values.add(value);
  return 1;
}

function startOfUtcDay(timestamp: number): number {
  const date = new Date(timestamp);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}

function startOfUtcWeek(timestamp: number): number {
  const dayStart = startOfUtcDay(timestamp);
  const day = new Date(dayStart).getUTCDay();
  return dayStart - ((day + 6) % 7) * MILLISECONDS_PER_DAY;
}

function startOfUtcMonth(timestamp: number): number {
  const date = new Date(timestamp);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1);
}

function isWebAnalyticsEvent(value: unknown): value is WebAnalyticsEvent {
  if (typeof value !== "object" || value === null) return false;
  const event = value as Record<string, unknown>;
  return (
    typeof event.timestamp === "number" &&
    Number.isFinite(event.timestamp) &&
    event.timestamp >= 0 &&
    typeof event.visitorHash === "string" &&
    /^[a-f0-9]{64}$/.test(event.visitorHash) &&
    typeof event.sessionHash === "string" &&
    /^[a-f0-9]{64}$/.test(event.sessionHash) &&
    typeof event.type === "string" &&
    WEB_ANALYTICS_EVENT_TYPES.includes(event.type as WebAnalyticsEventType) &&
    typeof event.path === "string" &&
    event.path.length > 0 &&
    event.path.length <= 120 &&
    event.path.startsWith("/") &&
    !event.path.startsWith("//") &&
    /^\/[a-zA-Z0-9/_-]*$/.test(event.path)
  );
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
