/**
 * Author a study guide (PDF) and a slide deck (PPTX) from the lesson's own
 * transcript, so the document-ingestion path has a real source to ingest.
 *
 *   pnpm build:materials                 # writes .freebuff/materials/*
 *   pnpm build:materials --segments 6    # fewer, longer sections
 *
 * WHAT THESE FILES ARE, AND ARE NOT
 *   They are compiled from the stored automatic English captions of the
 *   recording. Every quoted line is a transcript block, verbatim. They are NOT
 *   the instructor's own slides or notes, and they are labelled as team-authored
 *   in both documents and in the database row the ingest writes.
 *
 *   The generated files are written under `.freebuff/`, which is gitignored: the
 *   text is a third-party caption track, and this repository does not commit it.
 *
 * NO MODEL CALL. This is deterministic assembly of stored text, so it spends
 * nothing and cannot invent a sentence.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import PptxGenJS from "pptxgenjs";
import { loadEnvFile, presentNames } from "./env-file";

const REQUIRED_DB_NAMES = [
  "NEXT_PUBLIC_SUPABASE_URL",
  "NEXT_PUBLIC_SUPABASE_ANON_KEY",
  "SUPABASE_SERVICE_ROLE_KEY",
];

function argValue(name: string): string | null {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : null;
}

function clock(totalSeconds: number): string {
  const safe = Math.max(0, Math.floor(totalSeconds));
  return `${String(Math.floor(safe / 60)).padStart(2, "0")}:${String(safe % 60).padStart(2, "0")}`;
}

interface Segment {
  index: number;
  startSeconds: number;
  endSeconds: number;
  /** Verbatim transcript blocks, in order. */
  lines: string[];
}

async function main(): Promise<void> {
  loadEnvFile();
  const db = presentNames(REQUIRED_DB_NAMES);
  if (db.missing.length > 0) {
    console.error(`Not set: ${db.missing.join(", ")}. The transcript has to be read from the database.`);
    process.exitCode = 1;
    return;
  }

  const { readServerEnv } = await import("@/lib/env");
  const { createServiceRoleClient } = await import("@/lib/db/server");
  const { lessonTranscriptCourseId } = await import("@/lib/ingest/lesson-transcript");
  const { LESSON_VIDEO } = await import("@/lib/lesson/video");

  const client = createServiceRoleClient(readServerEnv());
  if (!client) {
    console.error("A Supabase service-role client could not be created.");
    process.exitCode = 1;
    return;
  }

  const courseId = argValue("course") ?? lessonTranscriptCourseId();
  const { data, error } = await client
    .from("blocks")
    .select("text_normalized, start_seconds, end_seconds, ordinal, block_type")
    .eq("course_id", courseId)
    .eq("block_type", "transcript")
    .order("ordinal", { ascending: true });

  if (error) {
    console.error(`The transcript could not be read: ${error.message}`);
    process.exitCode = 1;
    return;
  }

  const blocks = ((data ?? []) as Array<Record<string, unknown>>).map((row) => ({
    text: String(row.text_normalized ?? "").trim(),
    startSeconds: Number(row.start_seconds ?? 0),
    endSeconds: Number(row.end_seconds ?? 0),
  }));
  if (blocks.length === 0) {
    console.error(
      `Course ${courseId} has no transcript blocks. Run \`pnpm ingest:lesson\` first — these materials are compiled from it, not written by hand.`,
    );
    process.exitCode = 1;
    return;
  }

  const segmentCount = Math.max(
    2,
    Math.min(12, Number(argValue("segments") ?? 8)),
  );
  const perSegment = Math.ceil(blocks.length / segmentCount);
  const segments: Segment[] = [];
  for (let index = 0; index < segmentCount; index += 1) {
    const slice = blocks.slice(index * perSegment, (index + 1) * perSegment);
    if (slice.length === 0) continue;
    segments.push({
      index: segments.length + 1,
      startSeconds: slice[0].startSeconds,
      endSeconds: slice[slice.length - 1].endSeconds,
      lines: slice.map((block) => block.text),
    });
  }

  const outDir = resolve(process.cwd(), ".freebuff/materials");
  mkdirSync(outDir, { recursive: true });

  const provenance =
    `Compiled by the Horizon team from the recording's automatic English captions ` +
    `(https://youtu.be/${LESSON_VIDEO.youtubeId}). The quoted text is machine transcription, ` +
    `not an edited transcript, and this is not the instructor's own material.`;

  /* ---------------------------- PDF ---------------------------- */
  const pdf = await PDFDocument.create();
  pdf.setTitle(`Lesson study guide — ${LESSON_VIDEO.title}`);
  pdf.setSubject("Study guide compiled from the recording's automatic captions");
  pdf.setProducer("Horizon");
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const margin = 56;
  const pageWidth = 595.28;
  const pageHeight = 841.89;
  const maxWidth = pageWidth - margin * 2;

  function wrap(text: string, size: number, useBold = false): string[] {
    const face = useBold ? bold : font;
    const words = text.split(/\s+/).filter(Boolean);
    const lines: string[] = [];
    let line = "";
    for (const word of words) {
      const candidate = line === "" ? word : `${line} ${word}`;
      if (face.widthOfTextAtSize(candidate, size) > maxWidth) {
        if (line !== "") lines.push(line);
        line = word;
      } else {
        line = candidate;
      }
    }
    if (line !== "") lines.push(line);
    return lines;
  }

  let page = pdf.addPage([pageWidth, pageHeight]);
  let cursorY = pageHeight - margin;

  page.drawText("Lesson study guide", { x: margin, y: cursorY, size: 20, font: bold, color: rgb(0.1, 0.12, 0.2) });
  cursorY -= 26;
  for (const line of wrap(LESSON_VIDEO.title, 12)) {
    page.drawText(line, { x: margin, y: cursorY, size: 12, font, color: rgb(0.2, 0.22, 0.3) });
    cursorY -= 16;
  }
  cursorY -= 6;
  for (const line of wrap(provenance, 9)) {
    page.drawText(line, { x: margin, y: cursorY, size: 9, font, color: rgb(0.4, 0.42, 0.5) });
    cursorY -= 12;
  }
  cursorY -= 14;

  for (const segment of segments) {
    if (cursorY < margin + 120) {
      page = pdf.addPage([pageWidth, pageHeight]);
      cursorY = pageHeight - margin;
    }
    const heading = `Segment ${segment.index} — ${clock(segment.startSeconds)} to ${clock(segment.endSeconds)}`;
    page.drawText(heading, { x: margin, y: cursorY, size: 13, font: bold, color: rgb(0.1, 0.12, 0.2) });
    cursorY -= 20;

    // Two verbatim excerpts per segment: the opening statement and one later
    // line, so the page is a study guide rather than a transcript dump.
    const picks = [segment.lines[0], segment.lines[Math.floor(segment.lines.length / 2)]].filter(
      (line): line is string => Boolean(line),
    );
    for (const pick of picks) {
      const excerpt = pick.length > 420 ? `${pick.slice(0, 420)}…` : pick;
      page.drawText("“", { x: margin, y: cursorY, size: 11, font: bold, color: rgb(0.3, 0.35, 0.55) });
      for (const line of wrap(excerpt, 10.5)) {
        if (cursorY < margin + 30) {
          page = pdf.addPage([pageWidth, pageHeight]);
          cursorY = pageHeight - margin;
        }
        page.drawText(line, { x: margin + 10, y: cursorY, size: 10.5, font, color: rgb(0.15, 0.17, 0.24) });
        cursorY -= 15;
      }
      cursorY -= 8;
    }
    cursorY -= 6;
  }

  const pdfPath = resolve(outDir, "lesson-notes.pdf");
  writeFileSync(pdfPath, await pdf.save());

  /* ---------------------------- PPTX ---------------------------- */
  const deck = new PptxGenJS();
  deck.layout = "LAYOUT_WIDE";
  deck.title = `Lesson slides — ${LESSON_VIDEO.title}`;

  const titleSlide = deck.addSlide();
  titleSlide.background = { color: "0B1220" };
  titleSlide.addText("Lesson study slides", {
    x: 0.6, y: 1.4, w: 12, h: 0.7, fontSize: 34, bold: true, color: "E8EDF7",
  });
  titleSlide.addText(LESSON_VIDEO.title, {
    x: 0.6, y: 2.2, w: 12, h: 0.9, fontSize: 18, color: "9FB0CC",
  });
  titleSlide.addText(provenance, {
    x: 0.6, y: 3.4, w: 12, h: 1.4, fontSize: 11, color: "7C8CA8",
  });

  for (const segment of segments) {
    const slide = deck.addSlide();
    slide.background = { color: "0B1220" };
    slide.addText(
      `Segment ${segment.index} · ${clock(segment.startSeconds)}–${clock(segment.endSeconds)}`,
      { x: 0.6, y: 0.45, w: 12, h: 0.5, fontSize: 22, bold: true, color: "E8EDF7" },
    );

    const bullets = segment.lines
      .filter((line) => line.length > 40)
      .slice(0, 4)
      .map((line) => ({ text: line.length > 190 ? `${line.slice(0, 190)}…` : line, options: { bullet: true } }));

    slide.addText(bullets.length > 0 ? bullets : [{ text: segment.lines[0] ?? "", options: { bullet: true } }], {
      x: 0.7, y: 1.2, w: 11.8, h: 4.6, fontSize: 14, color: "C9D6EA", lineSpacingMultiple: 1.2,
    });
    slide.addText(`Verbatim from the automatic captions at ${clock(segment.startSeconds)}`, {
      x: 0.7, y: 6.3, w: 11.8, h: 0.4, fontSize: 9, color: "64748B",
    });
  }

  const pptxPath = resolve(outDir, "lesson-slides.pptx");
  const pptxBuffer = (await deck.write({ outputType: "nodebuffer" })) as Buffer;
  writeFileSync(pptxPath, pptxBuffer);

  /* --------------------------- Report --------------------------- */
  console.log(`Transcript blocks read : ${blocks.length} (course ${courseId})`);
  console.log(`Segments               : ${segments.length}`);
  console.log(`PDF                    : ${pdfPath.replace(process.cwd(), ".")} (${(await pdf.save()).length} bytes)`);
  console.log(`PPTX                   : ${pptxPath.replace(process.cwd(), ".")} (${pptxBuffer.length} bytes)`);
  console.log(
    "\nBoth files are compiled from the stored captions and say so on their face." +
      "\nNext: ingest them as course resources, e.g." +
      "\n  pnpm ingest:resource --file .freebuff/materials/lesson-notes.pdf --mode reference --title \"Lesson study guide (compiled from captions)\"" +
      "\n  pnpm ingest:resource --file .freebuff/materials/lesson-slides.pptx --mode aligned --title \"Lesson slides (compiled from captions)\"",
  );
}

main().catch((error) => {
  console.error(`Failed: ${error instanceof Error ? error.message : "unknown error"}`);
  process.exitCode = 1;
});
