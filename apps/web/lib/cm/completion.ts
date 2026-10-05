import type { Completion, CompletionContext, CompletionResult, CompletionSource } from '@codemirror/autocomplete';
import { fetchCompletions, type CompletionItem } from '../api';

const WORD = /[\p{L}\p{N}_$]*/u;
const TYPE: Record<CompletionItem['kind'], string> = {
  class: 'class', interface: 'interface', function: 'function', method: 'method', type: 'type', variable: 'variable',
};

/** Identifier before a member-access operator (`user.`, `$this->`, `Foo::`, `a?.`) on the text before the cursor. */
export function memberContainer(textBefore: string): string | undefined {
  const m = /([\p{L}\p{N}_$]+)\s*(?:\?\.|\.|->|::)\s*$/u.exec(textBefore);
  return m?.[1];
}

/** Words of the (possibly unsaved) buffer — the index only knows the saved file. */
function bufferWords(doc: string, exclude: Set<string>, prefix: string): string[] {
  const text = doc.length > 300_000 ? doc.slice(0, 300_000) : doc;
  const out = new Set<string>();
  const lower = prefix.toLowerCase();
  for (const m of text.matchAll(/[\p{L}_$][\p{L}\p{N}_$]{2,}/gu)) {
    const w = m[0];
    if (w !== prefix && !exclude.has(w) && w.toLowerCase().startsWith(lower)) out.add(w);
    if (out.size >= 30) break;
  }
  return [...out];
}

/**
 * Completion from the project index: symbols and identifiers of the whole project, the members
 * of a class after `.` / `->` / `::` / `this.`, plus the words of the current buffer.
 * Every other completion source of the language (keywords, tags, CSS properties) works next to it.
 */
export function projectCompletion(target: () => { projectId: number; path: string } | null): CompletionSource {
  return async (context: CompletionContext): Promise<CompletionResult | null> => {
    const ctx = target();
    if (!ctx) return null;
    const word = context.matchBefore(WORD);
    const from = word ? word.from : context.pos;
    const prefix = word ? word.text : '';
    const line = context.state.doc.lineAt(context.pos);
    const container = memberContainer(line.text.slice(0, from - line.from));

    // Typing a plain word: start after 1 character; `.` / `->` / `::` complete immediately
    if (!container && !context.explicit && prefix.length < 1) return null;

    let items: CompletionItem[];
    try {
      items = await fetchCompletions(ctx.projectId, { path: ctx.path, line: line.number, prefix, container });
    } catch {
      return null;
    }
    if (context.aborted) return null;

    const options: Completion[] = items.map((item, i) => ({
      label: item.label,
      type: TYPE[item.kind],
      detail: item.detail,
      boost: Math.max(-99, 99 - i), // the server already ranked them
    }));
    if (!container) {
      const seen = new Set(items.map((i) => i.label));
      for (const w of bufferWords(context.state.doc.toString(), seen, prefix)) {
        options.push({ label: w, type: 'variable', boost: -50 });
      }
    }
    if (options.length === 0) return null;
    return { from, options, validFor: /^[\p{L}\p{N}_$]*$/u };
  };
}
