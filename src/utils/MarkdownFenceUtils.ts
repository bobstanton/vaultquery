export interface MarkdownCodeFence {
  language: string;
  source: string;
  blockIndex: number;
}

export function extractMarkdownCodeFences(content: string): MarkdownCodeFence[] {
  const blocks: MarkdownCodeFence[] = [];
  const regex = /```([^\s`]+)[^\n]*\n([\s\S]*?)```/g;
  let match: RegExpExecArray | null;
  let blockIndex = 0;

  while ((match = regex.exec(content)) !== null) {
    blocks.push({
      language: match[1].trim(),
      source: match[2].trim(),
      blockIndex,
    });
    blockIndex++;
  }

  return blocks;
}

export function findCodeBlockRanges(text: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  const codeBlockRegex = /^(```|~~~).*\n[\s\S]*?^\1\s*$/gm;

  let match;
  while ((match = codeBlockRegex.exec(text)) !== null) {
    ranges.push([match.index, match.index + match[0].length]);
  }

  return ranges;
}

export function isInsideCodeBlock(pos: number, ranges: Array<[number, number]>): boolean {
  for (const [start, end] of ranges) {
    if (pos >= start && pos < end) {
      return true;
    }
  }
  return false;
}
