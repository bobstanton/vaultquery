export interface MarkdownCodeFence {
  language: string;
  source: string;
  blockIndex: number;
  start: number;
  end: number;
}

export function scanMarkdownCodeFences(content: string): MarkdownCodeFence[] {
  const blocks: MarkdownCodeFence[] = [];
  const regex = /^(```|~~~)([^\s`~]*)[^\n]*\n([\s\S]*?)^\1\s*$/gm;
  let match: RegExpExecArray | null;
  let blockIndex = 0;

  while ((match = regex.exec(content)) !== null) {
    blocks.push({
      language: match[2].trim(),
      source: match[3].trim(),
      blockIndex,
      start: match.index,
      end: match.index + match[0].length,
    });
    blockIndex++;
  }

  return blocks;
}

export function findCodeBlockRanges(text: string): Array<[number, number]> {
  return scanMarkdownCodeFences(text).map((block): [number, number] => [block.start, block.end]);
}

export function isInsideCodeBlock(pos: number, ranges: Array<[number, number]>): boolean {
  for (const [start, end] of ranges) {
    if (pos >= start && pos < end) {
      return true;
    }
  }
  return false;
}
