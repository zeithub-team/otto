/**
 * Files attached to a message travel inside its text:
 *
 *   <message>\n\n--- File: name ---\n```\n<content>\n```
 *
 * The model needs the content, the reader of the chat does not: this splits it back out so the
 * chat can show the message text and a collapsed card per file.
 */

export interface AttachedFile {
  name: string;
  body: string;
  lines: number;
  chars: number;
}

const HEADER = /\n\n--- File: (.+?) ---\n```\n/;

export function splitAttachments(content: string): { text: string; files: AttachedFile[] } {
  if (!content.includes('--- File: ')) return { text: content, files: [] };
  const parts = content.split(new RegExp(HEADER.source));
  const text = parts[0];
  const files: AttachedFile[] = [];
  for (let i = 1; i + 1 < parts.length; i += 2) {
    const body = parts[i + 1].replace(/\n```\s*$/, '');
    files.push({ name: parts[i], body, lines: body === '' ? 0 : body.split('\n').length, chars: body.length });
  }
  return { text, files };
}

/** Text large enough that it belongs in an attachment card rather than in the message box. */
export function isBulkyText(text: string): boolean {
  return text.length > 1500 || text.split('\n').length > 25;
}

/** File name and extension guessed for pasted text: JSON, HTML/XML or plain text. */
export function nameForPastedText(text: string, taken: string[] = []): string {
  const t = text.trim();
  let ext = 'txt';
  if (/^[{[]/.test(t)) {
    try { JSON.parse(t); ext = 'json'; } catch { /* not JSON */ }
  }
  if (ext === 'txt' && /^<!doctype html|^<html[\s>]/i.test(t)) ext = 'html';
  else if (ext === 'txt' && /^<\?xml|^<[a-z][\w-]*[\s>]/i.test(t)) ext = 'xml';
  let name = `pasted.${ext}`;
  for (let n = 2; taken.includes(name); n++) name = `pasted-${n}.${ext}`;
  return name;
}

export const humanSize = (chars: number): string => (chars < 1024 ? `${chars} B` : chars < 1048576 ? `${(chars / 1024).toFixed(1)} KB` : `${(chars / 1048576).toFixed(1)} MB`);
