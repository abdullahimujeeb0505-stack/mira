import type { WatchUpdate } from "../watch/watch-types.js";
import type {
  SourceConfiguration,
  SourceUpdate,
  SourceUpdateMapper,
} from "./source-types.js";

/**
 * Provider-neutral default conversion. More specific classification can be
 * supplied later through a separate SourceUpdateMapper implementation.
 */
export class DefaultSourceUpdateMapper implements SourceUpdateMapper {
  toWatchUpdate(
    update: SourceUpdate,
    source: SourceConfiguration,
  ): WatchUpdate {
    const characteristics: Record<string, string> = {
      sourceId: update.sourceId,
      sourceType: update.sourceType,
      sourceUpdateId: update.id,
      retrievedAt: update.retrievedAt,
    };
    if (update.publishedAt) characteristics.publishedAt = update.publishedAt;

    return {
      opportunity: {
        title: update.title,
        description: update.text,
        source: update.sourceType,
        sourceUrl: update.sourceUrl ?? source.sourceUrl,
        detectedAt: update.publishedAt ?? update.retrievedAt,
        deadline: null,
        opportunityType: source.defaultOpportunityType ?? "OTHER",
        characteristics,
        requirements: [],
      },
    };
  }
}
