/**
 * `POST /api/files/extract` — parse an uploaded document into plain text for
 * chat attachments.
 *
 * Port of `backend/api/files.py::extract_document` / `_extract_text` with the
 * same limits (10 MB per upload, 60 000 characters, "[... truncated ...]"),
 * statuses and messages. Parsers: pdf-parse (PDF), mammoth (DOCX), SheetJS
 * (XLSX) — pure JS, no native compilation.
 */
import * as http from 'http';
import * as path from 'path';
import {
  errorMessage,
  HttpError,
  missingField,
  readBody,
  sendJson,
} from './http';

export const MAX_UPLOAD_BYTES = 10_000_000; // 10 MB for parsed documents
const MAX_EXTRACT_CHARS = 60_000;

/** Same extension set as `_DOC_EXTS` in the Python backend. */
const DOC_EXTS = new Set([
  '.pdf',
  '.docx',
  '.xlsx',
  '.csv',
  '.tsv',
  '.txt',
  '.md',
  '.json',
  '.yaml',
  '.yml',
  '.xml',
  '.log',
  '.rtf',
]);

/** UTF-8 decode with U+FFFD replacement (Python `errors="replace"`). */
function decodeText(data: Buffer): string {
  return new TextDecoder('utf-8', { ignoreBOM: true }).decode(data);
}

/**
 * PDF → text: `"\n\n".join(page.extract_text() for page in reader.pages)`.
 *
 * pdf-parse marks page boundaries by default (`-- 1 of 2 --`); pypdf does not,
 * so the marker is switched off and the pages are joined here instead.
 */
async function extractPdf(data: Buffer): Promise<string> {
  const { PDFParse } = require('pdf-parse') as typeof import('pdf-parse');
  const parser = new PDFParse({ data });
  try {
    const result = await parser.getText({ pageJoiner: '' });
    const pages = (result.pages ?? []).map((page: { text: string }) =>
      String(page.text ?? '').replace(/\n+$/, ''),
    );
    if (pages.length) return pages.join('\n\n');
    return String(result.text ?? '').replace(/\n+$/, '');
  } finally {
    try {
      await parser.destroy();
    } catch {
      /* already closed */
    }
  }
}

/** Decode the five entities mammoth escapes (plus numeric references). */
function decodeEntities(text: string): string {
  return text
    .replace(/&#x([0-9a-f]+);/gi, (_m, hex: string) =>
      String.fromCodePoint(parseInt(hex, 16)),
    )
    .replace(/&#(\d+);/g, (_m, dec: string) =>
      String.fromCodePoint(parseInt(dec, 10)),
    )
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');
}

/** HTML fragment (mammoth output) → `python-docx`'s `.text` of the block. */
function htmlBlockToText(inner: string): string {
  const withBreaks = inner
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n');
  const tagsStripped = withBreaks.replace(/<[^>]*>/g, '');
  return decodeEntities(tagsStripped).replace(/\n+$/, '');
}

/**
 * DOCX → text exactly like `python-docx` in `backend/api/files.py`:
 * non-empty *top-level* paragraphs first, then every table row with its cells
 * joined by `" | "` — all joined with `"\n"`.
 *
 * mammoth supplies the parsing (no native Word XML reader in Node); its HTML
 * is mapped back onto python-docx's paragraph/table model here.
 */
async function extractDocx(data: Buffer): Promise<string> {
  const mammoth = require('mammoth') as typeof import('mammoth');
  const html = (await mammoth.convertToHtml({ buffer: data })).value;

  const rows: string[] = [];
  const withoutTables = html.replace(
    /<table(?:\s[^>]*)?>([\s\S]*?)<\/table>/gi,
    (_whole, table: string) => {
      for (const row of table.matchAll(/<tr(?:\s[^>]*)?>([\s\S]*?)<\/tr>/gi)) {
        const cells: string[] = [];
        for (const cell of row[1].matchAll(/<t[dh](?:\s[^>]*)?>([\s\S]*?)<\/t[dh]>/gi)) {
          cells.push(htmlBlockToText(cell[1]));
        }
        rows.push(cells.join(' | '));
      }
      return '';
    },
  );

  const paragraphs: string[] = [];
  for (const para of withoutTables.matchAll(/<p(?:\s[^>]*)?>([\s\S]*?)<\/p>/gi)) {
    const text = htmlBlockToText(para[1]);
    if (text) paragraphs.push(text);
  }

  return [...paragraphs, ...rows].join('\n');
}

/** XLSX → text with `--- Sheet: <name> ---` headers (openpyxl format). */
function extractXlsx(data: Buffer): string {
  const XLSX = require('xlsx') as typeof import('xlsx');
  const workbook = XLSX.read(data, { type: 'buffer' });
  const lines: string[] = [];
  for (const sheetName of workbook.SheetNames) {
    const sheet = workbook.Sheets[sheetName];
    lines.push(`--- Sheet: ${sheetName} ---`);
    const rows = XLSX.utils.sheet_to_json(sheet, {
      header: 1,
      raw: false,
      defval: null,
      blankrows: true,
    }) as unknown[][];
    for (const row of rows) {
      if (!Array.isArray(row)) continue;
      // openpyxl: `if any(v is not None for v in row)`
      if (!row.some((cell) => cell !== null && cell !== undefined)) continue;
      lines.push(
        row
          .map((cell) => (cell === null || cell === undefined ? '' : String(cell)))
          .join('\t'),
      );
    }
  }
  return lines.join('\n');
}

/** `_extract_text()` — dispatch by extension, 415 for unknown types. */
async function extractText(filename: string, data: Buffer): Promise<string> {
  const ext = path.extname(filename || '').toLowerCase();

  if (ext === '.pdf') return extractPdf(data);
  if (ext === '.docx') return extractDocx(data);
  if (ext === '.xlsx') return extractXlsx(data);
  // .csv/.tsv and the remaining text types: raw UTF-8 decode (as in Python)
  if (DOC_EXTS.has(ext)) return decodeText(data);

  throw new HttpError(
    415,
    `Unsupported file type '${ext}'. ` +
      'Supported: PDF, DOCX, XLSX, CSV, TXT, MD, JSON, YAML, XML, LOG',
  );
}

// ---------------------------------------------------------------- multipart

interface MultipartPart {
  name: string;
  filename: string | null;
  data: Buffer;
}

function boundaryOf(contentType: string): string | null {
  const match = /multipart\/form-data\s*;\s*boundary=(?:"([^"]+)"|([^;]+))/i.exec(
    contentType,
  );
  if (!match) return null;
  return (match[1] ?? match[2]).trim();
}

function parsePart(raw: Buffer): MultipartPart | null {
  const headerEnd = raw.indexOf('\r\n\r\n');
  if (headerEnd < 0) return null;
  const headers = raw.subarray(0, headerEnd).toString('utf8');
  const disposition =
    /content-disposition\s*:\s*form-data\s*;([^\r\n]*)/i.exec(headers)?.[1] ??
    '';
  const name = /(?:^|;)\s*name="([^"]*)"/i.exec(disposition)?.[1];
  if (name === undefined) return null;
  const filenameMatch = /(?:^|;)\s*filename="([^"]*)"/i.exec(disposition);
  return {
    name,
    filename: filenameMatch ? filenameMatch[1] : null,
    data: raw.subarray(headerEnd + 4),
  };
}

function parseMultipart(body: Buffer, boundary: string): MultipartPart[] {
  const marker = Buffer.from(`--${boundary}`, 'utf8');
  const delimiter = Buffer.from(`\r\n--${boundary}`, 'utf8');
  const parts: MultipartPart[] = [];

  let pos = body.indexOf(marker);
  if (pos < 0) return parts;
  pos += marker.length;
  if (body.length >= pos + 2 && body[pos] === 0x0d && body[pos + 1] === 0x0a) {
    pos += 2;
  }

  for (;;) {
    const next = body.indexOf(delimiter, pos);
    const end = next < 0 ? body.length : next;
    const parsed = parsePart(body.subarray(pos, end));
    if (parsed) parts.push(parsed);
    if (next < 0) break;
    pos = next + 2 + marker.length;
    const isClosing =
      body.length >= pos + 2 && body[pos] === 0x2d && body[pos + 1] === 0x2d;
    if (isClosing) break;
    if (
      body.length >= pos + 2 &&
      body[pos] === 0x0d &&
      body[pos + 1] === 0x0a
    ) {
      pos += 2;
    } else {
      break;
    }
  }
  return parts;
}

// ----------------------------------------------------------------- endpoint

/**
 * Handles `POST /api/files/extract`; returns `false` for any other route so
 * the caller can continue with the REST router.
 */
export async function handleExtract(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  pathname: string,
): Promise<boolean> {
  if (req.method !== 'POST' || pathname !== '/api/files/extract') return false;

  const boundary = boundaryOf(String(req.headers['content-type'] ?? ''));
  if (!boundary) {
    // FastAPI: no multipart body at all → the `file` field is missing
    sendJson(res, 422, { detail: [missingField(['body', 'file'], null)] });
    return true;
  }

  const body = await readBody(req, MAX_UPLOAD_BYTES * 4);
  if (
    body.includes(Buffer.from(`--${boundary}`, 'utf8')) &&
    !body.includes(Buffer.from(`--${boundary}--`, 'utf8'))
  ) {
    throw new HttpError(400, 'There was an error parsing the body');
  }

  const file = parseMultipart(body, boundary).find(
    (part) => part.name === 'file' && part.filename !== null,
  );
  if (!file) {
    sendJson(res, 422, { detail: [missingField(['body', 'file'], null)] });
    return true;
  }
  const filename = file.filename ?? '';

  if (file.data.length > MAX_UPLOAD_BYTES) {
    throw new HttpError(413, 'File is larger than 10 MB');
  }
  if (!file.data.length) {
    throw new HttpError(400, 'Empty file');
  }

  let text: string;
  try {
    text = await extractText(filename, file.data);
  } catch (exc) {
    if (exc instanceof HttpError) throw exc;
    throw new HttpError(422, `Could not parse file: ${errorMessage(exc)}`);
  }

  text = text.trim();
  if (!text) {
    throw new HttpError(422, 'No extractable text found in the file');
  }
  if (text.length > MAX_EXTRACT_CHARS) {
    const codePoints = Array.from(text);
    if (codePoints.length > MAX_EXTRACT_CHARS) {
      text =
        codePoints.slice(0, MAX_EXTRACT_CHARS).join('') +
        '\n\n[... truncated ...]';
    }
  }

  sendJson(res, 200, {
    name: file.filename,
    content: text,
    chars: Array.from(text).length,
  });
  return true;
}
