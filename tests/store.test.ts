import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { CorruptObjectError, ObjectNotFoundError } from '../src/errors.ts';
import { sha256Hex } from '../src/hash.ts';
import { FsObjectStore } from '../src/store/fs-store.ts';
import { MemoryObjectStore } from '../src/store/object-store.ts';
import type { ObjectStore } from '../src/store/object-store.ts';

const encode = (text: string): Uint8Array => new TextEncoder().encode(text);

async function withFsStore(run: (store: FsObjectStore, root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'agent-merge-store-'));
  try {
    await run(new FsObjectStore(join(root, 'objects')), join(root, 'objects'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function exerciseStore(store: ObjectStore): Promise<void> {
  const bytes = encode('agent-merge event\n{"hello":"world"}');
  const id = await store.put(bytes);
  assert.equal(id, sha256Hex(bytes));
  assert.equal(await store.has(id), true);
  assert.deepEqual([...(await store.get(id))], [...bytes]);

  // idempotent put
  assert.equal(await store.put(bytes), id);

  const other = await store.put(encode('agent-merge event\n{"other":true}'));
  const listed: string[] = [];
  for await (const listedId of store.list()) listed.push(listedId);
  assert.deepEqual(listed.sort(), [id, other].sort());

  const missing = '0'.repeat(64);
  assert.equal(await store.has(missing), false);
  await assert.rejects(store.get(missing), ObjectNotFoundError);
}

test('MemoryObjectStore stores, lists, and misses correctly', async () => {
  await exerciseStore(new MemoryObjectStore());
});

test('MemoryObjectStore returns copies, not aliases', async () => {
  const store = new MemoryObjectStore();
  const bytes = encode('abc');
  const id = await store.put(bytes);
  bytes[0] = 0; // mutate caller's buffer after put
  const fetched = await store.get(id);
  assert.equal(new TextDecoder().decode(fetched), 'abc');
});

test('FsObjectStore stores, lists, and misses correctly', async () => {
  await withFsStore(async (store) => exerciseStore(store));
});

test('FsObjectStore detects tampered objects on read', async () => {
  await withFsStore(async (store, root) => {
    const id = await store.put(encode('agent-merge event\n{"a":1}'));
    const path = join(root, id.slice(0, 2), id.slice(2));
    const original = await readFile(path);
    await writeFile(path, Buffer.concat([original, Buffer.from(' ')]));
    await assert.rejects(store.get(id), CorruptObjectError);
  });
});

test('FsObjectStore.list on a store that was never written is empty', async () => {
  await withFsStore(async (store) => {
    const listed: string[] = [];
    for await (const id of store.list()) listed.push(id);
    assert.deepEqual(listed, []);
  });
});
