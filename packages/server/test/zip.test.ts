import { describe, expect, it } from 'vitest';
import { zipSync } from 'fflate';
import { manifestHash, readZip } from '../src/zip.js';

const enc = (s: string) => new TextEncoder().encode(s);

describe('manifestHash', () => {
  it('is identical for identical content regardless of zip entry order or timestamps', () => {
    const zipA = zipSync({ 'index.json': enc('{}'), 'iframe.html': enc('<html>') });
    const zipB = zipSync(
      { 'iframe.html': enc('<html>'), 'index.json': enc('{}') },
      { mtime: new Date('2001-01-01') },
    );
    expect(manifestHash(readZip(zipA))).toBe(manifestHash(readZip(zipB)));
  });

  it('changes when any file content changes', () => {
    const zipA = zipSync({ 'iframe.html': enc('<html>a') });
    const zipB = zipSync({ 'iframe.html': enc('<html>b') });
    expect(manifestHash(readZip(zipA))).not.toBe(manifestHash(readZip(zipB)));
  });
});

describe('readZip', () => {
  it('rejects path traversal', () => {
    const evil = zipSync({ '../evil.txt': enc('x') });
    expect(() => readZip(evil)).toThrow(/Unsafe path/);
  });
});
