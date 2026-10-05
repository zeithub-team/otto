/**
 * What an agent run changed (files created / modified / deleted, with line
 * counts) and the model's "thinking" text — the two things the chat shows
 * around the answer.
 */

export interface FileChange {
  path: string;
  action: 'created' | 'modified' | 'deleted';
  added: number;
  removed: number;
}

/** Lines of a text; a final newline does not start an extra empty line. */
const lines = (text: string): string[] => (text === '' ? [] : (text.endsWith('\n') ? text.slice(0, -1) : text).split('\n'));

/** Approximate line diff (multiset of lines, order ignored): cheap and good enough for "+12 −3". */
export function lineDelta(before: string, after: string): { added: number; removed: number } {
  const pool = new Map<string, number>();
  for (const line of lines(before)) pool.set(line, (pool.get(line) ?? 0) + 1);
  let added = 0;
  for (const line of lines(after)) {
    const left = pool.get(line) ?? 0;
    if (left > 0) pool.set(line, left - 1);
    else added++;
  }
  let removed = 0;
  for (const count of pool.values()) removed += count;
  return { added, removed };
}

/** Tag appended to a write/delete tool result so the run can total the changes. */
export const deltaTag = (added: number, removed: number): string => ` [Δ +${added} −${removed}]`;
const TAG = /\[Δ \+(\d+) −(\d+)\]\s*$/;

/** Collects the file changes of one run from the tool results. */
export class ChangeTracker {
  private readonly files = new Map<string, FileChange>();

  track(tool: string, args: Record<string, unknown>, result: string): void {
    const rawPath = String(args.path ?? '').replace(/\\/g, '/').replace(/^\.\//, '');
    if (!rawPath) return;
    const tag = TAG.exec(result);
    const added = tag ? Number(tag[1]) : 0;
    const removed = tag ? Number(tag[2]) : 0;
    const known = this.files.get(rawPath);

    if (tool === 'write_file' && /^File CREATED/.test(result)) {
      this.files.set(rawPath, { path: rawPath, action: known?.action === 'deleted' ? 'modified' : 'created', added, removed });
    } else if ((tool === 'write_file' && /^File overwritten/.test(result)) || (tool === 'append_file' && /^Appended to/.test(result)) || (tool === 'replace_in_file' && /^Replaced in/.test(result))) {
      if (known) {
        known.added += added;
        known.removed += removed;
        if (known.action === 'deleted') known.action = 'modified';
      } else {
        this.files.set(rawPath, { path: rawPath, action: 'modified', added, removed });
      }
    } else if ((tool === 'delete_file' || tool === 'delete_path') && /^Deleted (file|folder)/.test(result)) {
      if (known?.action === 'created') this.files.delete(rawPath); // made and removed within the run: no net change
      else this.files.set(rawPath, { path: rawPath, action: 'deleted', added: 0, removed: known ? known.removed + removed : removed });
    }
  }

  list(): FileChange[] {
    const order = { created: 0, modified: 1, deleted: 2 } as const;
    return [...this.files.values()].sort((a, b) => order[a.action] - order[b.action] || a.path.localeCompare(b.path));
  }

  /** Block appended to the final answer; the chat renders it as a card. Empty when nothing changed. */
  marker(): string {
    const files = this.list();
    return files.length ? `\n\n:::changes\n${JSON.stringify(files)}\n:::` : '';
  }
}

/** The marker as stored in a message (for the client) — and how to remove it before the text is reused. */
const MARKER = /\n*:::changes\n[\s\S]*?\n:::\s*$/;
export const stripChangesMarker = (text: string): string => text.replace(MARKER, '');

/**
 * Splits streamed text into visible text and `<think>…</think>` content, even
 * when a tag arrives cut in two chunks.
 */
export class ThinkSplitter {
  private inThink = false;
  private carry = '';

  feed(chunk: string): { visible: string; think: string } {
    let text = this.carry + chunk;
    this.carry = '';
    let visible = '';
    let think = '';
    for (;;) {
      const tag = this.inThink ? '</think>' : '<think>';
      const at = text.indexOf(tag);
      if (at >= 0) {
        (this.inThink ? (think += text.slice(0, at)) : (visible += text.slice(0, at)));
        text = text.slice(at + tag.length);
        this.inThink = !this.inThink;
        continue;
      }
      // hold back a possible start of the tag at the end of the chunk
      let keep = 0;
      for (let n = Math.min(tag.length - 1, text.length); n > 0; n--) {
        if (tag.startsWith(text.slice(text.length - n))) {
          keep = n;
          break;
        }
      }
      const body = text.slice(0, text.length - keep);
      this.carry = text.slice(text.length - keep);
      if (this.inThink) think += body;
      else visible += body;
      return { visible, think };
    }
  }

  /** Text still held back when the stream ends. */
  flush(): { visible: string; think: string } {
    const rest = this.carry;
    this.carry = '';
    return this.inThink ? { visible: '', think: rest } : { visible: rest, think: '' };
  }
}
