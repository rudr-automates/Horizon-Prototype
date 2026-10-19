import type { CourseSummary } from "@/lib/contracts/question";
import { buildLessonEntries, chooseContinueLesson } from "@/lib/presentation/continue-lesson";
import { personalStateFromRemote } from "@/lib/personal/remote-contract";

/** Build dashboard navigation and resume facts from the real catalogue and owner rows. */
export function learnerDashboardModel(
  courses: CourseSummary[],
  recordingCourseId: string | null,
  progressRows: unknown,
) {
  const state = personalStateFromRemote({ bookmarks: [], notes: [], progress: progressRows });
  const entries = buildLessonEntries(courses, recordingCourseId);
  return {
    entries,
    continueChoice: chooseContinueLesson(entries, state.progress),
    coursesWithProgress: Object.keys(state.progress).length,
  };
}
