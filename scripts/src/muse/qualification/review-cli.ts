import { QualificationReviewRepository } from "./qualification-review-repository.js";

async function main(): Promise<void> {
  const [command = "list", id, decision] = process.argv.slice(2).filter((arg) => arg !== "--");
  const path = process.env.MUSE_REVIEW_PATH ??
    "data/muse-qualification-review.json";
  const repository = new QualificationReviewRepository(path);

  if (command === "list") {
    const items = await repository.list("PENDING");
    if (items.length === 0) {
      console.log("No pending qualification reviews.");
      return;
    }

    for (const item of items) {
      console.log(`\n${item.id} | ${item.title}`);
      console.log(`Source: ${item.sourceUrl ?? "(no URL)"}`);
      console.log(`Reasons: ${item.reasons.join("; ")}`);
      console.log(`Evidence: ${item.evidence.join("; ") || "(none)"}`);
    }
    console.log(`\n${items.length} pending review(s).`);
    return;
  }

  if (command === "resolve" && id &&
      (decision === "approve" || decision === "reject")) {
    const resolved = await repository.resolve(
      id,
      decision === "approve" ? "APPROVED" : "REJECTED",
    );
    console.log(resolved ? `Marked ${id} ${decision}d.` :
      "Pending review not found; check its ID and status.");
    return;
  }

  throw new Error(
    'Use "list" or "resolve <ID> approve|reject".',
  );
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Review command failed.");
  process.exitCode = 1;
});
