import { unzipSync, zipSync } from 'fflate';
import fs from 'node:fs';
import path from 'node:path';
import {
  ANCHOR_MANIFEST_FILE,
  SHEET_TAG,
  type AnchorManifest,
  type StoryKind,
} from '@igility/greenroom-shared';
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
  subtype?: string;
  title?: string;
  name?: string;
  importPath?: string;
  exportName?: string;
  tags?: string[];
}

export interface IndexedStory {
  /** The component's own title, without the variant name appended. */
  componentTitle?: string;
  storyId: string;
  title: string;
  importPath: string;
  kind: StoryKind;
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
    // Storybook 10 emits attached tests as `type:'story'` with `subtype:'test'`.
    // They are not review units: ingesting them puts test cases in the reviewer's
    // batch-approve set and in the agent's work queue, and — because a test repeats
    // its parent story's exportName verbatim — they collide on any identity keyed
    // by (importPath, exportName). Storybook 9 emits no `subtype` while still
    // declaring the same index version, so an absent subtype must read as a story.
    if (entry.subtype && entry.subtype !== 'story') continue;
    stories.push({
      storyId,
      title: [entry.title, entry.name].filter(Boolean).join(' / ') || storyId,
      // The component this variant belongs to, unflattened. The reviewer judges the
      // component; the variant is which rendition happened to be on screen.
      componentTitle: entry.title ?? '',
      importPath: entry.importPath ?? '',
      // Storybook carries story tags into index.json, so a sheet declares itself
      // in the build rather than needing a manifest we would have to keep in sync.
      kind: entry.tags?.includes(SHEET_TAG) ? 'sheet' : 'story',
    });
  }
  return stories;
}

/**
 * The build's own list of the anchors it contains, when it ships one.
 *
 * Anchors exist only once a story has rendered, so an archive cannot be interrogated for
 * them without executing it. A host that writes this file answers the question
 * statically, and that is what lets an upload be refused for dropping an anchor a client
 * has commented on.
 *
 * Absent is a normal answer, not an error: the check simply does not run. Malformed is
 * ALSO treated as absent rather than fatal — a broken manifest must not be able to block
 * a deploy, because the failure it would cause is worse than the check it disables, and
 * a host is free to emit nothing at all.
 */
export function parseAnchorManifest(entries: ZipEntries): AnchorManifest | null {
  const raw = entries[ANCHOR_MANIFEST_FILE];
  if (!raw) return null;
  try {
    const parsed = JSON.parse(new TextDecoder().decode(raw)) as AnchorManifest;
    if (!parsed || typeof parsed.anchors !== 'object' || parsed.anchors === null) return null;
    const anchors: Record<string, string[]> = {};
    for (const [storyId, list] of Object.entries(parsed.anchors)) {
      if (Array.isArray(list)) anchors[storyId] = list.map(String).filter(Boolean);
    }
    return { anchors };
  } catch {
    return null;
  }
}
