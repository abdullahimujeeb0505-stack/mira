import type { OpportunityService } from "../opportunities/opportunity-service.js";
import type {
  NormalizedOpportunity,
  OpportunityType,
} from "../opportunities/opportunity-types.js";
import type {
  NewWatchRule,
  WatchEntityHints,
  WatchProcessingResult,
  WatchRule,
  WatchRuleChanges,
  WatchRuleRepository,
  WatchTargetType,
  WatchUpdate,
} from "./watch-types.js";

export class WatchService {
  private serialQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly repository: WatchRuleRepository,
    private readonly opportunityService: OpportunityService,
  ) {}

  listRules(): Promise<WatchRule[]> {
    return this.repository.list();
  }

  getRule(id: string): Promise<WatchRule | undefined> {
    return this.repository.get(id);
  }

  addRule(input: NewWatchRule): Promise<WatchRule> {
    return this.enqueue(() => this.repository.create(input));
  }

  updateRule(
    id: string,
    changes: WatchRuleChanges,
  ): Promise<WatchRule | undefined> {
    return this.enqueue(() => this.repository.update(id, changes));
  }

  enableRule(id: string): Promise<WatchRule | undefined> {
    return this.enqueue(() => this.repository.update(id, { enabled: true }));
  }

  disableRule(id: string): Promise<WatchRule | undefined> {
    return this.enqueue(() => this.repository.update(id, { enabled: false }));
  }

  removeRule(id: string): Promise<boolean> {
    return this.enqueue(() => this.repository.delete(id));
  }

  processUpdate(update: WatchUpdate): Promise<WatchProcessingResult> {
    return this.enqueue(async () => {
      const matchedRules = (await this.repository.list())
        .filter((rule) => rule.enabled && matchesRule(rule, update))
        .sort(
          (left, right) =>
            (right.priority ?? 0) - (left.priority ?? 0) ||
            left.id.localeCompare(right.id),
        );

      if (matchedRules.length === 0) {
        return { matchedRules: [], evaluation: null };
      }

      const priorities = matchedRules
        .map((rule) => rule.priority)
        .filter((priority): priority is number => priority !== undefined);
      const opportunity = addEntityHints(
        update.opportunity,
        update.entities,
      );
      const evaluation = await this.opportunityService.evaluate(opportunity);

      return {
        matchedRules,
        ...(priorities.length ? { effectivePriority: Math.max(...priorities) } : {}),
        evaluation,
      };
    });
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const pending = this.serialQueue.then(operation);
    this.serialQueue = pending.then(
      () => undefined,
      () => undefined,
    );
    return pending;
  }
}

function matchesRule(rule: WatchRule, update: WatchUpdate): boolean {
  const opportunity = update.opportunity;
  const text = updateText(opportunity, update.entities);
  if (rule.exclusions.some((term) => containsPhrase(text, term))) return false;
  if (!targetMatches(rule.targetType, rule.target, update)) return false;
  if (
    rule.sources.length > 0 &&
    !rule.sources.some((source) => sourceMatches(source, opportunity))
  ) {
    return false;
  }
  if (
    rule.keywords.length > 0 &&
    !rule.keywords.some((keyword) => containsPhrase(text, keyword))
  ) {
    return false;
  }
  if (
    rule.opportunityTypes.length > 0 &&
    !rule.opportunityTypes.includes(opportunity.opportunityType)
  ) {
    return false;
  }
  return true;
}

function targetMatches(
  type: WatchTargetType,
  target: string,
  update: WatchUpdate,
): boolean {
  const opportunity = update.opportunity;
  const entities = update.entities;
  const text = updateText(opportunity, entities);

  switch (type) {
    case "TRUSTED_ACCOUNT":
      return (
        hasExactValue(entities?.trustedAccounts, target) ||
        containsPhrase(text, target)
      );
    case "PROJECT":
      return (
        hasExactValue(entities?.projects, target) ||
        containsPhrase(text, target)
      );
    case "WEBSITE":
      return (
        (entities?.websites ?? []).some((site) => sameWebsite(target, site)) ||
        sameWebsite(target, opportunity.sourceUrl) ||
        sameWebsite(target, opportunity.source)
      );
    case "ANNOUNCEMENT_CHANNEL":
      return (
        hasExactValue(entities?.announcementChannels, target) ||
        sameText(target, opportunity.source) ||
        containsPhrase(text, target)
      );
    case "KEYWORD":
      return containsPhrase(text, target);
    case "OPPORTUNITY":
      return (
        (opportunity.id !== undefined && sameText(opportunity.id, target)) ||
        sameText(opportunity.title, target) ||
        sameUrl(opportunity.sourceUrl, target)
      );
  }
}

function sourceMatches(
  source: string,
  opportunity: NormalizedOpportunity,
): boolean {
  return (
    sameText(source, opportunity.source) ||
    sameUrl(opportunity.sourceUrl, source) ||
    sameWebsite(source, opportunity.sourceUrl)
  );
}

function updateText(
  opportunity: NormalizedOpportunity,
  entities?: WatchEntityHints,
): string {
  const characteristicText = Array.isArray(opportunity.characteristics)
    ? opportunity.characteristics.join(" ")
    : Object.entries(opportunity.characteristics)
        .flatMap(([key, value]) => [key, String(value)])
        .join(" ");
  return [
    opportunity.title,
    opportunity.description,
    opportunity.source,
    opportunity.sourceUrl ?? "",
    opportunity.opportunityType,
    characteristicText,
    ...opportunity.requirements,
    ...(entities?.trustedAccounts ?? []),
    ...(entities?.projects ?? []),
    ...(entities?.websites ?? []),
    ...(entities?.announcementChannels ?? []),
  ].join(" ");
}

function hasExactValue(values: string[] | undefined, target: string): boolean {
  return (values ?? []).some((value) => sameText(value, target));
}

function sameText(left: string, right: string): boolean {
  return normalizeMatchText(left) === normalizeMatchText(right);
}

function containsPhrase(text: string, phrase: string): boolean {
  const normalizedText = ` ${normalizeMatchText(text)} `;
  const normalizedPhrase = normalizeMatchText(phrase);
  return Boolean(normalizedPhrase) && normalizedText.includes(` ${normalizedPhrase} `);
}

function normalizeMatchText(value: string): string {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function sameUrl(left: string | null, right: string): boolean {
  const leftUrl = canonicalizeUrl(left);
  const rightUrl = canonicalizeUrl(right);
  return leftUrl !== undefined && leftUrl === rightUrl;
}

function canonicalizeUrl(value: string | null): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    url.hash = "";
    for (const key of [...url.searchParams.keys()]) {
      if (key.toLowerCase().startsWith("utm_")) url.searchParams.delete(key);
    }
    url.searchParams.sort();
    url.pathname = url.pathname.replace(/\/+$/, "") || "/";
    return url.toString();
  } catch {
    return undefined;
  }
}

function sameWebsite(left: string, right: string | null): boolean {
  if (!right) return false;
  const leftHost = hostname(left);
  const rightHost = hostname(right);
  if (!leftHost || !rightHost) return sameText(left, right);
  return (
    rightHost === leftHost ||
    rightHost.endsWith(`.${leftHost}`)
  );
}

function hostname(value: string): string | undefined {
  try {
    const candidate = value.includes("://") ? value : `https://${value}`;
    return new URL(candidate).hostname.toLocaleLowerCase().replace(/^www\./, "");
  } catch {
    return undefined;
  }
}

function addEntityHints(
  opportunity: NormalizedOpportunity,
  entities?: WatchEntityHints,
): NormalizedOpportunity {
  if (!entities) return opportunity;
  const hints = [
    ...(entities.trustedAccounts ?? []).map((value) => `trusted account ${value}`),
    ...(entities.projects ?? []).map((value) => `project ${value}`),
    ...(entities.websites ?? []).map((value) => `website ${value}`),
    ...(entities.announcementChannels ?? []).map(
      (value) => `announcement channel ${value}`,
    ),
  ].filter((value) => value.trim().length > 0);
  if (hints.length === 0) return opportunity;

  const characteristics = opportunity.characteristics;
  return {
    ...opportunity,
    characteristics: Array.isArray(characteristics)
      ? [...characteristics, ...hints]
      : {
          ...characteristics,
          watchEntityHints: hints.join("; "),
        },
  };
}
