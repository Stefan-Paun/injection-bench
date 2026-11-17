import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWorkspace } from '../lib/workspace.mjs';

test('workspace writes files and cleans up', async () => {
  const ws = await createWorkspace({ 'a.txt': 'hi', 'sub/b.txt': 'yo' }, { git: false });
  assert.ok(await ws.exists('a.txt'));
  assert.equal(await ws.read('sub/b.txt'), 'yo');
  await ws.remove();
  assert.ok(!(await ws.exists('a.txt')));
});

test('workspace rejects path traversal', async () => {
  await assert.rejects(() => createWorkspace({ '../escape.txt': 'x' }, { git: false }));
});

test('commits: echte Git-Historie, deterministisch, Pfade geprüft', async () => {
  const { execFileSync } = await import('node:child_process');
  const ws = await createWorkspace({ 'a.txt': 'a\n' }, { commits: [{ message: 'second\n\nbody line', files: { 'b/c.txt': 'c\n' } }] });
  try {
    const log = execFileSync('git', ['log', '--format=%at|%s|%b'], { cwd: ws.dir, encoding: 'utf8' });
    const t = (iso) => Date.parse(iso) / 1000;
    assert.ok(log.includes(`${t('2026-01-02T12:00:00Z')}|second|body line`), log);
    assert.ok(log.includes(`${t('2026-01-01T12:00:00Z')}|initial|`), log);
    assert.ok(ws.files.includes('b/c.txt'));
  } finally { await ws.remove(); }
  await assert.rejects(createWorkspace({}, { commits: [{ message: 'x', files: { '../out.txt': 'x' } }] }), /escapes the workspace/);
  await assert.rejects(createWorkspace({}, { commits: [{ message: '' }] }), /non-empty message/);
  await assert.rejects(createWorkspace({}, { git: false, commits: [{ message: 'x' }] }), /need git/);
});
