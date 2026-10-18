import { describe, expect, it } from "vitest";
import { PDFDocument, StandardFonts } from "pdf-lib";
import PptxGenJS from "pptxgenjs";
import JSZip from "jszip";

import {
  DOCUMENT_CHUNK_CHARS,
  DocumentRefused,
  chunkPages,
  detectDocumentKind,
  extractSlideXmlText,
  parseDocument,
  parsePdf,
  parsePptx,
  splitPageText,
  type ParsedDocument,
  type ParsedPage,
} from "@/lib/ingest/document";
import {
  ALIGNMENT_MIN_MARGIN,
  ALIGNMENT_MIN_SCORE,
  LATE_ALIGNMENT_FRACTION,
  alignChunk,
  buildDocumentPlan,
  contentTokens,
} from "@/lib/ingest/document-plan";

const COURSE = "083d7195-9371-5202-93dc-a724ad7982cc";
const DIMENSIONS = 8;

/** A PDF with real pages, built here so the parser is reading real bytes. */
async function makePdf(pages: string[]): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (const text of pages) {
    const page = doc.addPage([595, 842]);
    page.drawText(text, { x: 48, y: 780, size: 11, font, maxWidth: 500 });
  }
  return new Uint8Array(await doc.save());
}

async function makePptx(slides: Array<{ title: string; body: string }>): Promise<Uint8Array> {
  const deck = new PptxGenJS();
  for (const slide of slides) {
    const added = deck.addSlide();
    added.addText(slide.title, { x: 0.5, y: 0.4, w: 9, h: 0.8, fontSize: 24 });
    added.addText(slide.body, { x: 0.5, y: 1.4, w: 9, h: 4, fontSize: 14 });
  }
  const buffer = (await deck.write({ outputType: "nodebuffer" })) as Buffer;
  return new Uint8Array(buffer);
}

function vector(seed: number): number[] {
  return Array.from({ length: DIMENSIONS }, (_, index) => Number(((seed + index) / 100).toFixed(4)));
}

const transcript = [
  { text: "today we look at how agents plan and use tools to answer questions", endSeconds: 60 },
  { text: "retrieval augmented generation grounds an answer in retrieved passages", endSeconds: 120 },
  { text: "vector databases store embeddings so similar meaning is found quickly", endSeconds: 180 },
  { text: "orchestration coordinates the steps an agent takes between tools", endSeconds: 240 },
  { text: "evaluation measures whether the grounded answer was supported by evidence", endSeconds: 300 },
  { text: "finally we put the whole system together into a working product", endSeconds: 360 },
];

describe("document detection and parsing", () => {
  it("detects a PDF by its header and refuses bytes that are neither PDF nor ZIP", () => {
    expect(detectDocumentKind(new TextEncoder().encode("%PDF-1.7 …"), "x.bin")).toBe("pdf");
    expect(() => detectDocumentKind(new TextEncoder().encode("hello"), "x.pdf")).toThrow(
      DocumentRefused,
    );
  });

  it("parses a real PDF into numbered pages and reports coverage", async () => {
    const bytes = await makePdf([
      "Agents choose a tool, act on the result, and then decide the next step from what they observed.",
      "",
    ]);

    const parsed = await parsePdf(bytes);

    expect(parsed.kind).toBe("pdf");
    expect(parsed.pages.map((page) => page.pageNumber)).toEqual([1, 2]);
    expect(parsed.pages[0].text).toContain("Agents choose a tool");
    // An empty page has no text layer, and calling it extracted would overstate
    // what was indexed.
    expect(parsed.visualOnlyPages).toEqual([2]);
    expect(parsed.coverage).toBeCloseTo(0.5, 5);
    expect(parsed.parser).toBe("unpdf-pdfjs-v1");
  });

  it("parses a real PPTX into numbered slides, in order", async () => {
    const bytes = await makePptx([
      { title: "Planning", body: "An agent decomposes the task and picks a tool for each step." },
      { title: "Retrieval", body: "A vector database returns passages whose meaning is close to the question." },
    ]);

    const parsed = await parsePptx(bytes);

    expect(parsed.kind).toBe("ppt");
    expect(parsed.pages.map((page) => page.pageNumber)).toEqual([1, 2]);
    expect(parsed.pages[0].text).toContain("Planning");
    expect(parsed.pages[1].text).toContain("vector database");
    expect(parsed.coverage).toBe(1);
  });

  it("refuses a ZIP that is not a presentation", async () => {
    const zip = new JSZip();
    zip.file("word/document.xml", "<w:document/>");
    const bytes = new Uint8Array(await zip.generateAsync({ type: "uint8array" }));

    await expect(parsePptx(bytes)).rejects.toThrow(/no presentation part/);
  });

  it("refuses an empty file rather than reporting zero pages as success", async () => {
    await expect(parsePdf(new Uint8Array())).rejects.toThrow(DocumentRefused);
  });

  it("concatenates runs inside a paragraph and keeps paragraphs on separate lines", () => {
    const xml = [
      "<p:sld><a:p><a:r><a:t>Hello </a:t></a:r><a:r><a:t>world</a:t></a:r></a:p>",
      "<a:p><a:t>Second &amp; third</a:t></a:p></p:sld>",
    ].join("");

    expect(extractSlideXmlText(xml)).toBe("Hello world\nSecond & third");
  });
});

describe("chunking", () => {
  it("never lets one chunk span two pages, and reports which part of a page it is", () => {
    const pages: ParsedPage[] = [
      { pageNumber: 1, text: "short page one", notes: "", visualOnly: false },
      {
        pageNumber: 2,
        text: Array.from({ length: 40 }, (_, index) => `Sentence ${index} about evidence and grounding.`).join(" "),
        notes: "",
        visualOnly: false,
      },
    ];

    const chunks = chunkPages(pages, 300);

    expect(chunks.every((chunk) => chunk.text.length <= 300)).toBe(true);
    const pageTwo = chunks.filter((chunk) => chunk.pageNumber === 2);
    expect(pageTwo.length).toBeGreaterThan(1);
    expect(pageTwo.map((chunk) => chunk.partIndex)).toEqual(
      pageTwo.map((_, index) => index + 1),
    );
    expect(new Set(pageTwo.map((chunk) => chunk.partCount)).size).toBe(1);
    expect(chunks.map((chunk) => chunk.ordinal)).toEqual(
      chunks.map((_, index) => index),
    );
  });

  it("splits a single sentence longer than the budget instead of overflowing it", () => {
    const long = `${"word ".repeat(200).trim()}`;
    const pieces = splitPageText(long, DOCUMENT_CHUNK_CHARS);

    expect(pieces.length).toBeGreaterThan(1);
    expect(pieces.every((piece) => piece.length <= DOCUMENT_CHUNK_CHARS)).toBe(true);
    expect(pieces.join(" ")).toBe(long);
  });

  it("skips pages that produced no text", () => {
    const chunks = chunkPages([
      { pageNumber: 1, text: "", notes: "", visualOnly: true },
      { pageNumber: 2, text: "Real text.", notes: "", visualOnly: false },
    ]);
    expect(chunks.map((chunk) => chunk.pageNumber)).toEqual([2]);
  });
});

describe("alignment", () => {
  it("scores a chunk against transcript windows and picks the right one", () => {
    const alignment = alignChunk(
      "A vector database stores embeddings so that similar meaning is found quickly.",
      transcript,
    );

    expect(alignment.bestIndex).toBe(2);
    expect(alignment.unlockSeconds).toBe(180);
    expect(alignment.score).toBeGreaterThan(0.5);
  });

  it("reports no match for text the recording never covers", () => {
    const alignment = alignChunk("Kubernetes ingress controllers terminate gRPC traffic.", transcript);
    expect(alignment.bestIndex).toBe(-1);
    expect(alignment.unlockSeconds).toBeNull();
  });

  it("drops stopwords so shared filler cannot look like a match", () => {
    expect([...contentTokens("the and of with this that")]).toEqual([]);
  });
});

describe("document plan", () => {
  const parsed: ParsedDocument = {
    kind: "pdf",
    pages: [
      { pageNumber: 1, text: "notes", notes: "", visualOnly: false },
      { pageNumber: 2, text: "notes", notes: "", visualOnly: false },
    ],
    coverage: 1,
    visualOnlyPages: [],
    parser: "test",
  };

  const chunks = [
    {
      ordinal: 0,
      text: "Retrieval augmented generation grounds an answer in retrieved passages so the learner can check it.",
      pageNumber: 1,
      notes: "",
      partIndex: 1,
      partCount: 1,
    },
    {
      ordinal: 1,
      text: "Measurement notes: the compliance score must never fall below 75% for a passing review.",
      pageNumber: 2,
      notes: "",
      partIndex: 1,
      partCount: 1,
    },
  ];

  function build(mode: "reference" | "aligned", acknowledgeLint: string | null = null) {
    return buildDocumentPlan({
      courseId: COURSE,
      storageKey: ".freebuff/materials/notes.pdf",
      title: "Notes",
      parsed,
      chunks,
      vectors: [vector(0), vector(1)],
      embeddingModel: "gemini-embedding-001",
      embeddingDimensions: DIMENSIONS,
      fileHash: "abc123",
      mode,
      transcript,
      recordingDurationSeconds: 360,
      acknowledgeLint,
    });
  }

  it("refuses to approve course-wide material containing a registered late-only fact", () => {
    expect(() => build("reference")).toThrow(/Refusing to approve this document course-wide/);
  });

  it("writes an acknowledged reference only when the operator records the risk", () => {
    const result = build("reference", "the threshold is a definition, not a result");

    const second = result.blocks[1] as Record<string, unknown>;
    expect(second.policy).toBe("COURSE_WIDE");
    expect(second.review_state).toBe("HUMAN_APPROVED");
    expect(second.lint_status).toBe("ACKNOWLEDGED");
    expect(second.unlock_seconds).toBeNull();
    expect(result.summary.acknowledged).toBe(1);
    expect(result.summary.markerHits).toContain("compliance score");
  });

  it("time-gates an uncertain alignment as PENDING with no unlock time", () => {
    // A chunk the recording never covers cannot be confidently placed, so it is
    // PENDING — and the predicate makes a null unlock ineligible, which is what
    // keeps a guess out of the evidence set.
    const result = buildDocumentPlan({
      courseId: COURSE,
      storageKey: "deck.pptx",
      title: "Deck",
      parsed: { ...parsed, kind: "ppt" },
      chunks: [
        {
          ordinal: 0,
          text: "Kubernetes ingress controllers terminate gRPC traffic at the edge of the cluster.",
          pageNumber: 3,
          notes: "",
          partIndex: 1,
          partCount: 1,
        },
      ],
      vectors: [vector(2)],
      embeddingModel: "gemini-embedding-001",
      embeddingDimensions: DIMENSIONS,
      fileHash: "def456",
      mode: "aligned",
      transcript,
      recordingDurationSeconds: 360,
    });

    const block = result.blocks[0] as Record<string, unknown>;
    expect(block.policy).toBe("TIMELINE_BOUND");
    expect(block.review_state).toBe("PENDING");
    expect(block.unlock_seconds).toBeNull();
    expect(block.slide_number).toBe(3);
    expect(block.page_number).toBeNull();
    expect(result.summary.pending).toBe(1);
  });

  it("auto-approves a confident alignment at the moment the recording covers it", () => {
    const result = build("aligned");
    const first = result.blocks[0] as Record<string, unknown>;

    expect(first.review_state).toBe("AUTO_APPROVED");
    expect(first.unlock_seconds).toBe(120);
    expect(Number(first.alignment_confidence)).toBeGreaterThanOrEqual(ALIGNMENT_MIN_SCORE);
    expect(Number(first.alignment_margin)).toBeGreaterThanOrEqual(ALIGNMENT_MIN_MARGIN);
    expect(result.summary.autoApproved).toBe(1);
  });

  it("flags, rather than silently approves, a course-wide block that lands in the last fifth", () => {
    const result = buildDocumentPlan({
      courseId: COURSE,
      storageKey: "late.pdf",
      title: "Late",
      parsed,
      chunks: [
        {
          ordinal: 0,
          text: "Orchestration coordinates the steps an agent takes between tools, and nothing else.",
          pageNumber: 1,
          notes: "",
          partIndex: 1,
          partCount: 1,
        },
      ],
      vectors: [vector(3)],
      embeddingModel: "gemini-embedding-001",
      embeddingDimensions: DIMENSIONS,
      fileHash: "late789",
      mode: "aligned",
      transcript,
      recordingDurationSeconds: 100, // so the 240 s match is past 80% of the recording
    });

    expect(result.summary.lateAlignments).toBe(1);
    // In aligned mode a late match is still legitimate: the block simply unlocks
    // there, which is the honest outcome rather than a lint failure.
    const block = result.blocks[0] as Record<string, unknown>;
    expect(block.unlock_seconds).toBe(240);
    expect(LATE_ALIGNMENT_FRACTION).toBeLessThan(1);
  });

  it("never writes a vector of the wrong dimension", () => {
    expect(() =>
      buildDocumentPlan({
        courseId: COURSE,
        storageKey: "x.pdf",
        title: "X",
        parsed,
        chunks: [chunks[0]],
        vectors: [[0.1, 0.2]],
        embeddingModel: "gemini-embedding-001",
        embeddingDimensions: DIMENSIONS,
        fileHash: "short",
        mode: "aligned",
        transcript,
        recordingDurationSeconds: 360,
      }),
    ).toThrow(/not the configured 8/);
  });

  it("is deterministic: the same file and course produce the same block ids", () => {
    const first = build("aligned");
    const second = build("aligned");
    expect(second.blocks.map((row) => row.id)).toEqual(first.blocks.map((row) => row.id));
  });
});

describe("parseDocument end to end", () => {
  it("routes a real PDF through the detector to the PDF parser", async () => {
    const bytes = await makePdf(["Evidence must be cited verbatim from the source block that contains it."]);
    const parsed = await parseDocument(bytes, "notes.pdf");
    expect(parsed.kind).toBe("pdf");
    expect(parsed.pages[0].text).toContain("Evidence must be cited");
  });
});
