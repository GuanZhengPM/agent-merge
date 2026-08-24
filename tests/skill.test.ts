import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { basename, dirname } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

// Keep the shipped skill valid against the Agent Skills open standard
// (https://agentskills.io/specification), so it stays loadable by every
// adopter: Claude Code, Codex CLI, pi, Gemini CLI, Cursor, OpenCode, …
const SKILL_PATH = fileURLToPath(
  new URL('../integrations/skill/agent-merge/SKILL.md', import.meta.url),
);

async function readSkill(): Promise<{ frontmatter: Map<string, string>; body: string }> {
  const raw = await readFile(SKILL_PATH, 'utf8');
  const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(raw);
  assert.ok(match, 'SKILL.md must start with a YAML frontmatter block');
  const frontmatter = new Map<string, string>();
  for (const line of (match[1] as string).split('\n')) {
    const field = /^([a-z-]+):\s*(.*)$/.exec(line);
    if (field) frontmatter.set(field[1] as string, field[2] as string);
  }
  return { frontmatter, body: match[2] as string };
}

test('skill name follows the spec and matches its directory', async () => {
  const { frontmatter } = await readSkill();
  const name = frontmatter.get('name');
  assert.ok(name, 'name is required');
  assert.ok(name.length <= 64, 'name must be at most 64 characters');
  assert.match(name, /^[a-z0-9]+(-[a-z0-9]+)*$/, 'lowercase alphanumerics and single hyphens only');
  assert.equal(name, basename(dirname(SKILL_PATH)), 'name must match the parent directory');
});

test('skill description is present, bounded, and says when to use it', async () => {
  const { frontmatter } = await readSkill();
  const description = frontmatter.get('description');
  assert.ok(description !== undefined && description.length > 0, 'description is required');
  assert.ok(description.length <= 1024, 'description must be at most 1024 characters');
  assert.match(description, /Use when/i, 'description should state when to use the skill');
});

test('skill body exists and stays within the recommended size', async () => {
  const { body } = await readSkill();
  assert.ok(body.trim().length > 0, 'body must not be empty');
  assert.ok(body.split('\n').length < 500, 'keep SKILL.md under 500 lines (spec recommendation)');
  assert.ok(!body.includes('weft'), 'no stale project names');
});

test('compatibility field, when present, stays within spec bounds', async () => {
  const { frontmatter } = await readSkill();
  const compatibility = frontmatter.get('compatibility');
  if (compatibility !== undefined) {
    assert.ok(compatibility.length >= 1 && compatibility.length <= 500);
  }
});
