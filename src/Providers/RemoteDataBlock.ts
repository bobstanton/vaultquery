export type RemoteBlockLine = { kind: 'blank' | 'comment' | 'body' | 'header' | 'invalid' } | { kind: 'entry'; key: string; value: string };

export const REMOTE_BODY_BLOCK = '|';

export function remoteBlockScanner(): (line: string) => RemoteBlockLine {
  let headersIndent: number | undefined;
  let bodyIndent: number | undefined;

  return line => {
    const text = line.trimStart();
    const indent = line.length - text.length;

    if (bodyIndent !== undefined && (!text || indent > bodyIndent)) return { kind: 'body' };
    bodyIndent = undefined;
    if (!text) return { kind: 'blank' };
    if (text.startsWith('#')) return { kind: 'comment' };
    if (headersIndent !== undefined && indent > headersIndent) return { kind: 'header' };
    headersIndent = undefined;
    const [, key, value] = /^([A-Za-z]+)\s*:\s*(.*?)\s*$/.exec(text) ?? [];

    if (key === undefined) return { kind: 'invalid' };
    if (key === 'body' && value === REMOTE_BODY_BLOCK) bodyIndent = indent;
    if (key === 'headers') headersIndent = indent;

    return { kind: 'entry', key, value };
  };
}
