import { randomUUID } from 'node:crypto';
import { rename, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export function isErrnoException(err: unknown, code: string): boolean {
  return err instanceof Error && (err as NodeJS.ErrnoException).code === code;
}

export async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (err) {
    if (isErrnoException(err, 'ENOENT') || isErrnoException(err, 'ENOTDIR')) return false;
    throw err;
  }
}

/**
 * Write `content` to `path` atomically: write a temp file in the same
 * directory, then rename over the destination. Readers never observe a
 * partially written file.
 */
export async function writeAtomic(path: string, content: string | Uint8Array): Promise<void> {
  const tmp = join(dirname(path), `.tmp-${randomUUID()}`);
  await writeFile(tmp, content);
  await rename(tmp, path);
}
