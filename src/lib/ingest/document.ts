/**
 * PDF and PPTX parsing for course resources.
 *
 * WHAT THIS IS
 *   A pure, testable reader that turns a PDF or a PPTX into source-addressable
 *   pages/slides. It does no I/O beyond the bytes it is handed and it never
 *   invents text: a page whose text layer is empty is reported as having no text,
 *   not as "parsed".
 *
 * WHAT IT REFUSES
 *   Documents that are too large, have too many pages/slides, or whose archive
 *   would expand past a bound. A container that is not a presentation is refused
 *   rather than read as one. Each refusal names the bound it hit.
 *
 * WHAT IT DOES NOT DO
 *   OCR. A scanned PDF has no text layer here, and calling that "indexed" would
 *   be the exact lie `resources.extraction_coverage` exists to prevent. The
 *   coverage figure this returns is the fraction of pages that produced text.
 */
import JSZip from "jszip";

export const DOCUMENT_MAX_BYTES = 25 * 1024 * 1024;
export const DOCUMENT_MAX_UNCOMPRESSED_BYTES = 100 * 1024 * 1024;
export const DOCUMENT_MAX_ENTRIES = 600;
export const DOCUMENT_MAX_PAGES = 200;
/** A page or slide below this many non-space characters is treated as visual-only. */
export const MIN_TEXT_CHARS_PER_PAGE = 40;
/** Retrieval-sized chunk. Observed video blocks run to about 950 characters. */
export const DOCUMENT_CHUNK_CHARS = 900;

export type DocumentKind = "pdf" | "ppt";

export interface ParsedPage {
  /** 1-based page (PDF) or slide (PPTX) number, exactly as the source numbers it. */
  pageNumber: number;
  text: string;
  /** Speaker notes, PPTX only. Empty when the source has none. */
  notes: string;
  /** True when the page produced less than MIN_TEXT_CHARS_PER_PAGE characters. */
  visualOnly: boolean;
}

export interface ParsedDocument {
  kind: DocumentKind;
  pages: ParsedPage[];
  /**
   * Fraction of pages that produced usable text. A 20-page scan with two text
   * pages reports 0.1, and every screen that shows the resource shows this.
   */
  coverage: number;
  /** Pages that produced no usable text, for the operator report. */
  visualOnlyPages: number[];
  parser: string;
}

export class DocumentRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DocumentRefused";
  }
}

/** Magic-byte detection, not the file extension. */
export function detectDocumentKind(bytes: Uint8Array, fileName: string): DocumentKind {
  const isPdf =
    bytes.length >= 5 &&
    bytes[0] === 0x25 && // %
    bytes[1] === 0x50 && // P
    bytes[2] === 0x44 && // D
    bytes[3] === 0x46 && // F
    bytes[4] === 0x2d; // -
  if (isPdf) return "pdf";

  const isZip =
    bytes.length >= 4 &&
    bytes[0] === 0x50 &&
    bytes[1] === 0x4b &&
    bytes[2] === 0x03 &&
    bytes[3] === 0x04;
  if (isZip) {
    // A .docx is also a ZIP. Only the presentation part makes it a deck, and the
    // caller confirms that once the archive is open — this is the cheap check.
    const lower = fileName.toLowerCase();
    if (lower.endsWith(".pptx") || lower.endsWith(".ppsx")) return "ppt";
    return "ppt";
  }

  throw new DocumentRefused(
    "Only PDF and PPTX files are supported: the bytes are neither a PDF header nor a ZIP container.",
  );
}

function assertSize(bytes: Uint8Array): void {
  if (bytes.length === 0) throw new DocumentRefused("The file is empty.");
  if (bytes.length > DOCUMENT_MAX_BYTES) {
    throw new DocumentRefused(
      `The file is ${(bytes.length / (1024 * 1024)).toFixed(1)} MiB, over the ${DOCUMENT_MAX_BYTES / (1024 * 1024)} MiB limit.`,
    );
  }
}

/* ------------------------------------------------------------------ *
 * PDF
 * ------------------------------------------------------------------ */

export async function parsePdf(bytes: Uint8Array): Promise<ParsedDocument> {
  assertSize(bytes);

  const { extractText, getDocumentProxy } = await import("unpdf");

  let totalPages = 0;
  let texts: string[] = [];
  try {
    const pdf = await getDocumentProxy(new Uint8Array(bytes));
    totalPages = pdf.numPages;
    if (totalPages === 0) throw new DocumentRefused("The PDF reports no pages.");
    if (totalPages > DOCUMENT_MAX_PAGES) {
      throw new DocumentRefused(
        `The PDF has ${totalPages} pages, over the ${DOCUMENT_MAX_PAGES}-page limit.`,
      );
    }
    const extracted = await extractText(pdf, { mergePages: false });
    texts = extracted.text;
  } catch (error) {
    if (error instanceof DocumentRefused) throw error;
    throw new DocumentRefused(
      `The PDF could not be read (${error instanceof Error ? error.name : "unknown error"}). It may be encrypted or damaged.`,
    );
  }

  const pages: ParsedPage[] = [];
  for (let index = 0; index < totalPages; index += 1) {
    const text = normalizePageText(texts[index] ?? "");
    pages.push({
      pageNumber: index + 1,
      text,
      notes: "",
      visualOnly: text.length < MIN_TEXT_CHARS_PER_PAGE,
    });
  }

  return summarize("pdf", pages, "unpdf-pdfjs-v1");
}

/* ------------------------------------------------------------------ *
 * PPTX
 * ------------------------------------------------------------------ */

function decodeXmlEntities(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, code: string) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/&amp;/g, "&");
}

/**
 * Text of one slide, in document order.
 *
 * Runs (`<a:t>`) inside a paragraph (`<a:p>`) are concatenated without a space
 * because PowerPoint splits runs mid-word for formatting; paragraphs become new
 * lines, which is what the author actually wrote.
 */
export function extractSlideXmlText(xml: string): string {
  const paragraphs = xml.split(/<a:p[ >]/).slice(1);
  const lines: string[] = [];
  for (const paragraph of paragraphs) {
    const runs = [...paragraph.matchAll(/<a:t>([\s\S]*?)<\/a:t>/g)].map((match) =>
      decodeXmlEntities(match[1] ?? ""),
    );
    const line = runs.join("").trim();
    if (line !== "") lines.push(line);
  }
  return normalizePageText(lines.join("\n"));
}

function slideNumberFromPath(path: string): number | null {
  const match = /^ppt\/slides\/slide(\d+)\.xml$/.exec(path);
  return match ? Number(match[1]) : null;
}

export async function parsePptx(bytes: Uint8Array): Promise<ParsedDocument> {
  assertSize(bytes);

  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(bytes);
  } catch {
    throw new DocumentRefused("The file is not a readable ZIP container, so it is not a PPTX.");
  }

  const entries = Object.values(zip.files).filter((entry) => !entry.dir);
  if (entries.length > DOCUMENT_MAX_ENTRIES) {
    throw new DocumentRefused(
      `The archive holds ${entries.length} entries, over the ${DOCUMENT_MAX_ENTRIES}-entry limit.`,
    );
  }

  let declaredBytes = 0;
  for (const entry of entries) {
    const size = (entry as unknown as { _data?: { uncompressedSize?: number } })._data
      ?.uncompressedSize;
    if (typeof size === "number") declaredBytes += size;
  }
  if (declaredBytes > DOCUMENT_MAX_UNCOMPRESSED_BYTES) {
    throw new DocumentRefused(
      `The archive would expand to ${(declaredBytes / (1024 * 1024)).toFixed(0)} MiB, over the ${DOCUMENT_MAX_UNCOMPRESSED_BYTES / (1024 * 1024)} MiB limit.`,
    );
  }

  if (!zip.file("ppt/presentation.xml")) {
    throw new DocumentRefused(
      "The container has no presentation part, so it is a ZIP but not a PowerPoint deck.",
    );
  }

  const slidePaths = entries
    .map((entry) => entry.name)
    .map((path) => ({ path, number: slideNumberFromPath(path) }))
    .filter((item): item is { path: string; number: number } => item.number !== null)
    .sort((a, b) => a.number - b.number);

  if (slidePaths.length === 0) {
    throw new DocumentRefused("The deck contains no slides.");
  }
  if (slidePaths.length > DOCUMENT_MAX_PAGES) {
    throw new DocumentRefused(
      `The deck has ${slidePaths.length} slides, over the ${DOCUMENT_MAX_PAGES}-slide limit.`,
    );
  }

  const pages: ParsedPage[] = [];
  for (const slide of slidePaths) {
    const xml = await zip.file(slide.path)?.async("string");
    const text = xml ? extractSlideXmlText(xml) : "";
    pages.push({
      pageNumber: slide.number,
      text,
      notes: await readSlideNotes(zip, slide.number),
      visualOnly: text.length < MIN_TEXT_CHARS_PER_PAGE,
    });
  }

  return summarize("ppt", pages, "pptx-ooxml-v1");
}

/**
 * Speaker notes, resolved through the slide's own relationship file.
 *
 * The numbering of `notesSlides/notesSlideN.xml` does not reliably match the
 * slide it belongs to, so guessing from the number would attach one slide's notes
 * to another. The rels file states the target; when it is absent, notes are
 * reported as absent rather than misattributed.
 */
async function readSlideNotes(zip: JSZip, slideNumber: number): Promise<string> {
  const relsPath = `ppt/slides/_rels/slide${slideNumber}.xml.rels`;
  const rels = await zip.file(relsPath)?.async("string");
  if (!rels) return "";

  const match = /Target="([^"]*notesSlide\d+\.xml)"/.exec(rels);
  if (!match?.[1]) return "";

  // Targets are relative to ppt/slides/, and may be written as "../notesSlides/…".
  const resolved = match[1].replace(/^\.\.\//, "ppt/").replace(/^\//, "");
  const notesPath = resolved.startsWith("ppt/") ? resolved : `ppt/${resolved}`;
  const xml = await zip.file(notesPath)?.async("string");
  if (!xml) return "";

  // The notes body repeats the slide's own text placeholder; only the notes body
  // is kept by taking everything after the notes placeholder shape.
  const bodyStart = xml.indexOf('type="body"');
  const body = bodyStart >= 0 ? xml.slice(bodyStart) : xml;
  return extractSlideXmlText(body);
}

/* ------------------------------------------------------------------ *
 * Shared
 * ------------------------------------------------------------------ */

function normalizePageText(raw: string): string {
  return raw
    .replace(/\r\n?/g, "\n")
    // PDF extraction hyphenates at line ends; a hard-wrapped word is not a word.
    .replace(/(\w)-\n(\w)/g, "$1$2")
    .replace(/[ \t\u00a0]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function summarize(kind: DocumentKind, pages: ParsedPage[], parser: string): ParsedDocument {
  const visualOnlyPages = pages.filter((page) => page.visualOnly).map((page) => page.pageNumber);
  const withText = pages.length - visualOnlyPages.length;
  return {
    kind,
    pages,
    coverage: pages.length === 0 ? 0 : Number((withText / pages.length).toFixed(4)),
    visualOnlyPages,
    parser,
  };
}

export async function parseDocument(
  bytes: Uint8Array,
  fileName: string,
): Promise<ParsedDocument> {
  const kind = detectDocumentKind(bytes, fileName);
  return kind === "pdf" ? parsePdf(bytes) : parsePptx(bytes);
}

/* ------------------------------------------------------------------ *
 * Chunking
 * ------------------------------------------------------------------ */

export interface DocumentChunk {
  /** Position in the whole document, so ordering never depends on the chunker. */
  ordinal: number;
  text: string;
  pageNumber: number;
  notes: string;
  /** 1 of N when a page was split across chunks. */
  partIndex: number;
  partCount: number;
}

/**
 * Split page text into retrieval-sized chunks, never across a page boundary.
 *
 * A chunk that spans two pages cannot be cited: the citation has one page number.
 * Each chunk therefore belongs to exactly one page, and a page too long for one
 * chunk becomes several chunks that all name the same page.
 */
export function chunkPages(
  pages: ParsedPage[],
  maxChars: number = DOCUMENT_CHUNK_CHARS,
): DocumentChunk[] {
  const chunks: DocumentChunk[] = [];
  let ordinal = 0;

  for (const page of pages) {
    const body = page.notes.trim() === "" ? page.text : `${page.text}\n\nNotes: ${page.notes}`;
    if (body.trim() === "") continue;

    const pieces = splitPageText(body, maxChars);
    for (const [index, piece] of pieces.entries()) {
      if (piece.trim() === "") continue;
      chunks.push({
        ordinal,
        text: piece.trim(),
        pageNumber: page.pageNumber,
        notes: page.notes,
        partIndex: index + 1,
        partCount: pieces.length,
      });
      ordinal += 1;
    }
  }

  return chunks;
}

/**
 * Break one page into pieces at line and sentence boundaries, packing up to
 * `maxChars`. A single sentence longer than the budget is split on whitespace
 * rather than being emitted whole, because an unbounded chunk breaks the prompt
 * bound downstream.
 */
export function splitPageText(text: string, maxChars: number): string[] {
  const units: string[] = [];
  for (const line of text.split(/\n+/)) {
    for (const sentence of line.split(/(?<=[.!?])\s+/)) {
      const trimmed = sentence.trim();
      if (trimmed === "") continue;
      if (trimmed.length <= maxChars) {
        units.push(trimmed);
        continue;
      }
      let rest = trimmed;
      while (rest.length > maxChars) {
        const cut = rest.lastIndexOf(" ", maxChars);
        const boundary = cut > 0 ? cut : maxChars;
        units.push(rest.slice(0, boundary).trim());
        rest = rest.slice(boundary).trim();
      }
      if (rest !== "") units.push(rest);
    }
  }

  const pieces: string[] = [];
  let current = "";
  for (const unit of units) {
    const candidate = current === "" ? unit : `${current} ${unit}`;
    if (candidate.length > maxChars) {
      if (current !== "") pieces.push(current);
      current = unit;
    } else {
      current = candidate;
    }
  }
  if (current !== "") pieces.push(current);
  return pieces;
}
