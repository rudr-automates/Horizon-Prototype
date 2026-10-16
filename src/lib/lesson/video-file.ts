/**
 * Server-side lookup of the local lesson recording.
 *
 * Split from `video.ts` on purpose: that module is imported by a client
 * component, and a client bundle cannot — and must not — reach the filesystem.
 * Only server code imports this file.
 *
 * The path is never taken from a request. It is the one file name this project
 * knows about, joined to the project root, so no learner input can name a path
 * and no absolute path is ever handed to a browser.
 */
import { statSync } from "node:fs";
import { join } from "node:path";
import {
  LESSON_VIDEO,
  type LessonVideoSource,
  type LocalVideoFile,
  resolveLessonVideoSource,
} from "@/lib/lesson/video";

/** The local file, or null when this deployment does not have it. */
export function findLocalLessonVideoFile(root: string = process.cwd()): LocalVideoFile | null {
  // `turbopackIgnore` is load-bearing, not decoration. Without it the bundler
  // takes this dynamic filesystem access as a signal to trace the WHOLE project
  // into the server bundle — which is exactly how a 235 MiB recording and every
  // source file would end up in a deploy artifact, the outcome this design is
  // built to avoid. The bundle must never contain the recording: it is read, if
  // present at all, from where the operator put it.
  const absolutePath = join(
    /* turbopackIgnore: true */ root,
    LESSON_VIDEO.localFileName,
  );
  try {
    const stats = statSync(absolutePath);
    if (!stats.isFile() || stats.size === 0) return null;
    return { fileName: LESSON_VIDEO.localFileName, bytes: stats.size, absolutePath };
  } catch {
    // Absent is the expected state on any host: the recording is 235 MiB and a
    // third-party download, so it is never part of a deploy artifact.
    return null;
  }
}

/**
 * Which player the page should render, decided from what is really on disk.
 *
 * Local file when the operator has it, the original YouTube embed otherwise. No
 * third state and no "probably works": the panel reports which of the two it is.
 */
export function resolveServerLessonVideoSource(
  root: string = process.cwd(),
): LessonVideoSource {
  return resolveLessonVideoSource(findLocalLessonVideoFile(root));
}
