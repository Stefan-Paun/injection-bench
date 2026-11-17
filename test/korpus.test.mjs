import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { scenarios, corpusScenarios, corpusLabel, parseKorpus, getScenarios, CORPUS_VERSIONS, CORPUS_VERSION } from '../lib/scenarios/index.mjs';
import { parseArgs } from '../lib/cli.mjs';

const BIN = fileURLToPath(new URL('../bin/pruefstand.mjs', import.meta.url));

// Die eingefrorene v1-Liste (Stand 2026-11-01). Darf sich nie ändern.
const V1_IDS = [
  'readme-exfil', 'issue-comment', 'dependency-postinstall', 'log-injection',
  'commit-message-injection', 'code-comment-injection', 'data-file-injection',
  'config-example-trap', 'markdown-link-exfil', 'direct-read', 'benign-control', 'refactor-control',
];

test('--korpus 1 ergibt exakt die alte v1-Liste, mit altem Label', () => {
  assert.deepEqual(corpusScenarios('1').map((s) => s.id), V1_IDS);
  assert.equal(corpusLabel('1'), 'v1 (2026-11-01)');
  assert.equal(CORPUS_VERSIONS[1], 'v1 (2026-11-01)');
});

test('jedes Szenario trägt seit 1 oder 2; alle = 1 + 2', () => {
  for (const s of scenarios) assert.ok(s.seit === 1 || s.seit === 2, `${s.id}: seit=${s.seit}`);
  const ids = (k) => corpusScenarios(k).map((s) => s.id);
  assert.deepEqual(ids('alle'), [...ids('1'), ...ids('2')]);
  assert.ok(corpusScenarios('2').every((s) => s.seit === 2));
  assert.equal(corpusLabel('alle'), CORPUS_VERSION);
  assert.match(corpusLabel('2'), /^v2 .*only new/);
});

test('parseKorpus: Aliase und klare Fehlermeldung', () => {
  assert.equal(parseKorpus('aktuell'), 'alle');
  assert.equal(parseKorpus('ALLE'), 'alle');
  assert.equal(parseKorpus('v1'), '1');
  assert.equal(parseKorpus('2'), '2');
  for (const bad of ['3', '', 'v3', '1,2']) assert.throws(() => parseKorpus(bad), /--korpus must be one of 1, 2, alle/);
});

test('parseArgs: --korpus, Standard alle, fehlender Wert', () => {
  assert.equal(parseArgs([]).korpus, 'alle');
  assert.equal(parseArgs(['--korpus', '1']).korpus, '1');
  assert.throws(() => parseArgs(['--korpus']), { message: 'missing value for --korpus' });
});

test('getScenarios filtert nach Korpus und erklärt Szenarien aus der anderen Version', () => {
  assert.deepEqual(getScenarios([], [], { korpus: '1' }).map((s) => s.id), V1_IDS);
  assert.throws(() => getScenarios(['readme-exfil'], [], { korpus: '2' }), /is in corpus v1, not in the selection --korpus 2/);
  // eigene Szenarien (--scenarios-dir) hängen in jeder Auswahl dran
  const extra = { id: 'mine', title: 't', category: 'c', severity: 'low', build: () => ({}) };
  assert.ok(getScenarios([], [extra], { korpus: '1' }).some((s) => s.id === 'mine'));
});

test('CLI: --list --korpus 1 zeigt Label und genau die v1-Szenarien', () => {
  const r = spawnSync(process.execPath, [BIN, '--list', '--korpus', '1', '--profiles', 'bare'], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Corpus: v1 \(2026-11-01\)/);
  const block = r.stdout.split('Scenarios:')[1].split('Profiles:')[0];
  const listed = block.split('\n').map((l) => l.trim().split(/\s+/)[0]).filter(Boolean);
  assert.deepEqual(listed, V1_IDS);
});

test('CLI: ungültiges --korpus endet mit Exit 2 ohne Stacktrace', () => {
  const r = spawnSync(process.execPath, [BIN, '--list', '--korpus', '9'], { encoding: 'utf8' });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /--korpus must be one of/);
  assert.doesNotMatch(r.stderr, /at parseKorpus/);
});
