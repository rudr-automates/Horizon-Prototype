import LearnerWorkbench from "@/components/learner-workbench";
import { describeConfigurationProblems } from "@/lib/config";
import { createServerContext } from "@/lib/server/context";
import { resolveServerLessonVideoSource } from "@/lib/lesson/video-file";
import { lessonTranscriptCourseId } from "@/lib/ingest/lesson-transcript";
import { DEMO_QUESTIONS } from "@/lib/demo/lesson";
import type { CourseSummary } from "@/lib/contracts/question";

// The page reads server configuration on every request.
export const dynamic = "force-dynamic";

export default async function HomePage() {
  const { config, providers, storeResolution } = createServerContext();
  const store = storeResolution.store;

  /**
   * Two courses, deliberately separate.
   *
   * The video's transcript course is identified by the id its ingest command
   * derives from the video's own id, so the primary lesson is chosen by fact
   * rather than by "whichever row came back first" — which is what used to select
   * the synthetic sample on a database-backed deployment.
   *
   * The sample is whatever else is there. It is passed separately, not merged, so
   * the interface can label it as synthetic on its own terms.
   */
  const lessonCourseId = lessonTranscriptCourseId();
  let videoCourse: CourseSummary | null = null;
  let sampleCourse: CourseSummary | null = null;
  let storeError: string | null = null;

  try {
    const courses = await store.listCourses();
    videoCourse = courses.find((course) => course.courseId === lessonCourseId) ?? null;

    const others = courses.filter((course) => course.courseId !== lessonCourseId);
    sampleCourse =
      others.find((course) => course.demoContent) ?? others[0] ?? null;

    if (!videoCourse && !sampleCourse) {
      storeError = "No course is available from the configured evidence source.";
    }
  } catch {
    storeError =
      "The database-backed evidence store is configured but the query failed. The schema migration has probably not been applied yet.";
  }

  return (
    <LearnerWorkbench
      videoCourse={videoCourse}
      sampleCourse={sampleCourse}
      // Resolved from the filesystem on every request, so the panel states the
      // source this deployment can really play rather than the one we hoped for.
      lessonVideo={resolveServerLessonVideoSource()}
      // The sample fixture's own suggested questions. The recording's are
      // declared with the video itself, because each is pinned to a passage the
      // ingested transcript actually contains.
      suggestedQuestions={[DEMO_QUESTIONS.canary, DEMO_QUESTIONS.courseWideControl]}
      runtimeAiConfigured={providers.configured}
      provider={config.provider}
      textModel={config.model}
      embeddingProvider={providers.embeddingProviderId}
      embeddingCredentialPresent={providers.embeddingConfigured}
      // Reported rather than left to be inferred from a refusal: a wrong
      // provider name and a credential in the wrong variable both look like an
      // outage on screen. Contains settings names only, never values.
      configurationProblems={describeConfigurationProblems(config)}
      evidenceSource={store.mode}
      evidenceReason={storeResolution.reason}
      storeError={storeError}
    />
  );
}
