import { canonicalSourceUrl } from "./canonical-source-url.js";
import { randomUUID } from "node:crypto";
import { QualificationReviewRepository } from "../qualification/qualification-review-repository.js";
import { JsonOpportunityRepository } from "../opportunities/json-opportunity-repository.js";
import { JsonTrackingRepository } from "../opportunities/tracking/json-tracking-repository.js";
import { OpportunityTrackingService } from "../opportunities/tracking/tracking-service.js";
import { JsonLearningRepository } from "../learning/json-learning-repository.js";
import { LearningService } from "../learning/learning-service.js";
import type { Opportunity } from "../opportunities/opportunity-types.js";
import { inferOpportunityType } from "./opportunity-type-inference.js";

const reviewPath =
  process.env.MUSE_REVIEW_PATH ??
  "data/muse-qualification-review.json";

function safeHttpUrl(value: string | null): value is string {
  if (!value) return false;

  try {
    const url = new URL(value);
    return (
      (url.protocol === "https:" || url.protocol === "http:") &&
      !url.username &&
      !url.password
    );
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  const reviews = new QualificationReviewRepository(reviewPath);
  const approved = await reviews.list("APPROVED");
  const opportunities = new JsonOpportunityRepository();
  const tracking = new OpportunityTrackingService(
    new JsonTrackingRepository(),
    new LearningService(new JsonLearningRepository()),
  );

  if (approved.length === 0) {
    console.log("No approved review records to import.");
    return;
  }

  let imported = 0;
  let alreadyPresent = 0;
  let skipped = 0;

  for (const review of approved) {
    if (!safeHttpUrl(review.sourceUrl)) {
      console.log(`SKIPPED: ${review.title} — missing or invalid HTTP(S) source URL.`);
      skipped++;
      continue;
    }

    const reviewUrl = canonicalSourceUrl(review.sourceUrl);
    const existing = reviewUrl
      ? (await opportunities.list()).find(
          (item) => item.sourceUrl !== null && canonicalSourceUrl(item.sourceUrl) === reviewUrl,
        )
      : undefined;

    if (existing) {
      const result = await tracking.addFromOpportunity(existing);
      console.log(
        `${result.created ? "TRACKED" : "ALREADY TRACKED"}: ${existing.title}`,
      );
      alreadyPresent++;
      continue;
    }

    const opportunity: Opportunity = {
      id: randomUUID(),
      title: review.title.trim(),
      description: review.description.trim(),
      source: "Approved web discovery — source not independently verified",
      sourceUrl: review.sourceUrl,
      detectedAt: review.detectedAt,
      deadline: null,
      opportunityType: inferOpportunityType(review.title, review.description),
      characteristics: {
        reviewId: review.id,
        reviewStatus: "APPROVED",
        verificationStatus: "NOT_VERIFIED",
      },
      requirements: [],
      status: "SAVED",
    };

    await opportunities.create(opportunity);
    const tracked = await tracking.addFromOpportunity(opportunity);

    console.log(
      `${tracked.created ? "IMPORTED" : "SAVED; ALREADY TRACKED"}: ${opportunity.title}`,
    );
    console.log(`  Opportunity ID: ${opportunity.id}`);
    console.log(`  Tracking ID: ${tracked.record.id}`);
    console.log(`  Source: ${opportunity.sourceUrl}`);

    imported++;
  }

  console.log(
    `\nImport finished: imported=${imported}, already_present=${alreadyPresent}, skipped=${skipped}`,
  );
  console.log("Reminder: approved does not mean independently verified.");
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Import failed.");
  process.exitCode = 1;
});
