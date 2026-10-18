/**
 * One resource's readable content, grouped for a page/slide viewer.
 *
 * Eligibility is decided by the server; this module only decides how the
 * permitted blocks are laid out. Grouping by page, slide or line range matters
 * because a PDF page is split into several blocks and showing them as separate
 * cards would make one page look like three sources.
 */

export interface ResourceBlock {
  id: string;
  text: string;
  pageNumber: number | null;
  slideNumber: number | null;
  lineStart: number | null;
  lineEnd: number | null;
  startSeconds: number | null;
  endSeconds: number | null;
}

export interface ResourceGroup {
  key: string;
  heading: string;
  blocks: ResourceBlock[];
}

function formatSeconds(total: number): string {
  const safe = Math.max(0, Math.floor(total));
  return `${String(Math.floor(safe / 60)).padStart(2, "0")}:${String(safe % 60).padStart(2, "0")}`;
}

export function groupResourceBlocks(blocks: ResourceBlock[]): ResourceGroup[] {
  const groups = new Map<string, ResourceGroup>();

  for (const block of blocks) {
    let key: string;
    let heading: string;

    if (block.pageNumber !== null) {
      key = `page-${block.pageNumber}`;
      heading = `Page ${block.pageNumber}`;
    } else if (block.slideNumber !== null) {
      key = `slide-${block.slideNumber}`;
      heading = `Slide ${block.slideNumber}`;
    } else if (block.lineStart !== null) {
      const end = block.lineEnd ?? block.lineStart;
      key = `lines-${block.lineStart}`;
      heading = end === block.lineStart ? `Line ${block.lineStart}` : `Lines ${block.lineStart}–${end}`;
    } else if (block.startSeconds !== null) {
      const end = block.endSeconds ?? block.startSeconds;
      key = `time-${block.startSeconds}`;
      heading = `${formatSeconds(block.startSeconds)}–${formatSeconds(end)}`;
    } else {
      key = "unlocated";
      heading = "Passage";
    }

    const existing = groups.get(key);
    if (existing) {
      existing.blocks.push(block);
    } else {
      groups.set(key, { key, heading, blocks: [block] });
    }
  }

  return [...groups.values()].sort((a, b) => {
    const aStart = a.blocks[0];
    const bStart = b.blocks[0];
    const aValue =
      aStart.pageNumber ?? aStart.slideNumber ?? aStart.lineStart ?? aStart.startSeconds ?? 0;
    const bValue =
      bStart.pageNumber ?? bStart.slideNumber ?? bStart.lineStart ?? bStart.startSeconds ?? 0;
    return aValue - bValue;
  });
}
