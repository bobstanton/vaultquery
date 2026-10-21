import { hashString } from './StringUtils';

export function computeContextKey(lineIndex: number, lines: string[]): string {
  const prevLine = lineIndex > 0 ? lines[lineIndex - 1] : '';
  const currentLine = lines[lineIndex] || '';
  const nextLine = lineIndex < lines.length - 1 ? lines[lineIndex + 1] : '';

  return [prevLine, currentLine, nextLine]
    .map(line => line.trim().toLowerCase())
    .join('\n');
}

export function computeAnchorHash(lineIndex: number, lines: string[], occurrence: number = 0): string {
  const contextWindow = computeContextKey(lineIndex, lines);
  const hashInput = occurrence > 0 ? `${contextWindow}::O${occurrence}` : contextWindow;

  return hashString(hashInput);
}
