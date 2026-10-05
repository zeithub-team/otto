/** Files (and whole folders) dropped from the operating system onto the page. */

export interface DroppedFile {
  file: File;
  /** Path inside the dropped folder, `/`-separated, starting with the dropped item's own name. */
  path: string;
}

const SKIP = new Set(['node_modules', '.git', '.next', '__pycache__', '.venv', 'vendor']);
const MAX_FILES = 500;

/** True when the drag carries files from outside the app (not the explorer's own move drag). */
export function hasOsFiles(dt: DataTransfer | null): boolean {
  return Boolean(dt && Array.from(dt.types ?? []).includes('Files'));
}

function readEntries(reader: FileSystemDirectoryReader): Promise<FileSystemEntry[]> {
  return new Promise((resolve, reject) => reader.readEntries(resolve, reject));
}

/**
 * Collect the dropped files, walking folders. Call it synchronously inside the drop handler
 * (the browser empties the DataTransfer afterwards).
 */
export async function readDroppedFiles(dt: DataTransfer): Promise<DroppedFile[]> {
  const entries: FileSystemEntry[] = [];
  for (const item of Array.from(dt.items ?? [])) {
    const entry = item.kind === 'file' ? item.webkitGetAsEntry?.() : null;
    if (entry) entries.push(entry);
  }
  const plain = Array.from(dt.files ?? []);
  if (entries.length === 0) return plain.map((file) => ({ file, path: file.name }));

  const out: DroppedFile[] = [];
  const walk = async (entry: FileSystemEntry, prefix: string): Promise<void> => {
    if (out.length >= MAX_FILES) return;
    if (entry.isFile) {
      const file = await new Promise<File>((resolve, reject) => (entry as FileSystemFileEntry).file(resolve, reject));
      out.push({ file, path: prefix + entry.name });
    } else if (entry.isDirectory) {
      if (SKIP.has(entry.name)) return;
      const reader = (entry as FileSystemDirectoryEntry).createReader();
      for (;;) {
        const batch = await readEntries(reader);
        if (batch.length === 0) break;
        for (const child of batch) await walk(child, `${prefix}${entry.name}/`);
      }
    }
  };
  for (const entry of entries) await walk(entry, '');
  return out;
}
