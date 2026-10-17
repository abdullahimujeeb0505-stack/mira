
import { createTextGenerationProvider } from "../provider-selection.js";
import { QuotePostDraftService } from "./quote-post-drafts.js";
import { JsonOpportunityRepository } from "../opportunities/json-opportunity-repository.js";

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv[0] === "--") argv.shift();
  const [command = "help", ...args] = argv;
  const service = new QuotePostDraftService({
    generateText: (request) =>
      createTextGenerationProvider().generateText(request),
  });

  if (command === "from-opportunity") {
    const id = args[0];

    if (!id) {
      throw new Error(
        "Usage: muse-drafts from-opportunity OPPORTUNITY_ID",
      );
    }

    const opportunity = await new JsonOpportunityRepository().get(id);

    if (!opportunity) {
      throw new Error(`Opportunity "${id}" was not found.`);
    }

    if (!opportunity.sourceUrl) {
      throw new Error(
        "This opportunity has no source URL. Add a valid source before drafting.",
      );
    }

    let sourceUrl: URL;
    try {
      sourceUrl = new URL(opportunity.sourceUrl);
    } catch {
      throw new Error("The opportunity source URL is invalid.");
    }

    if (sourceUrl.protocol !== "https:") {
      throw new Error(
        "Draft generation requires an HTTPS source URL.",
      );
    }

    const descriptionLimit = 7000;
    const description = opportunity.description.slice(0, descriptionLimit);
    const sourceEvidence = [
      `Opportunity title: ${opportunity.title}`,
      `Opportunity type: ${opportunity.opportunityType}`,
      `Description: ${description}${opportunity.description.length > descriptionLimit ? " [description truncated]" : ""}`,
      `Source: ${opportunity.source}`,
      `Requirements: ${opportunity.requirements.join("; ").slice(0, 2000) || "Not specified"}`,
      `Deadline: ${opportunity.deadline ?? "Not specified"}`,
      "This is opportunity evidence, not necessarily a verbatim social post.",
      "Do not invent eligibility, rewards, deadlines, or personal experience.",
    ].join("\\n").slice(0, 10000);

    const draft = await service.create(
      sourceUrl.toString(),
      sourceEvidence,
    );

    console.log(`Saved pending draft: ${draft.id}`);
    console.log(`Opportunity: ${opportunity.title}`);
    console.log(`Source: ${draft.sourceUrl}`);
    console.log(
      `Draft (${draft.draftText.length}/280): ${draft.draftText}`,
    );
    console.log("Status: PENDING — nothing was posted to X.");
    return;
  }

  if (command === "create") {
    const [url, ...textParts] = args;

    if (!url || textParts.length === 0) {
      throw new Error(
        'Usage: pnpm --filter @workspace/scripts run muse-drafts -- create "POST_URL" "ORIGINAL POST TEXT"',
      );
    }

    const draft = await service.create(url, textParts.join(" "));

    console.log(`Saved pending draft: ${draft.id}`);
    console.log(`Source: ${draft.sourceUrl}`);
    console.log(
      `Draft (${draft.draftText.length}/280): ${draft.draftText}`,
    );
    console.log("Status: PENDING — nothing was posted to X.");
    return;
  }

  if (command === "list") {
    const drafts = await service.list();

    if (!drafts.length) {
      console.log("No saved quote-post drafts.");
      return;
    }

    for (const draft of drafts) {
      console.log(`\n${draft.id} [${draft.status}]`);
      console.log(`Source: ${draft.sourceUrl}`);
      console.log(draft.draftText);
    }
    return;
  }

  if (command === "approve" || command === "reject") {
    const id = args[0];

    if (!id) {
      throw new Error(`Usage: muse-drafts ${command} DRAFT_ID`);
    }

    const draft = await service.updateStatus(
      id,
      command === "approve" ? "APPROVED" : "REJECTED",
    );

    console.log(
      `Draft ${draft.id}: ${draft.status}. No post was published.`,
    );
    return;
  }

  console.log(
    [
      "Muse quote-post drafts",
      '  create "POST_URL" "SOURCE TEXT"',
      "  from-opportunity OPPORTUNITY_ID",
      "  list",
      "  approve DRAFT_ID",
      "  reject DRAFT_ID",
    ].join("\n"),
  );
}

main().catch((error: unknown) => {
  console.error(
    error instanceof Error ? error.message : "Draft command failed.",
  );
  process.exitCode = 1;
});
