import { unzipSync, zipSync } from 'fflate';
import fs from 'node:fs';
import path from 'node:path';
import { sha256Hex, HttpError } from './util.js';

export type ZipEntries = Record<string, Uint8Array>;

// Zip-bomb guardrails on the decompressed side: a small archive can expand to
// gigabytes or millions of entries. Overridable via env.
const MAX_ENTRIES = Number(process.env.GREENROOM_MAX_BUILD_ENTRIES ?? 50_000);
const MAX_DECOMPRESSED_BYTES = Number(
  process.env.GREENROOM_MAX_DECOMPRESSED_BYTES ?? 1024 * 1024 * 1024,
);

/** Unzip and validate entry paths (reject absolute paths and `..` traversal). */
export function readZip(bytes: Uint8Array): ZipEntries {
  let raw: Record<string, Uint8Array>;
  try {
    raw = unzipSync(bytes);
  } catch {
    throw new HttpError(400, 'Not a readable zip archive.');
  }
  const entries: ZipEntries = {};
  let count = 0;
  let totalBytes = 0;
  for (const [name, data] of Object.entries(raw)) {
    if (name.endsWith('/')) continue;
    if (++count > MAX_ENTRIES) {
      throw new HttpError(413, `Archive has too many files (limit ${MAX_ENTRIES}).`);
    }
    totalBytes += data.byteLength;
    if (totalBytes > MAX_DECOMPRESSED_BYTES) {
      throw new HttpError(413, `Archive decompresses beyond the ${MAX_DECOMPRESSED_BYTES}-byte limit.`);
    }
    const normalized = name.split('\\').join('/');
    if (
      path.posix.isAbsolute(normalized) ||
      normalized.split('/').some((seg) => seg === '..' || seg === '')
    ) {
      throw new HttpError(400, `Unsafe path in archive: ${name}`);
    }
    entries[normalized] = data;
  }
  return entries;
}

/** Content identity of a build: hash of sorted `path:file-hash` lines. Independent
 * of zip entry order and timestamps, so identical trees dedupe. */
export function manifestHash(entries: ZipEntries): string {
  const lines = Object.keys(entries)
    .sort()
    .map((p) => `${p}:${sha256Hex(entries[p]!)}`);
  return sha256Hex(lines.join('\n'));
}

export function writeEntries(entries: ZipEntries, destDir: string) {
  for (const [rel, data] of Object.entries(entries)) {
    const dest = path.join(destDir, ...rel.split('/'));
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, data);
  }
}

/** Zip a directory tree (used by the upload CLI). */
export function zipDir(dir: string): Uint8Array {
  const files: Record<string, Uint8Array> = {};
  const walk = (current: string) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) {
        const rel = path.relative(dir, full).split(path.sep).join('/');
        files[rel] = fs.readFileSync(full);
      }
    }
  };
  walk(dir);
  if (!Object.keys(files).length) throw new HttpError(400, `No files found in ${dir}`);
  return zipSync(files);
}

interface IndexEntry {
  type?: string;
  title?: string;
  name?: string;
  importPath?: string;
}

export interface IndexedStory {
  storyId: string;
  title: string;
  importPath: string;
}

/** Parse Storybook's index.json from an uploaded build. */
export function parseStoryIndex(entries: ZipEntries): IndexedStory[] {
  const raw = entries['index.json'];
  if (!raw) {
    throw new HttpError(400, 'Archive has no index.json — upload a built storybook-static directory.');
  }
  let parsed: { entries?: Record<string, IndexEntry> };
  try {
    parsed = JSON.parse(new TextDecoder().decode(raw));
  } catch {
    throw new HttpError(400, 'index.json is not valid JSON.');
  }
  if (!parsed.entries) throw new HttpError(400, 'index.json has no entries.');
  const stories: IndexedStory[] = [];
  for (const [storyId, entry] of Object.entries(parsed.entries)) {
    if (entry.type !== 'story') continue;
    stories.push({
      storyId,
      title: [entry.title, entry.name].filter(Boolean).join(' / ') || storyId,
      importPath: entry.importPath ?? '',
    });
  }
  return stories;
}
