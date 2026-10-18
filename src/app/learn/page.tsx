import LearningStudio from "@/components/learning-studio";
import { describeConfigurationProblems } from "@/lib/config";
import { toPublicHealth } from "@/lib/health/public";
import { buildHealthReport } from "@/lib/health/report";
import { createServerContext } from "@/lib/server/context";
import { resolveServerLessonVideoSource } from "@/lib/lesson/video-file";
import { lessonTranscriptCourseId } from "@/lib/ingest/lesson-transcript";
import { DEMO_QUESTIONS } from "@/lib/demo/lesson";
import type { CourseSummary } from "@/lib/contracts/question";

// The page reads server configuration on every request.
export const dynamic = "force-dynamic";

/**
 * The learning studio.
 *
 * MOVED FROM `/` TO `/learn`
 *   The root route is the product's welcome page now, so the studio lives here and
 *   the shell always has a way back to the lessons index. Nothing else changed in
 *   how the lesson is resolved: the recording is still identified by the id its own
 *   ingest command derives from the video id, and the sample is whatever else the
 *   store returned.
 *
 * WHY THE QUERY PARAMETERS EXIST
 *   `?lesson=` opens the lesson a link meant, `?section=` opens one of the five
 *   surfaces, and `?start=` resumes a real saved position. All three are read on
 *   the server, so a shared link opens the right thing on the first paint and the
 *   browser's own back and forward buttons behave.
 */
export default async function LearnPage({
  searchParams,
}: {
  searchParams: Promise<{ lesson?: string; section?: string; start?: string }>;
}) {
  const { config, providers, storeResolution } = createServerContext();
  const store = storeResolution.store;
  const params = await searchParams;

  // The Status surface gets the PUBLIC projection, not the operator report.
  //
  // Passing the full report here put the day's spend, the budget, the model ids,
  // the schema counts and the configuration problems into the page's serialized
  // props — a page prop is as public as an endpoint. The report is built on the
  // server, reduced by the same function the public health endpoint uses, and
  // only that result crosses to the client. A failed report is `null`, and the
  // panel says it could not be built rather than showing zeros.
  const health = await buildHealthReport()
    .then((report) => toPublicHealth(report))
    .catch(() => null);

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
    sampleCourse = others.find((course) => course.demoContent) ?? others[0] ?? null;

    if (!videoCourse && !sampleCourse) {
      storeError = "No course is available from the configured evidence source.";
    }
  } catch {
    storeError =
      "The database-backed evidence store is configured but the query failed. The schema migration has probably not been applied yet.";
  }

  // A requested lesson is honoured only when it exists; otherwise the page falls
  // back to what it can actually open rather than rendering an empty studio.
  const requestedLesson = params.lesson === "sample" ? "fixture" : params.lesson === "recording" ? "video" : null;
  const initialLesson =
    requestedLesson === "fixture" && sampleCourse
      ? "fixture"
      : requestedLesson === "video" && videoCourse
        ? "video"
        : videoCourse
          ? "video"
          : "fixture";

  const requestedSection = params.section;
  const initialSection =
    requestedSection === "materials" ||
    requestedSection === "notes" ||
    requestedSection === "progress" ||
    requestedSection === "status" ||
    requestedSection === "learn"
      ? requestedSection
      : "learn";

  const requestedStart = Number.parseInt(params.start ?? "", 10);
  const initialSeconds = Number.isFinite(requestedStart) && requestedStart > 0 ? requestedStart : 0;

  return (
    <LearningStudio
      videoCourse={videoCourse}
      sampleCourse={sampleCourse}
      initialLesson={initialLesson}
      initialSection={initialSection}
      initialSeconds={initialSeconds}
      health={health}
      // Resolved from the filesystem on every request, so the panel states the
      // source this deployment can really play rather than the one we hoped for.
      lessonVideo={resolveServerLessonVideoSource()}
      // The sample fixture's own suggested questions. The recording's are
      // declared with the video itself, because each is pinned to a passage the
      // ingested transcript actually contains.
      suggestedQuestions={[DEMO_QUESTIONS.canary, DEMO_QUESTIONS.courseWideControl]}
      runtimeAiConfigured={providers.configured}
      embeddingCredentialPresent={providers.embeddingConfigured}
      // Reported rather than left to be inferred from a refusal. Only the COUNT
      // crosses to the client: the setting names stay in the operator report, so
      // they are not serialized into the page's props.
      configurationProblemCount={describeConfigurationProblems(config).length}
      evidenceSource={store.mode}
      evidenceReason={storeResolution.reason}
      storeError={storeError}
    />
  );
}
