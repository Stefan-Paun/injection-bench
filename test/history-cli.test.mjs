import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, symlinkSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseVerlaufArgs, readReportDir } from '../lib/history-cli.mjs';

const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'pruefstand.mjs');
const root = mkdtempSync(path.join(tmpdir(), 'pruefstand-verlauf-'));
test.after(() => rmSync(root, { recursive: true, force: true }));

const R = (scenario, outcome, over = {}) => ({ scenario, profile: 'bare', model: 'm', severity: 'high', outcome, taskDone: null, ...over });
let n = 0;
const folder = (reports) => {
  const d = path.join(root, `d${n++}`);
  mkdirSync(d);
  for (const [name, content] of Object.entries(reports)) writeFileSync(path.join(d, name), typeof content === 'string' ? content : JSON.stringify({ corpusVersion: 'v1', results: content }));
  return d;
};
const run = (...args) => spawnSync(process.execPath, [BIN, 'verlauf', ...args], { encoding: 'utf8', cwd: root });

test('parseVerlaufArgs: Standardwerte und Fehler', () => {
  assert.deepEqual(parseVerlaufArgs([]), { dir: 'berichte', aus: path.join('berichte', 'verlauf.html'), format: 'html', help: false });
  assert.equal(parseVerlaufArgs(['x', '--format', 'json']).aus, '-');
  assert.equal(parseVerlaufArgs(['x', '--aus', 'o.html']).aus, 'o.html');
  assert.throws(() => parseVerlaufArgs(['--format', 'pdf']), /html or json/);
  assert.throws(() => parseVerlaufArgs(['a', 'b']), /only one folder/);
  assert.throws(() => parseVerlaufArgs(['--aus']), /needs a value/);
  assert.throws(() => parseVerlaufArgs(['--nope']), /unknown option/);
});

test('verlauf schreibt HTML in den Ordner; die eigene Ausgabe wird beim nächsten Mal nicht gelesen', () => {
  const d = folder({ '2026-11-01.json': [R('a', 'clean')], '2026-11-02.json': [R('a', 'leaked')], 'notiz.txt': 'nicht json' });
  const r = run(path.basename(d));
  assert.equal(r.status, 0, r.stderr);
  const out = path.join(d, 'verlauf.html');
  assert.ok(existsSync(out));
  assert.match(readFileSync(out, 'utf8'), /Prüfstand-Verlauf/);
  assert.match(r.stdout, /2 reports, 1 change/);
  assert.ok(!r.stdout.includes(root), 'kein absoluter Pfad in der Ausgabe');
  const again = run(path.basename(d));
  assert.equal(again.status, 0);
  assert.equal(again.stderr, '');
});

test('--format json auf stdout, und eine JSON-Verlaufsdatei im Ordner stört nicht', () => {
  const d = folder({ '2026-11-01.json': [R('a', 'clean')], '2026-11-02.json': [R('a', 'clean')] });
  const r = run(path.basename(d), '--format', 'json');
  assert.equal(r.status, 0, r.stderr);
  const h = JSON.parse(r.stdout);
  assert.equal(h.kind, 'pruefstand-verlauf');
  assert.equal(h.berichte.length, 2);
  writeFileSync(path.join(d, 'verlauf.json'), r.stdout);
  const again = run(path.basename(d), '--format', 'json');
  assert.equal(again.status, 0);
  assert.equal(JSON.parse(again.stdout).berichte.length, 2);
  assert.equal(again.stderr, '');
});

test('kaputte Datei: Warnung auf stderr, Seite trotzdem', () => {
  const d = folder({ '2026-11-01.json': [R('a', 'clean')], '2026-11-02.json': '{kaputt', '2026-11-03.json': [R('a', 'clean')] });
  const r = run(path.basename(d), '--aus', '-');
  assert.equal(r.status, 0);
  assert.match(r.stderr, /2026-11-02\.json/);
  assert.match(r.stdout, /<!DOCTYPE html>/);
});

test('ein Bericht: Seite „Noch kein Verlauf“, Exit 0', () => {
  const d = folder({ '2026-11-01.json': [R('a', 'clean')] });
  const r = run(path.basename(d), '--aus', path.join('ausgabe', 'v.html'));
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /only one report/);
  assert.match(readFileSync(path.join(root, 'ausgabe', 'v.html'), 'utf8'), /Noch kein Verlauf/);
});

test('Exit 2: Ordner fehlt, leer oder nur Kaputtes', () => {
  assert.equal(run('gibt-es-nicht').status, 2);
  const leer = folder({});
  const r = run(path.basename(leer));
  assert.equal(r.status, 2);
  assert.match(r.stderr, /no \*\.json report/);
  const kaputt = folder({ 'a.json': '{', 'b.json': '[]' });
  const k = run(path.basename(kaputt));
  assert.equal(k.status, 2);
  assert.match(k.stderr, /none of the 2/);
  assert.ok(!existsSync(path.join(kaputt, 'verlauf.html')));
});

test('Symlinks werden nicht verfolgt', async (t) => {
  const d = folder({ '2026-11-01.json': [R('a', 'clean')] });
  const outside = path.join(root, 'draussen.json');
  writeFileSync(outside, JSON.stringify({ results: [R('geheim', 'clean')] }));
  try { symlinkSync(outside, path.join(d, '2026-11-02.json')); } catch { t.skip('keine Symlinks auf diesem System'); return; }
  const { files, notes } = await readReportDir(d);
  assert.deepEqual(files.map((f) => f.name), ['2026-11-01.json']);
  assert.match(notes.join('\n'), /symlink/);
});

test('Hilfe im Hauptprogramm erwähnt verlauf', () => {
  const r = spawnSync(process.execPath, [BIN, '--help'], { encoding: 'utf8' });
  assert.match(r.stdout, /pruefstand verlauf/);
  const h = run('--help');
  assert.equal(h.status, 0);
  assert.match(h.stdout, /--format <html\|json>/);
});

test('Review-Fix: Ausgabe folgt keinem Symlink, Schreibfehler ohne Stacktrace', (t) => {
  const d = folder({ '2026-11-01.json': [R('a', 'clean')], '2026-11-02.json': [R('a', 'clean')] });
  const victim = path.join(root, 'opfer.txt');
  writeFileSync(victim, 'unverändert');
  try { symlinkSync(victim, path.join(d, 'verlauf.html')); } catch { t.skip('keine Symlinks auf diesem System'); return; }
  const r = run(path.basename(d));
  assert.equal(r.status, 2);
  assert.match(r.stderr, /symlink, not followed/);
  assert.equal(readFileSync(victim, 'utf8'), 'unverändert');
  mkdirSync(path.join(d, 'ordner.html'));
  const w = run(path.basename(d), '--aus', path.join(path.basename(d), 'ordner.html'));
  assert.equal(w.status, 2);
  assert.match(w.stderr, /not a regular file/);
  assert.ok(!/\n\s+at /.test(w.stderr), 'kein Stacktrace');
});
