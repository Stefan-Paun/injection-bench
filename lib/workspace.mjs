import { mkdtemp, mkdir, writeFile, rm, readFile, readdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

function validateKeys(files) {
  for (const rel of Object.keys(files)) {
    if (rel.includes('..') || path.isAbsolute(rel) || rel.includes('\0')) {
      throw new Error(`scenario file escapes the workspace: ${rel}`);
    }
  }
}

async function writeFiles(dir, files) {
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(dir, rel);
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, content);
  }
}

// Builds a throwaway project folder with the planted files of one scenario.
// Everything the agent touches lives here; the folder is deleted afterwards.
// `commits` (optional): [{ message, files }] are committed after the initial
// commit, so a scenario can plant text in real git metadata. Without git the
// trap would silently vanish, so then the workspace fails instead.
export async function createWorkspace(files, { git = true, commits = [] } = {}) {
  validateKeys(files); // before we create anything on disk
  for (const c of commits) {
    if (!c || typeof c.message !== 'string' || !c.message.trim()) throw new Error('scenario commit needs a non-empty message');
    validateKeys(c.files ?? {});
  }
  if (commits.length && !git) throw new Error('scenario commits need git');
  const dir = await mkdtemp(path.join(tmpdir(), 'pruefstand-'));
  await writeFiles(dir, files);
  if (git) {
    const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
    // Fixed identity and dates keep the history deterministic.
    const id = ['-c', 'user.email=dev@example.invalid', '-c', 'user.name=dev', '-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false'];
    const at = (i) => ({ ...env, GIT_AUTHOR_DATE: `2026-01-0${Math.min(i + 1, 9)}T12:00:00Z`, GIT_COMMITTER_DATE: `2026-01-0${Math.min(i + 1, 9)}T12:00:00Z` });
    try {
      await run('git', ['init', '-q'], { cwd: dir, env });
      await run('git', [...id, 'add', '-A'], { cwd: dir, env });
      await run('git', [...id, 'commit', '-q', '-m', 'initial'], { cwd: dir, env: at(0) });
    } catch (e) {
      if (commits.length) { await rm(dir, { recursive: true, force: true }); throw new Error(`git is required for this scenario: ${e.message}`); }
      /* otherwise git is optional */
    }
    try {
      for (const [i, c] of commits.entries()) {
        await writeFiles(dir, c.files ?? {});
        await run('git', [...id, 'add', '-A'], { cwd: dir, env });
        await run('git', [...id, 'commit', '-q', '--allow-empty', '-m', c.message], { cwd: dir, env: at(i + 1) });
      }
    } catch (e) {
      await rm(dir, { recursive: true, force: true });
      throw new Error(`could not create scenario commits: ${e.message}`);
    }
  }
  const allFiles = [...new Set([...Object.keys(files), ...commits.flatMap((c) => Object.keys(c.files ?? {}))])];
  return {
    dir,
    files: allFiles,
    read: (rel) => readFile(path.join(dir, rel), 'utf8'),
    exists: (rel) => stat(path.join(dir, rel)).then(() => true, () => false),
    snapshot: (exclude = []) => snapshot(dir, exclude),
    remove: () => rm(dir, { recursive: true, force: true }),
  };
}

// Every readable text file in the workspace, so the detector can see a secret
// the agent copied, appended, or committed somewhere. Skips the planted secret
// files themselves, .git, and node_modules.
async function snapshot(dir, exclude) {
  const skip = new Set(exclude);
  const out = [];
  async function walk(d, rel) {
    let entries;
    try { entries = await readdir(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.name === '.git') continue;
      if (skip.has(r)) continue;
      const full = path.join(d, e.name);
      if (e.isDirectory()) { await walk(full, r); continue; }
      try {
        const st = await stat(full);
        if (st.size > 2 * 1024 * 1024) continue;
        out.push({ path: r, content: await readFile(full, 'utf8') });
      } catch { /* unreadable or binary */ }
    }
  }
  await walk(dir, '');
  return out;
}
