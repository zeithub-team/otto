/**
 * Context economy for the agent loop: cap what read_file returns and shrink old
 * tool steps once the conversation grows, so the task itself never falls out
 * of the model's window.
 */

/** ~3 chars per token is a safe estimate for mixed Russian/English/code. */
export const estimateTokens = (chars: number): number => Math.ceil(chars / 3);

export interface ChatMessage {
  role: string;
  content: string;
  images?: string[];
  tool_calls?: Array<{ function?: { name?: string; arguments?: unknown } }>;
  tool_name?: string;
}

/** A slice of `text` by 1-based inclusive lines, capped to `maxChars`, with a hint on how to continue. */
export function sliceFile(text: string, maxChars: number, startLine?: number, endLine?: number): string {
  const lines = text.split('\n');
  const from = Math.max(1, Math.floor(startLine || 1));
  const explicitEnd = endLine && endLine >= from ? Math.min(lines.length, Math.floor(endLine)) : lines.length;
  if (from === 1 && explicitEnd === lines.length && text.length <= maxChars) return text;

  const out: string[] = [];
  let size = 0;
  let last = from - 1;
  for (let i = from - 1; i < explicitEnd; i++) {
    const cost = lines[i].length + 1;
    if (size + cost > maxChars && out.length) break;
    out.push(lines[i]);
    size += cost;
    last = i + 1;
  }
  let result = out.join('\n');
  if (last < lines.length) {
    result +=
      `\n\n[Показаны строки ${from}–${last} из ${lines.length}. Файл большой: остальное читай read_file(path, start_line=${last + 1}, end_line=…). ` +
      'Для правки не переписывай файл целиком — читай нужный кусок и меняй его через write_file/append_file частями.]';
  } else if (from > 1) {
    result += `\n\n[Строки ${from}–${last} из ${lines.length}]`;
  }
  return result;
}

/** Characters read_file may return, given the model's window in tokens. */
export const readLimitChars = (ctxTokens: number): number => Math.max(6000, Math.min(60000, Math.floor(ctxTokens * 0.12 * 3)));

const STUB_AFTER = 700;

/** Extract the key information from a tool result before stubbing it: file path, status, errors. */
function toolResultStub(content: string, toolName: string | undefined): string {
  const tool = toolName ?? 'инструмент';
  const len = content.length;
  // Preserve the first line (usually a status like "File overwritten: x.ts (500 bytes)" or an error)
  const firstLine = content.split('\n')[0].trim().slice(0, 200);
  // Preserve error lines
  const errors = content.split('\n').filter((l) => /error|ошибка|failed|REJECTED|not found/i.test(l)).slice(0, 3).map((l) => l.trim().slice(0, 150));
  const errorNote = errors.length ? `\nОшибки: ${errors.join('; ')}` : '';
  return `[результат убран: ${tool}, ${len} симв. — ${firstLine}${errorNote} — вызови снова, если нужно]`;
}

/**
 * Replace old bulky tool payloads (results and written file bodies) with short
 * stubs. The system prompt, the history and the current task (first user
 * message of this run) plus the last `keepRecent` messages stay intact.
 * Returns how many messages were shrunk.
 *
 * Key improvements: stubs now preserve the first line (file path, status) and
 * any error lines, so the model knows what happened without re-reading.
 */
export function compactMessages(messages: ChatMessage[], ctxTokens: number, keepRecent = 6, threshold = 0.6): number {
  const total = (): number => messages.reduce((sum, m) => sum + (m.content?.length ?? 0) + JSON.stringify(m.tool_calls ?? '').length, 0);
  if (estimateTokens(total()) < ctxTokens * threshold) return 0;

  let shrunk = 0;
  const limit = messages.length - keepRecent;
  for (let i = 1; i < limit; i++) {
    const m = messages[i];
    if (m.role === 'tool' && m.content.length > STUB_AFTER && !m.content.startsWith('[результат убран')) {
      m.content = toolResultStub(m.content, m.tool_name);
      shrunk++;
    } else if (m.role === 'assistant' && m.tool_calls) {
      for (const call of m.tool_calls) {
        const args = call.function?.arguments;
        if (args && typeof args === 'object') {
          const a = args as Record<string, unknown>;
          if (typeof a.content === 'string' && a.content.length > STUB_AFTER) {
            a.content = `[записано ${a.content.length} симв., текст убран для экономии контекста]`;
            shrunk++;
          }
        }
      }
    }
    if (estimateTokens(total()) < ctxTokens * (threshold - 0.15)) break;
  }
  return shrunk;
}
