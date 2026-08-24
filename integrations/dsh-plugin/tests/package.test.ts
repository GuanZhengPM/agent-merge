import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const packagePath = fileURLToPath(new URL('../package.json', import.meta.url));
const patchPath = fileURLToPath(new URL('../cordis.patch.yml', import.meta.url));

test('package declares an installable dsh bundle', async () => {
  const manifest = JSON.parse(await readFile(packagePath, 'utf8')) as {
    dependencies?: Record<string, string>;
    dsh?: { bundle?: { patch?: string } };
    files?: string[];
  };

  assert.equal(manifest.dsh?.bundle?.patch, './cordis.patch.yml');
  assert.ok(manifest.files?.includes('cordis.patch.yml'));
  assert.equal(manifest.dependencies?.['@guanzhengpm/agent-merge'], 'workspace:^');
});

test('bundle patch mounts the published plugin with safe defaults', async () => {
  const patch = await readFile(patchPath, 'utf8');
  assert.match(patch, /^\s*- insert:/m);
  assert.match(patch, /^\s+- id: agent-merge$/m);
  assert.match(patch, /^\s+name: dsh-plugin-agent-merge$/m);
  assert.match(patch, /^\s+record: true$/m);
  assert.match(patch, /^\s+tools: true$/m);
});
