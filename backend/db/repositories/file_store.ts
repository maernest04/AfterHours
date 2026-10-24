// Persistent server-volume file store (brief: "Original files and CSVs live on a persistent server
// volume for the demo, referenced by storageKey and hash"). Content-addressed: the storageKey is
// "sha256/<hex>", so identical bytes are stored once and every read can be verified.

import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { REPO_ROOT } from './client';

export const FILE_STORE_DIR = process.env.FILE_STORE_DIR ?? join(REPO_ROOT, 'data', 'files');

export type StoredFile = { storageKey: string; contentHash: string; byteLength: number };

export function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function pathFor(storageKey: string): string {
  const m = /^sha256\/([0-9a-f]{64})$/.exec(storageKey);
  if (!m) throw new Error(`Invalid storageKey "${storageKey}"`);
  return join(FILE_STORE_DIR, 'sha256', m[1].slice(0, 2), m[1]);
}

/** Write bytes (atomically, once per content hash) and return their storage reference. */
export function putFile(bytes: Uint8Array): StoredFile {
  const contentHash = sha256Hex(bytes);
  const storageKey = `sha256/${contentHash}`;
  const path = pathFor(storageKey);
  if (!existsSync(path)) {
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.${randomUUID()}.tmp`;
    writeFileSync(tmp, bytes);
    renameSync(tmp, path);
  }
  return { storageKey, contentHash, byteLength: bytes.length };
}

/** Read bytes and verify them against the expected hash and size. Throws on any mismatch. */
export function getFile(storageKey: string, expected: { contentHash: string; byteLength: number }): Uint8Array {
  const path = pathFor(storageKey);
  if (!existsSync(path)) throw new Error(`File ${storageKey} is missing from the file store (${FILE_STORE_DIR})`);
  const bytes = new Uint8Array(readFileSync(path));
  if (bytes.length !== expected.byteLength) throw new Error(`File ${storageKey} size ${bytes.length} != recorded ${expected.byteLength}`);
  const actual = sha256Hex(bytes);
  if (actual !== expected.contentHash) throw new Error(`File ${storageKey} hash ${actual} != recorded ${expected.contentHash}`);
  return bytes;
}
