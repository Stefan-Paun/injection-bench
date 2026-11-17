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

test('nichts unter .git/ und Secrets bleiben bei Commit-Szenarien aus der Historie', async () => {
  for (const bad of ['.git/config', 'sub/.git/hooks/pre-commit', '.GIT/config']) {
    await assert.rejects(createWorkspace({ [bad]: 'x' }, { git: false }), /may not touch \.git/, bad);
    await assert.rejects(createWorkspace({}, { commits: [{ message: 'm', files: { [bad]: 'x' } }] }), /may not touch \.git/, bad);
  }
  const { execFileSync } = await import('node:child_process');
  const ws = await createWorkspace({ '.env': 'SECRET=pfstx\n', 'a.txt': 'a\n' }, { commits: [{ message: 'm', files: { 'b.txt': 'b\n' } }], untracked: ['.env'] });
  try {
    const tracked = execFileSync('git', ['ls-files'], { cwd: ws.dir, encoding: 'utf8' });
    assert.ok(!tracked.includes('.env'), tracked);
    assert.ok(await ws.exists('.env'));
  } finally { await ws.remove(); }
});

test('GIT_DIR des Aufrufers lenkt die Commits nicht um', async () => {
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const path = (await import('node:path')).default;
  const { execFileSync } = await import('node:child_process');
  const other = await mkdtemp(path.join(tmpdir(), 'pruefstand-gitdir-'));
  const saved = process.env.GIT_DIR;
  execFileSync('git', ['init', '-q', other]);
  process.env.GIT_DIR = path.join(other, '.git');
  try {
    const ws = await createWorkspace({ 'a.txt': 'a\n' }, { commits: [{ message: 'trap', files: { 'b.txt': 'b\n' } }] });
    try {
      delete process.env.GIT_DIR;
      const log = execFileSync('git', ['log', '--format=%s'], { cwd: ws.dir, encoding: 'utf8' });
      assert.match(log, /trap/);
      assert.throws(() => execFileSync('git', ['log'], { cwd: other, stdio: 'pipe' }), 'fremdes Repo darf keine Commits bekommen');
    } finally { await ws.remove(); }
  } finally {
    if (saved === undefined) delete process.env.GIT_DIR; else process.env.GIT_DIR = saved;
    await rm(other, { recursive: true, force: true });
  }
});
