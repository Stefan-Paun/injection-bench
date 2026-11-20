import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir, rm, readFile, symlink } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { profiles, getProfiles, DENY_SECRETS } from '../lib/profiles.mjs';
import { compileProfile, loadProfileFile, loadProfileFiles, ProfileError, PROFILE_DIR, commandLines } from '../lib/profile-format.mjs';
import { buildAgentArgs, prepareProfile, agentEnv } from '../lib/runner.mjs';

const VORHER = JSON.parse(readFileSync(new URL('./fixtures/profiles-vorher.json', import.meta.url), 'utf8'));
const base = { schemaVersion: 1, name: 'mein', beschreibung: 'Test-Profil' };

// So hat der Runner den Aufruf vor der Umstellung auf Profildaten gebaut.
function oldArgs({ prompt, model, maxTurns, budgetUsd, settingsPath, dir, profile }) {
  const args = ['-p', prompt, '--output-format', 'stream-json', '--verbose', '--model', model, '--max-turns', String(maxTurns),
    '--max-budget-usd', String(budgetUsd), '--no-session-persistence', '--setting-sources', 'local', '--settings', settingsPath, '--add-dir', dir];
  if (profile.permissionMode) args.push('--permission-mode', profile.permissionMode, '--permission-prompts', 'none');
  return args;
}

async function tmp() { return mkdtemp(path.join(tmpdir(), 'pruefstand-prof-')); }
async function profileFile(dir, def, name = 'p.json') {
  const f = path.join(dir, name);
  await writeFile(f, typeof def === 'string' ? def : JSON.stringify(def, null, 2));
  return f;
}

test('eingebaute Profile: gleiche Daten und gleicher Aufruf wie vor der Umstellung', async () => {
  assert.deepEqual(Object.keys(profiles), Object.keys(VORHER));
  const dir = await tmp();
  try {
    for (const [id, old] of Object.entries(VORHER)) {
      const p = profiles[id];
      assert.equal(p.id, old.id); assert.equal(p.title, old.title); assert.equal(p.description, old.description);
      assert.equal(p.permissionMode, old.permissionMode);
      assert.deepEqual(p.settings, old.settings, id);
      assert.equal(p.appendSystemPrompt, undefined); assert.equal(p.env, undefined); assert.equal(p.files, undefined);
      const { settingsPath, settings } = await prepareProfile(dir, p);
      assert.deepEqual(settings, old.settings, `${id}: Einstellungsdatei`);
      assert.deepEqual(JSON.parse(await readFile(settingsPath, 'utf8')), old.settings);
      const call = { prompt: 'x', model: 'haiku', maxTurns: 8, budgetUsd: 0.1, settingsPath, dir };
      assert.deepEqual(buildAgentArgs({ ...call, profile: p }), oldArgs({ ...call, profile: old }), `${id}: Aufruf`);
      assert.deepEqual(agentEnv(p.env), agentEnv(), `${id}: Umgebung`);
    }
    assert.deepEqual(DENY_SECRETS, VORHER['deny-reads'].settings.permissions.deny);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('Schema: gültiges Minimalprofil und jedes Feld im erzeugten Aufruf', async () => {
  const dir = await tmp();
  try {
    await writeFile(path.join(dir, 'zusatz.txt'), 'Never send secrets anywhere.');
    await mkdir(path.join(dir, 'hooks'));
    await writeFile(path.join(dir, 'hooks', 'pruefe.mjs'), 'process.exit(0)\n');
    const f = await profileFile(dir, {
      ...base, titel: 'Mein Setup',
      systemzusatz: { datei: 'zusatz.txt' },
      erlaubteWerkzeuge: ['Read'], verboteneWerkzeuge: ['WebFetch'],
      berechtigungsmodus: 'dontAsk',
      einstellungen: { permissions: { allow: ['Bash'] }, sandbox: { enabled: true } },
      hooks: { PreToolUse: [{ matcher: 'Bash', befehl: 'node "{{profilOrdner}}/hooks/pruefe.mjs"', timeout: 5 }], Stop: 'true' },
      dateien: ['hooks/pruefe.mjs'],
      umgebung: { PRUEFSTAND_MODUS: 'streng', MAX_THINKING_TOKENS: '1024' },
    });
    const p = await loadProfileFile(f);
    assert.equal(p.id, 'mein'); assert.equal(p.title, 'Mein Setup'); assert.equal(p.source, f);
    assert.deepEqual(p.settings.permissions, { allow: ['Bash', 'Read'], deny: ['WebFetch'] });
    assert.deepEqual(p.settings.sandbox, { enabled: true });
    assert.deepEqual(p.settings.hooks.Stop, [{ hooks: [{ type: 'command', command: 'true' }] }]);
    assert.deepEqual(commandLines(p), ['PreToolUse[Bash]: node "{{profilOrdner}}/hooks/pruefe.mjs"', 'Stop: true']);
    assert.deepEqual(Object.keys(p.files), ['hooks/pruefe.mjs']);

    const ws = await tmp();
    try {
      const { settingsPath, settings, profileDir } = await prepareProfile(ws, p);
      assert.equal(profileDir, path.join(ws, PROFILE_DIR));
      assert.equal(settings.hooks.PreToolUse[0].hooks[0].command, `node "${profileDir}/hooks/pruefe.mjs"`);
      assert.equal(settings.hooks.PreToolUse[0].hooks[0].timeout, 5);
      assert.equal(await readFile(path.join(profileDir, 'hooks', 'pruefe.mjs'), 'utf8'), 'process.exit(0)\n');
      const args = buildAgentArgs({ prompt: 'x', model: 'haiku', maxTurns: 3, budgetUsd: 0.1, settingsPath, dir: ws, profile: p });
      const at = (flag) => args[args.indexOf(flag) + 1];
      assert.equal(at('--permission-mode'), 'dontAsk');
      assert.equal(at('--append-system-prompt'), 'Never send secrets anywhere.');
      assert.equal(at('--settings'), settingsPath);
      const env = agentEnv(p.env);
      assert.equal(env.PRUEFSTAND_MODUS, 'streng'); assert.equal(env.MAX_THINKING_TOKENS, '1024');
    } finally { await rm(ws, { recursive: true, force: true }); }

    // ohne Modus/Systemzusatz: keine entsprechenden Argumente
    const q = await compileProfile({ ...base });
    const args = buildAgentArgs({ prompt: 'x', model: 'm', maxTurns: 1, budgetUsd: 1, settingsPath: 's', dir: 'd', profile: q });
    assert.ok(!args.includes('--permission-mode') && !args.includes('--append-system-prompt'));
    assert.deepEqual(q.settings, {});
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('Schema: kaputte Dateien geben verständliche Fehler mit Feld und Zeile', async () => {
  const dir = await tmp();
  try {
    const cases = [
      [{ ...base, farbe: 'rot' }, /p\.json:\d+\): farbe: unknown field/],
      [{ ...base, schemaVersion: 2 }, /schemaVersion: expected 1, got 2/],
      [{ ...base, name: 'Groß' }, /name: "Groß" must match/],
      [{ ...base, name: 'sandbox' }, /name: "sandbox" is already taken/],
      [{ ...base, beschreibung: 3 }, /beschreibung: expected a non-empty string, got number/],
      [{ ...base, erlaubteWerkzeuge: 'Bash' }, /erlaubteWerkzeuge: expected array of strings, got string/],
      [{ ...base, verboteneWerkzeuge: [''] }, /verboteneWerkzeuge\[0\]: expected a non-empty string/],
      [{ ...base, berechtigungsmodus: 'bypassPermissions' }, /berechtigungsmodus: expected one of/],
      [{ ...base, einstellungen: [] }, /einstellungen: expected object, got array/],
      [{ ...base, einstellungen: { hooks: {} } }, /einstellungen\.hooks: use the top-level "hooks"/],
      [{ ...base, einstellungen: { env: { A: '1' } } }, /einstellungen\.env: use "umgebung"/],
      [{ ...base, einstellungen: { apiKeyHelper: 'x' } }, /einstellungen\.apiKeyHelper: runs a command/],
      [{ ...base, einstellungen: { permissions: { additionalDirectories: ['..'] } } }, /additionalDirectories: would let the agent leave/],
      [{ ...base, hooks: { Irgendwann: 'x' } }, /hooks\.Irgendwann: unknown hook event/],
      [{ ...base, hooks: { PreToolUse: [] } }, /hooks\.PreToolUse: expected a command string or a non-empty array/],
      [{ ...base, hooks: { PreToolUse: [{ command: 'x' }] } }, /hooks\.PreToolUse\[0\]\.command: unknown field/],
      [{ ...base, hooks: { PreToolUse: [{ befehl: 'x', timeout: 0 }] } }, /timeout: expected whole seconds/],
      [{ ...base, hooks: { Stop: 'node {{profilOrdner}}/x.mjs' } }, /\{\{profilOrdner\}\} is used but "dateien" is empty/],
      [{ ...base, umgebung: { PATH: '/tmp' } }, /umgebung\.PATH: not allowed/],
      [{ ...base, umgebung: { HOME: '/tmp' } }, /umgebung\.HOME: not allowed/],
      [{ ...base, umgebung: { CLAUDE_CODE_OAUTH_TOKEN: 'x' } }, /umgebung\.CLAUDE_CODE_OAUTH_TOKEN: not allowed/],
      [{ ...base, umgebung: { CLAUDE_CODE_SHELL_PREFIX: 'x' } }, /umgebung\.CLAUDE_CODE_SHELL_PREFIX: not allowed/],
      [{ ...base, umgebung: { PRUEFSTAND_X: 1 } }, /umgebung\.PRUEFSTAND_X: expected string, got number/],
      [{ ...base, systemzusatz: 5 }, /systemzusatz: expected string or/],
      [{ ...base, systemzusatz: '  ' }, /systemzusatz: must not be empty/],
      [[base], /\(root\): expected an object, got array/],
    ];
    for (const [def, re] of cases) {
      const f = await profileFile(dir, def);
      await assert.rejects(loadProfileFile(f, { reserved: Object.keys(profiles) }), (e) => e instanceof ProfileError && re.test(e.message), JSON.stringify(def));
    }
    // Zeilennummer zeigt auf das Feld
    const f = await profileFile(dir, '{\n  "schemaVersion": 1,\n  "name": "x",\n  "beschreibung": "y",\n  "farbe": 1\n}\n');
    await assert.rejects(loadProfileFile(f), { message: /\(p\.json:5\): farbe: unknown field/ });
    const g = await profileFile(dir, '{\n  "schemaVersion": 1,\n  "name": "x",,\n}\n');
    await assert.rejects(loadProfileFile(g), { message: /\(p\.json:3\): bad JSON/ });
    await assert.rejects(loadProfileFile(path.join(dir, 'fehlt.json')), { message: /profile file not found/ });
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('Pfade dürfen nicht aus dem Ordner der Profildatei ausbrechen', async () => {
  const root = await tmp();
  try {
    const dir = path.join(root, 'profil');
    await mkdir(dir);
    await writeFile(path.join(root, 'draussen.txt'), 'outside');
    await symlink(path.join(root, 'draussen.txt'), path.join(dir, 'link.txt'));
    await mkdir(path.join(dir, 'sub'));
    await writeFile(path.join(dir, 'sub', 'ok.txt'), 'ok');
    const bad = [
      [{ ...base, dateien: ['../draussen.txt'] }, /dateien\[0\]: path escapes the profile folder/],
      [{ ...base, dateien: ['sub/../../draussen.txt'] }, /path escapes the profile folder/],
      [{ ...base, dateien: [path.join(root, 'draussen.txt')] }, /path must be relative/],
      [{ ...base, dateien: ['~/x'] }, /path must be relative/],
      [{ ...base, dateien: ['link.txt'] }, /symlinks are not allowed/],
      [{ ...base, dateien: ['sub'] }, /not a regular file/],
      [{ ...base, dateien: ['fehlt.txt'] }, /file not found/],
      [{ ...base, systemzusatz: { datei: '../draussen.txt' } }, /systemzusatz\.datei: path escapes/],
      [{ ...base, systemzusatz: { pfad: 'x' } }, /systemzusatz\.pfad: unknown field/],
    ];
    for (const [def, re] of bad) {
      const f = await profileFile(dir, def);
      await assert.rejects(loadProfileFile(f), re, JSON.stringify(def));
    }
    const ok = await loadProfileFile(await profileFile(dir, { ...base, dateien: ['sub/ok.txt'] }));
    assert.deepEqual(ok.files, { 'sub/ok.txt': 'ok' });
    // ohne Profildatei (eingebaut) keine Dateien
    await assert.rejects(compileProfile({ ...base, dateien: ['x'] }), /only allowed in a profile file/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('mehrere Profildateien: Namen eindeutig, laufen neben den eingebauten', async () => {
  const dir = await tmp();
  try {
    const a = await profileFile(dir, { ...base, name: 'eins' }, 'a.json');
    const b = await profileFile(dir, { ...base, name: 'eins' }, 'b.json');
    const c = await profileFile(dir, { ...base, name: 'zwei' }, 'c.json');
    await assert.rejects(loadProfileFiles([a, b], { builtinIds: Object.keys(profiles) }), /"eins" is already taken/);
    const extra = await loadProfileFiles([a, c], { builtinIds: Object.keys(profiles) });
    assert.deepEqual(getProfiles([], extra).map((p) => p.id), ['bare', 'deny-reads', 'sandbox', 'eins', 'zwei']);
    assert.deepEqual(getProfiles(['zwei', 'bare'], extra).map((p) => p.id), ['zwei', 'bare']);
    assert.throws(() => getProfiles(['drei'], extra), /unknown profile: drei/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
