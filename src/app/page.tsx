import LearnerWorkbench from "@/components/learner-workbench";
import { DEMO_QUESTIONS } from "@/lib/demo/lesson";
import { createServerContext } from "@/lib/server/context";
import type { CourseSummary } from "@/lib/contracts/question";

// The page reads server configuration on every request.
export const dynamic = "force-dynamic";

export default async function HomePage() {
  const { config, providers, storeResolution } = createServerContext();
  const store = storeResolution.store;

  let course: CourseSummary | null = null;
  let storeError: string | null = null;
  try {
    const courses = await store.listCourses();
    course = courses[0] ?? null;
    if (!course) {
      storeError = "No course is available from the configured evidence source.";
    }
  } catch {
    storeError =
      "The database-backed evidence store is configured but the query failed. The schema migration has probably not been applied yet.";
  }

  return (
    <LearnerWorkbench
      course={course}
      suggestedQuestions={[DEMO_QUESTIONS.canary, DEMO_QUESTIONS.courseWideControl]}
      runtimeAiConfigured={providers.configured}
      textModel={config.model}
      embeddingProvider={providers.embeddingProviderId}
      embeddingDimensions={config.embeddingDimensions}
      evidenceSource={store.mode}
      evidenceReason={storeResolution.reason}
      storeError={storeError}
    />
  );
}
