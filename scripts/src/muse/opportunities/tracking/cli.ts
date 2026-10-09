import { JsonLearningRepository } from "../../learning/json-learning-repository.js";
import { LearningService } from "../../learning/learning-service.js";
import { JsonOpportunityRepository } from "../json-opportunity-repository.js";
import { JsonTrackingRepository } from "./json-tracking-repository.js";
import { OpportunityTrackingService } from "./tracking-service.js";
import {
  parseTrackingCategory,
  parseTrackingStatus,
  type TrackingEvidence,
  type TrackingOutcomeInput,
  type TrackingStatus,
  type TrackingStatusOptions,
  type WalletAddressReference,
} from "./tracking-types.js";

interface ParsedArguments {
  positionals: string[];
  flags: Map<string, string[]>;
}

async function main(): Promise<void> {
  const args = parseArguments(process.argv.slice(2).filter((arg) => arg !== "--"));
  const [command = "help", ...positionals] = args.positionals;
  const repository = new JsonTrackingRepository();
  const service = new OpportunityTrackingService(
    repository,
    new LearningService(new JsonLearningRepository()),
  );

  switch (command) {
    case "help":
      printHelp();
      return;
    case "add": {
      allowFlags(args, ["title", "category", "project", "description", "source-name", "source-url", "deadline", "launch-date", "expected-result-date", "wallet"]);
      const categoryText = requiredFlag(args, "category");
      const category = parseTrackingCategory(categoryText);
      if (!category) throw new Error("Unsupported category. Use one of the categories shown by help.");
      const result = await service.add({
        title: requiredFlag(args, "title"),
        category,
        project: optionalFlag(args, "project"),
        description: optionalFlag(args, "description"),
        sourceName: optionalFlag(args, "source-name"),
        sourceUrl: optionalFlag(args, "source-url") ?? null,
        deadline: optionalFlag(args, "deadline"),
        launchDate: optionalFlag(args, "launch-date"),
        expectedResultDate: optionalFlag(args, "expected-result-date"),
        walletAddressReferences: flagValues(args, "wallet").map(parseWalletReference),
      });
      console.log(`${result.created ? "Added" : "Already tracked"}: ${result.record.id}`);
      printRecord(result.record);
      return;
    }
    case "from-opportunity": {
      allowFlags(args, []);
      const id = requirePositionals(positionals, 1)[0];
      const discovered = await new JsonOpportunityRepository().get(id!);
      if (!discovered) throw new Error("Discovered opportunity was not found.");
      const result = await service.addFromOpportunity(discovered);
      console.log(`${result.created ? "Added" : "Already tracked"}: ${result.record.id}`);
      printRecord(result.record);
      return;
    }
    case "list": {
      allowFlags(args, ["status", "category"]);
      const statusText = optionalFlag(args, "status");
      const categoryText = optionalFlag(args, "category");
      const status = statusText ? parseTrackingStatus(statusText) : undefined;
      const category = categoryText ? parseTrackingCategory(categoryText) : undefined;
      if (statusText && !status) throw new Error("Unsupported status.");
      if (categoryText && !category) throw new Error("Unsupported category.");
      const records = await service.list({
        ...(status ? { status } : {}),
        ...(category ? { category } : {}),
      });
      printRecords(records);
      return;
    }
    case "view": {
      allowFlags(args, []);
      const id = requirePositionals(positionals, 1)[0]!;
      const record = await service.get(id);
      if (!record) throw new Error("Tracked opportunity was not found.");
      printRecord(record);
      return;
    }
    case "update": {
      allowFlags(args, ["title", "category", "project", "description", "source-name", "source-url", "application-date", "submission-date", "deadline", "launch-date", "expected-result-date", "notes", "next-action", "next-action-due", "wallet"]);
      const id = requirePositionals(positionals, 1)[0]!;
      const categoryText = optionalFlag(args, "category");
      const category = categoryText ? parseTrackingCategory(categoryText) : undefined;
      if (categoryText && !category) throw new Error("Unsupported category.");
      const changes = {
        ...(hasFlag(args, "title") ? { title: requiredFlag(args, "title") } : {}),
        ...(category ? { category } : {}),
        ...(hasFlag(args, "project") ? { project: clearableFlag(args, "project") } : {}),
        ...(hasFlag(args, "description") ? { description: clearableFlag(args, "description") } : {}),
        ...(hasFlag(args, "source-name") ? { sourceName: clearableFlag(args, "source-name") } : {}),
        ...(hasFlag(args, "source-url") ? { sourceUrl: clearableFlag(args, "source-url") } : {}),
        ...(hasFlag(args, "application-date") ? { applicationDate: clearableFlag(args, "application-date") } : {}),
        ...(hasFlag(args, "submission-date") ? { submissionDate: clearableFlag(args, "submission-date") } : {}),
        ...(hasFlag(args, "deadline") ? { deadline: clearableFlag(args, "deadline") } : {}),
        ...(hasFlag(args, "launch-date") ? { launchDate: clearableFlag(args, "launch-date") } : {}),
        ...(hasFlag(args, "expected-result-date") ? { expectedResultDate: clearableFlag(args, "expected-result-date") } : {}),
        ...(hasFlag(args, "notes") ? { notes: clearableFlag(args, "notes") } : {}),
        ...(hasFlag(args, "next-action") ? { nextAction: clearableFlag(args, "next-action") } : {}),
        ...(hasFlag(args, "next-action-due") ? { nextActionDueAt: clearableFlag(args, "next-action-due") } : {}),
        ...(hasFlag(args, "wallet") ? { walletAddressReferences: flagValues(args, "wallet").map(parseWalletReference) } : {}),
      };
      const updated = await service.update(id, changes);
      if (!updated) throw new Error("Tracked opportunity was not found.");
      printRecord(updated);
      return;
    }
    case "apply":
    case "submit": {
      allowFlags(args, ["at", "evidence", "evidence-url", "evidence-source"]);
      const id = requirePositionals(positionals, 1)[0]!;
      const evidence = optionalEvidence(args);
      const updated =
        command === "apply"
          ? await service.markApplied(id, optionalFlag(args, "at"), evidence)
          : await service.markSubmitted(id, optionalFlag(args, "at"), evidence);
      printRecord(updated);
      return;
    }
    case "eligibility": {
      allowFlags(args, ["evidence", "evidence-url", "evidence-source", "at"]);
      const [id, statusText] = requirePositionals(positionals, 2);
      const status = statusText!.toUpperCase();
      if (status !== "ELIGIBLE" && status !== "INELIGIBLE" && status !== "UNKNOWN") {
        throw new Error("Eligibility result must be ELIGIBLE, INELIGIBLE, or UNKNOWN.");
      }
      const updated = await service.recordEligibilityResult(
        id!,
        status,
        requiredEvidence(args),
        optionalFlag(args, "at"),
      );
      printRecord(updated);
      return;
    }
    case "result": {
      allowFlags(args, ["evidence", "evidence-url", "evidence-source", "at"]);
      const [id, resultText] = requirePositionals(positionals, 2);
      const result = resultText!.toUpperCase();
      if (!["WON", "LOST", "PENDING", "UNKNOWN"].includes(result)) {
        throw new Error("Competition result must be WON, LOST, PENDING, or UNKNOWN.");
      }
      const updated = await service.recordCompetitionResult(
        id!,
        result as "WON" | "LOST" | "PENDING" | "UNKNOWN",
        requiredEvidence(args),
        optionalFlag(args, "at"),
      );
      printRecord(updated);
      return;
    }
    case "outcome": {
      allowFlags(args, ["outcome", "description", "evidence", "evidence-url", "evidence-source", "at"]);
      const id = requirePositionals(positionals, 1)[0]!;
      const outcome = requiredFlag(args, "outcome").toLowerCase();
      if (!["success", "failure", "neutral", "unknown"].includes(outcome)) {
        throw new Error("Outcome must be success, failure, neutral, or unknown.");
      }
      const input: TrackingOutcomeInput = {
        outcome: outcome as TrackingOutcomeInput["outcome"],
        description: requiredFlag(args, "description"),
        evidence: requiredEvidence(args),
        occurredAt: optionalFlag(args, "at"),
      };
      printRecord(await service.recordOutcome(id, input));
      return;
    }
    case "status": {
      allowFlags(args, ["at", "evidence", "evidence-url", "evidence-source"]);
      const [id, statusText] = requirePositionals(positionals, 2);
      const status = parseTrackingStatus(statusText!);
      if (!status) throw new Error("Unsupported status.");
      const options = statusOptions(args);
      printRecord(await service.setStatus(id!, status, options));
      return;
    }
    case "note": {
      allowFlags(args, ["text"]);
      const id = requirePositionals(positionals, 1)[0]!;
      printRecord(await service.addNote(id, requiredFlag(args, "text")));
      return;
    }
    case "next-action": {
      allowFlags(args, ["text", "due"]);
      const id = requirePositionals(positionals, 1)[0]!;
      printRecord(
        await service.setNextAction(
          id,
          requiredFlag(args, "text"),
          optionalFlag(args, "due"),
        ),
      );
      return;
    }
    case "upcoming": {
      allowFlags(args, ["days"]);
      const days = Number(optionalFlag(args, "days") ?? 7);
      printRecords(await service.listUpcoming(days));
      return;
    }
    case "overdue": {
      allowFlags(args, []);
      printRecords(await service.listOverdue());
      return;
    }
    case "close":
    case "archive": {
      allowFlags(args, ["at", "evidence", "evidence-url", "evidence-source"]);
      const id = requirePositionals(positionals, 1)[0]!;
      const options = statusOptions(args);
      printRecord(
        command === "close"
          ? await service.close(id, options)
          : await service.archive(id, options),
      );
      return;
    }
    case "reopen": {
      allowFlags(args, ["status", "at", "evidence", "evidence-url", "evidence-source"]);
      const id = requirePositionals(positionals, 1)[0]!;
      const statusText = optionalFlag(args, "status");
      const status = statusText ? parseTrackingStatus(statusText) : "DISCOVERED";
      if (
        !status ||
        !["DISCOVERED", "INTERESTED", "APPLIED", "SUBMITTED", "PENDING"].includes(status)
      ) {
        throw new Error("Reopen status must be DISCOVERED, INTERESTED, APPLIED, SUBMITTED, or PENDING.");
      }
      printRecord(await service.reopen(id, status as "DISCOVERED" | "INTERESTED" | "APPLIED" | "SUBMITTED" | "PENDING", statusOptions(args)));
      return;
    }
    case "delete": {
      allowFlags(args, ["confirm"]);
      const id = requirePositionals(positionals, 1)[0]!;
      if (!hasFlag(args, "confirm")) {
        throw new Error("Deleting a tracked record is permanent. Repeat with --confirm.");
      }
      const deleted = await service.delete(id);
      console.log(deleted ? "Tracked opportunity deleted." : "Tracked opportunity was not found.");
      return;
    }
    default:
      throw new Error('Unknown Muse tracking command. Run "muse-tracking help".');
  }
}

function parseArguments(args: string[]): ParsedArguments {
  const positionals: string[] = [];
  const flags = new Map<string, string[]>();
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    if (!argument.startsWith("--")) {
      positionals.push(argument);
      continue;
    }
    const equalsIndex = argument.indexOf("=");
    const key = (equalsIndex >= 0 ? argument.slice(2, equalsIndex) : argument.slice(2)).toLowerCase();
    const inlineValue = equalsIndex >= 0 ? argument.slice(equalsIndex + 1) : undefined;
    const next = args[index + 1];
    const value =
      inlineValue ??
      (next !== undefined && !next.startsWith("--")
        ? args[++index]
        : "true");
    const values = flags.get(key) ?? [];
    values.push(value ?? "");
    flags.set(key, values);
  }
  return { positionals, flags };
}

function allowFlags(args: ParsedArguments, allowed: string[]): void {
  const allowedSet = new Set(allowed);
  for (const key of args.flags.keys()) {
    if (!allowedSet.has(key)) throw new Error(`Unknown option --${key}.`);
  }
}

function hasFlag(args: ParsedArguments, name: string): boolean {
  return args.flags.has(name);
}

function flagValues(args: ParsedArguments, name: string): string[] {
  return args.flags.get(name) ?? [];
}

function optionalFlag(args: ParsedArguments, name: string): string | undefined {
  return args.flags.get(name)?.at(-1);
}

function requiredFlag(args: ParsedArguments, name: string): string {
  const value = optionalFlag(args, name);
  if (!value || value === "true") throw new Error(`Option --${name} is required.`);
  return value;
}

function clearableFlag(args: ParsedArguments, name: string): string | null {
  const value = requiredFlag(args, name);
  return value.toLowerCase() === "clear" || value.toLowerCase() === "none"
    ? null
    : value;
}

function requirePositionals(values: string[], count: number): string[] {
  if (values.length !== count) {
    throw new Error(`Expected ${count} positional argument${count === 1 ? "" : "s"}.`);
  }
  return values;
}

function parseWalletReference(value: string): WalletAddressReference {
  const firstColon = value.indexOf(":");
  if (firstColon <= 0) {
    throw new Error("Wallet reference format is chain:public-address[:label].");
  }
  const chain = value.slice(0, firstColon);
  const rest = value.slice(firstColon + 1);
  const secondColon = rest.indexOf(":");
  return secondColon < 0
    ? { chain, address: rest }
    : {
        chain,
        address: rest.slice(0, secondColon),
        label: rest.slice(secondColon + 1),
      };
}

function optionalEvidence(args: ParsedArguments): TrackingEvidence[] {
  if (
    !hasFlag(args, "evidence") &&
    !hasFlag(args, "evidence-url") &&
    !hasFlag(args, "evidence-source")
  ) {
    return [];
  }
  return [evidenceFromFlags(args)];
}

function requiredEvidence(args: ParsedArguments): TrackingEvidence[] {
  return [evidenceFromFlags(args)];
}

function evidenceFromFlags(args: ParsedArguments): TrackingEvidence {
  const description = optionalFlag(args, "evidence");
  const url = optionalFlag(args, "evidence-url");
  const source = optionalFlag(args, "evidence-source");
  if (!description && !url) {
    throw new Error("Provide --evidence or --evidence-url.");
  }
  return {
    ...(description ? { description } : {}),
    ...(url ? { url } : {}),
    ...(source ? { source } : {}),
    ...(optionalFlag(args, "at")
      ? { observedAt: optionalFlag(args, "at") }
      : {}),
  };
}

function statusOptions(args: ParsedArguments): TrackingStatusOptions {
  return {
    ...(optionalFlag(args, "at") ? { at: optionalFlag(args, "at") } : {}),
    evidence: optionalEvidence(args),
  };
}

function printRecords(records: unknown[]): void {
  if (records.length === 0) {
    console.log("No tracked opportunities.");
    return;
  }
  for (const record of records) printRecord(record);
}

function printRecord(record: unknown): void {
  console.log(JSON.stringify(record, null, 2));
}

function printHelp(): void {
  console.log(
    [
      "Muse opportunity tracking commands:",
      "  add --title TEXT --category CATEGORY [--project TEXT] [--source-url URL] [--deadline DATE] [--wallet chain:public-address[:label]]",
      "  from-opportunity <discovered-id>",
      "  list [--status STATUS] [--category CATEGORY]",
      "  view <id>",
      "  update <id> [--deadline DATE|clear] [--launch-date DATE|clear] [--expected-result-date DATE|clear] [other editable flags]",
      "  apply <id> [--at DATE] [--evidence TEXT] [--evidence-url URL]",
      "  submit <id> [--at DATE] [--evidence TEXT] [--evidence-url URL]",
      "  eligibility <id> ELIGIBLE|INELIGIBLE|UNKNOWN --evidence TEXT|--evidence-url URL",
      "  result <id> WON|LOST|PENDING|UNKNOWN --evidence TEXT|--evidence-url URL",
      "  outcome <id> --outcome success|failure|neutral|unknown --description TEXT --evidence TEXT|--evidence-url URL",
      "  status <id> STATUS [--evidence TEXT] [--evidence-url URL]",
      "  note <id> --text TEXT",
      "  next-action <id> --text TEXT [--due DATE]",
      "  upcoming [--days 7] | overdue",
      "  close <id> | archive <id> | reopen <id> [--status DISCOVERED]",
      "  delete <id> --confirm",
      `  Categories: ${[
        "WL_APPLICATION", "AIRDROP", "CAMPAIGN", "QUEST", "COMPETITION",
        "GRANT", "CONTENT", "PUBLIC_MINT", "PRODUCT_LAUNCH", "OTHER",
      ].join(", ")}`,
      `  Statuses: ${([
        "DISCOVERED", "INTERESTED", "APPLIED", "SUBMITTED", "PENDING",
        "CHECKER_ANNOUNCED", "ELIGIBLE", "INELIGIBLE", "WON", "LOST",
        "COMPLETED", "EXPIRED", "UNKNOWN", "CLOSED", "ARCHIVED",
      ] satisfies TrackingStatus[]).join(", ")}`,
    ].join("\n"),
  );
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Muse tracking command failed.");
  process.exitCode = 1;
});
