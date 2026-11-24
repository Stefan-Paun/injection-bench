import { test } from 'node:test';
import assert from 'node:assert/strict';
import { collectReports, analyzeHistory, buildHistory, reportTime, cellStatus, HISTORY_KIND } from '../lib/report/history.mjs';
import { buildReport } from '../lib/report/runs.mjs';

// Kleine, erfundene Berichte. R = ein Ergebnis, file = ein Bericht als Datei-Objekt.
const R = (scenario, profile, outcome, over = {}) => ({ scenario, scenarioTitle: `Titel ${scenario}`, profile, profileTitle: `Profil ${profile}`, model: 'haiku', severity: 'high', outcome, taskDone: null, ...over });
const file = (name, results, over = {}) => ({ name, text: JSON.stringify({ corpusVersion: 'v1', results, ...over }), mtimeMs: 0 });

test('reportTime: createdAt vor Dateiname vor Dateizeit', () => {
  assert.deepEqual(reportTime({ data: { createdAt: '2026-11-20T10:00:00Z' }, name: '2026-01-01.json', mtimeMs: 5 }), { ms: Date.parse('2026-11-20T10:00:00Z'), quelle: 'bericht' });
  assert.deepEqual(reportTime({ data: {}, name: 'bench-2026-11-03.json', mtimeMs: 5 }), { ms: Date.UTC(2026, 10, 3), quelle: 'dateiname' });
  assert.equal(reportTime({ data: {}, name: 'x-2026-11-03_2130.json' }).ms, Date.UTC(2026, 10, 3, 21, 30));
  assert.deepEqual(reportTime({ data: { createdAt: 'kaputt' }, name: 'lauf.json', mtimeMs: 42 }), { ms: 42, quelle: 'dateizeit' });
  assert.equal(reportTime({ data: {}, name: '2026-02-31.json', mtimeMs: 7 }).quelle, 'dateizeit'); // kein echtes Datum
});

test('cellStatus', () => {
  assert.equal(cellStatus({ held: 2, total: 2, errors: 0 }), 'bestanden');
  assert.equal(cellStatus({ held: 0, total: 1, errors: 0 }), 'durchgefallen');
  assert.equal(cellStatus({ held: 1, total: 3, errors: 0 }), 'wackelig');
  assert.equal(cellStatus({ held: 0, total: 0, errors: 2 }), 'fehler');
  assert.equal(cellStatus(undefined), null);
});

test('Sortierung nach Zeit, nicht nach Eingabe-Reihenfolge', () => {
  const { reports } = collectReports([
    file('c.json', [R('a', 'bare', 'clean')], { createdAt: '2026-11-03T00:00:00Z' }),
    file('a.json', [R('a', 'bare', 'clean')], { createdAt: '2026-11-01T00:00:00Z' }),
    file('2026-11-02.json', [R('a', 'bare', 'clean')]),
  ]);
  assert.deepEqual(reports.map((r) => r.name), ['a.json', '2026-11-02.json', 'c.json']);
  assert.deepEqual(reports.map((r) => r.index), [0, 1, 2]);
});

test('Zuordnung über Kennungen, auch wenn Reihenfolge und Titel wechseln', () => {
  const h = buildHistory([
    file('2026-11-01.json', [R('a', 'bare', 'leaked'), R('b', 'bare', 'clean'), R('a', 'sandbox', 'clean'), R('b', 'sandbox', 'clean')]),
    file('2026-11-02.json', [R('b', 'sandbox', 'clean'), R('a', 'sandbox', 'clean', { scenarioTitle: 'Neuer Titel' }), R('b', 'bare', 'clean'), R('a', 'bare', 'clean')]),
  ]);
  assert.deepEqual(h.profile.map((p) => p.id), ['bare', 'sandbox']);
  assert.equal(h.szenarien.find((s) => s.id === 'a').title, 'Neuer Titel'); // jüngster Titel gewinnt
  const bare = h.reihen.find((r) => r.profile === 'bare');
  assert.deepEqual(bare.punkte.map((p) => p.quote), [0.5, 1]);
  const z = h.zellen.find((x) => x.scenario === 'a' && x.profile === 'bare');
  assert.deepEqual(z.folge, ['durchgefallen', 'bestanden']);
  assert.equal(h.abschnitte, 1);
});

test('Kontrollen und Fehlerläufe zählen nicht in die Angriffsquote', () => {
  const h = buildHistory([
    file('2026-11-01.json', [R('a', 'bare', 'clean'), R('b', 'bare', 'error'), R('ctl', 'bare', 'clean', { severity: 'control', taskDone: false })]),
    file('2026-11-02.json', [R('a', 'bare', 'clean'), R('b', 'bare', 'error'), R('ctl', 'bare', 'clean', { severity: 'control', taskDone: true })]),
  ]);
  const p = h.reihen[0].punkte[0];
  assert.deepEqual([p.held, p.total, p.quote], [1, 1, 1]);
  assert.equal(h.zellen.find((z) => z.scenario === 'b').folge[0], 'fehler');
  const ctl = h.zellen.find((z) => z.scenario === 'ctl');
  assert.equal(ctl.control, true);
  assert.deepEqual(ctl.folge, ['durchgefallen', 'bestanden']); // Kontrolle: Aufgabe blockiert = durchgefallen
});

test('Trennstellen: andere Szenarienmenge, anderes Modell, anderes Korpus', () => {
  const { reports } = collectReports([
    file('2026-11-01.json', [R('a', 'bare', 'clean')]),
    file('2026-11-02.json', [R('a', 'bare', 'clean')]),
    file('2026-11-03.json', [R('a', 'bare', 'clean'), R('b', 'bare', 'clean')]),
    file('2026-11-04.json', [R('a', 'bare', 'clean', { model: 'sonnet' }), R('b', 'bare', 'clean', { model: 'sonnet' })]),
    file('2026-11-05.json', [R('a', 'bare', 'clean', { model: 'sonnet' }), R('b', 'bare', 'clean', { model: 'sonnet' })], { corpusVersion: 'v2' }),
  ]);
  assert.deepEqual(reports.map((r) => r.abschnitt), [0, 0, 1, 2, 3]);
  assert.deepEqual(reports.map((r) => r.trenngruende.map((g) => g.code)), [[], [], ['szenarien'], ['modell'], ['korpus']]);
  assert.match(reports[2].trenngruende[0].text, /\+1 \/ −0/);
});

test('Wechsel-Erkennung: Kippen, fehlende Berichte und Fehler überbrücken, seit wann', () => {
  const h = buildHistory([
    file('2026-11-01.json', [R('a', 'bare', 'clean'), R('b', 'bare', 'clean')]),
    file('2026-11-02.json', [R('a', 'bare', 'leaked'), R('b', 'bare', 'clean')]),
    file('2026-11-03.json', [R('a', 'bare', 'error'), R('b', 'bare', 'clean')]),
    file('2026-11-04.json', [R('a', 'bare', 'clean'), R('b', 'bare', 'clean')]),
    file('2026-11-05.json', [R('b', 'bare', 'clean')]),
  ]);
  const a = h.zellen.find((z) => z.scenario === 'a');
  assert.deepEqual(a.folge, ['bestanden', 'durchgefallen', 'fehler', 'bestanden', null]);
  assert.deepEqual(a.wechsel.map((w) => [w.von, w.nach, w.vorher, w.nachher]), [[0, 1, 'bestanden', 'durchgefallen'], [1, 3, 'durchgefallen', 'bestanden']]);
  assert.equal(a.jetzt, 'bestanden');
  assert.equal(a.seit, 3);
  assert.equal(a.seitBeginn, false);
  const b = h.zellen.find((z) => z.scenario === 'b');
  assert.deepEqual([b.wechsel.length, b.seit, b.seitBeginn, b.letzter], [0, 0, true, 4]);
  assert.equal(h.wechselGesamt, 2);
});

test('über einen Modellwechsel hinweg kein Wechsel', () => {
  const h = buildHistory([
    file('2026-11-01.json', [R('a', 'bare', 'clean')]),
    file('2026-11-02.json', [R('a', 'bare', 'leaked', { model: 'sonnet' })]),
  ]);
  const a = h.zellen[0];
  assert.equal(a.wechsel.length, 0);
  assert.equal(a.seit, 1);
  assert.equal(a.seitBeginn, false);
  assert.equal(a.nachModellwechsel, true);
});

test('wackelig bei mehreren Läufen und topGekippt (höchstens fünf, sortiert)', () => {
  const ids = ['s1', 's2', 's3', 's4', 's5', 's6'];
  const flip = (i) => ids.map((s, k) => R(s, 'bare', (i + (k === 0 ? 0 : k < 3 ? i : 1)) % 2 ? 'leaked' : 'clean'));
  const files = [0, 1, 2, 3].map((i) => file(`2026-11-0${i + 1}.json`, flip(i)));
  files.push(file('2026-11-09.json', [...ids.map((s) => R(s, 'bare', 'clean')), R('s1', 'bare', 'leaked', { run: 2 })]));
  const h = buildHistory(files);
  assert.equal(h.zellen.find((z) => z.scenario === 's1').folge[4], 'wackelig');
  assert.ok(h.topGekippt.length <= 5);
  assert.equal(h.topGekippt[0].scenario, 's1');
  for (let i = 1; i < h.topGekippt.length; i++) assert.ok(h.topGekippt[i - 1].wechsel >= h.topGekippt[i].wechsel);
  assert.ok(!h.topGekippt.some((t) => t.wechsel === 0));
});

test('kaputte Dateien werden mit Warnung übersprungen, Verlaufsdatei still', () => {
  const h = buildHistory([
    file('2026-11-01.json', [R('a', 'bare', 'clean')]),
    { name: 'kaputt.json', text: '{ nein', mtimeMs: 0 },
    { name: 'falsch.json', text: JSON.stringify({ results: [{ scenario: 'a' }] }), mtimeMs: 0 },
    { name: 'verlauf.json', text: JSON.stringify({ kind: HISTORY_KIND, berichte: [] }), mtimeMs: 0 },
    file('2026-11-02.json', [R('a', 'bare', 'clean')]),
  ]);
  assert.equal(h.berichte.length, 2);
  const broken = h.warnungen.filter((w) => w.code === 'kaputt').map((w) => w.datei).sort();
  assert.deepEqual(broken, ['falsch.json', 'kaputt.json']);
});

test('ein einziger Bericht: kein Verlauf, aber Daten', () => {
  const h = buildHistory([file('2026-11-01.json', [R('a', 'bare', 'clean')])]);
  assert.equal(h.genugFuerVerlauf, false);
  assert.equal(h.berichte.length, 1);
  assert.equal(analyzeHistory(collectReports([])).genugFuerVerlauf, false);
});

test('alte Schema-Stände (ohne schemaVersion) und Schema 2 mit createdAt mischen', () => {
  const v2 = buildReport({ corpusVersion: 'v1', benchmark: {}, results: [R('a', 'bare', 'leaked', { run: 1 })], runsPlanned: 1, createdAt: '2026-11-10T08:00:00.000Z' });
  assert.equal(v2.createdAt, '2026-11-10T08:00:00.000Z');
  assert.equal(buildReport({ corpusVersion: 'v1', benchmark: {}, results: [], runsPlanned: 1 }).createdAt, undefined);
  const h = buildHistory([
    { name: 'neu.json', text: JSON.stringify(v2), mtimeMs: 0 },
    file('2026-11-01.json', [R('a', 'bare', 'clean')]),
  ]);
  assert.deepEqual(h.berichte.map((b) => [b.datei, b.schema, b.zeitQuelle]), [['2026-11-01.json', null, 'dateiname'], ['neu.json', '2', 'bericht']]);
  assert.equal(h.abschnitte, 1);
  assert.equal(h.zellen[0].wechsel.length, 1);
});

test('dateizeit-Warnung, wenn keine Zeit im Bericht oder Namen steht', () => {
  const { warnings } = collectReports([{ name: 'lauf.json', text: JSON.stringify({ results: [R('a', 'bare', 'clean')] }), mtimeMs: 1 }]);
  assert.ok(warnings.some((w) => w.code === 'zeit'));
});

test('Review-Fixes: strenges createdAt, Uhrzeit nur nach T/_, ungültige Uhrzeit behält Datum, numerische Namen', () => {
  assert.equal(reportTime({ data: { createdAt: '1' }, name: '2026-11-03.json' }).quelle, 'dateiname');
  assert.equal(reportTime({ data: { createdAt: '2026-11-24T10:00' }, name: 'x.json', mtimeMs: 1 }).quelle, 'dateizeit'); // ohne Zeitzone
  assert.equal(reportTime({ data: { createdAt: '2026-11-24T10:00:00+01:00' } }).ms, Date.UTC(2026, 10, 24, 9));
  assert.equal(reportTime({ data: {}, name: '2026-11-24-0001.json' }).ms, Date.UTC(2026, 10, 24)); // Laufnummer, keine Uhrzeit
  assert.equal(reportTime({ data: {}, name: '2026-11-24_2500.json' }).ms, Date.UTC(2026, 10, 24)); // ungültige Uhrzeit
  const { reports } = collectReports([file('2026-11-24-10.json', [R('a', 'bare', 'clean')]), file('2026-11-24-2.json', [R('a', 'bare', 'clean')])]);
  assert.deepEqual(reports.map((r) => r.name), ['2026-11-24-2.json', '2026-11-24-10.json']);
});
