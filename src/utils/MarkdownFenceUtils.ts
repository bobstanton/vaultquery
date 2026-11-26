export interface MarkdownCodeFence {
  language: string;
  source: string;
  blockIndex: number;
  start: number;
  end: number;
}

export interface FenceLine {
  marker: string;
  language: string;
}

export function parseFenceLine(line: string): FenceLine | undefined {
  const [, marker, language] = /^[ \t]*(`{3,}|~{3,})[ \t]*([^\s`~]*)/.exec(line) ?? [];

  return marker === undefined ? undefined : { marker, language };
}

export function closesFence(opening: FenceLine, line: string): boolean {
  const closing = parseFenceLine(line);

  return closing !== undefined && !closing.language && closing.marker[0] === opening.marker[0] && closing.marker.length >= opening.marker.length;
}

export function scanMarkdownCodeFences(content: string): MarkdownCodeFence[] {
  const blocks: MarkdownCodeFence[] = [];
  const regex = /^[ \t]*(`{3,}|~{3,})([^\r\n]*)(?=\r?$)/gm;
  let opening: RegExpExecArray | null = null;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(content)) !== null) {
    if (!opening) {
      opening = match;
      continue;
    }

    if (match[1][0] !== opening[1][0] || match[1].length < opening[1].length || match[2].trim()) continue;

    blocks.push({
      language: opening[2].trim().split(/\s+/, 1)[0],
      source: content.slice(opening.index + opening[0].length, match.index).trim(),
      blockIndex: blocks.length,
      start: opening.index,
      end: match.index + match[0].length,
    });

    opening = null;
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
