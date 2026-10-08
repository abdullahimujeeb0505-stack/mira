export const LEARNING_CATEGORIES = [
  "SUCCESS_PATTERN",
  "FAILURE_PATTERN",
  "PREFERENCE",
  "OPPORTUNITY_PATTERN",
  "CONTENT_PATTERN",
  "STRATEGY",
] as const;

export type LearningCategory = (typeof LEARNING_CATEGORIES)[number];

export interface LearningRecord {
  id: string;
  category: LearningCategory;
  pattern: string;
  evidence: string;
  outcome: string;
  confidence: number;
  observations: number;
  createdAt: string;
  updatedAt: string;
}

export type NewLearningRecord = Omit<
  LearningRecord,
  "id" | "createdAt" | "updatedAt" | "observations"
> & {
  observations?: number;
};

export type LearningRecordUpdate = Partial<
  Pick<
    LearningRecord,
    | "category"
    | "pattern"
    | "evidence"
    | "outcome"
    | "confidence"
    | "observations"
  >
>;

export interface LearningRepository {
  list(category?: LearningCategory): Promise<LearningRecord[]>;
  get(id: string): Promise<LearningRecord | undefined>;
  create(record: NewLearningRecord): Promise<LearningRecord>;
  update(
    id: string,
    changes: LearningRecordUpdate,
  ): Promise<LearningRecord | undefined>;
  delete(id: string): Promise<boolean>;
}

export function isLearningCategory(value: string): value is LearningCategory {
  return LEARNING_CATEGORIES.includes(value.toUpperCase() as LearningCategory);
}

export function parseLearningCategory(
  value: string,
): LearningCategory | undefined {
  const normalized = value.trim().toUpperCase();
  return isLearningCategory(normalized) ? normalized : undefined;
}
