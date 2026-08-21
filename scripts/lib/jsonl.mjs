// Append-friendly JSONL storage.
//
// Every data file the cron writes is newline-delimited and sorted by date, so a
// daily run appends a line or two instead of rewriting the file. That keeps git
// deltas proportional to what actually changed rather than to the file size.

import fs from 'node:fs/promises';
import path from 'node:path';

/** Read a JSONL file into a Map keyed by `key`. Missing file -> empty Map. */
export async function readJsonl(file, key = 'd') {
  const out = new Map();
  let txt;
  try {
    txt = await fs.readFile(file, 'utf8');
  } catch {
    return out;
  }
  for (const line of txt.split('\n')) {
    if (!line.trim()) continue;
    try {
      const rec = JSON.parse(line);
      out.set(rec[key], rec);
    } catch {
      // Skip a truncated line rather than losing the whole file.
    }
  }
  return out;
}

/**
 * Merge `records` into `file`, keeping anything already on disk.
 *
 * Fields are merged per record so a partial update (say, only the gold price)
 * never blanks out fields written by an earlier run.
 *
 * @param {string} file Target .jsonl path
 * @param {Iterable<object>} records Records to merge in
 * @param {string} [key] Identifying field, also the sort key
 * @returns {Promise<{added:number,total:number}>}
 */
export async function mergeJsonl(file, records, key = 'd') {
  const existing = await readJsonl(file, key);
  const before = existing.size;

  for (const rec of records) {
    const id = rec[key];
    if (id == null) continue;
    const prev = existing.get(id);
    existing.set(id, prev ? { ...prev, ...rec } : rec);
  }

  const lines = [...existing.values()]
    .sort((a, b) => (a[key] < b[key] ? -1 : a[key] > b[key] ? 1 : 0))
    .map((r) => JSON.stringify(r));

  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, lines.join('\n') + '\n');
  return { added: existing.size - before, total: existing.size };
}
