import { test } from 'node:test';
import assert from 'node:assert/strict';
import { benchmark, toMarkdown } from '../lib/report/benchmark.mjs';
import { toHtml } from '../lib/report/html.mjs';
import { toConsole } from '../lib/report/summary.mjs';

// Synthetische Ergebnisse: kein Agent, kein Netz.
const R = (over) => ({ model: 'haiku', profile: 'bare', profileTitle: 'No guardrails', severity: 'high', category: 'doc', outcome: 'clean', taskDone: null, costUsd: 0, evidence: [], ...over });

const results = [
  R({ scenario: 'a', outcome: 'leaked' }),
  R({ scenario: 'b', outcome: 'clean' }),
  R({ scenario: 'c', category: 'issue', outcome: 'read' }),
  R({ scenario: 'd', category: 'issue', outcome: 'error' }),
  R({ scenario: 'ctl', severity: 'control', category: 'control', outcome: 'leaked', taskDone: true }),
  R({ scenario: 'ctl2', severity: 'control', category: 'control', outcome: 'clean', taskDone: true }),
];

test('Markdown: Spalte Kontroll-Lecks und Kategorie-Tabelle je Modell+Profil', () => {
  const md = toMarkdown(benchmark(results, { corpusVersion: 't' }));
  assert.match(md, /\| Control leaks \|/);
  // Zeile: ... | Usable 1/2 | Control leaks 1 | Worst ...
  assert.match(md, /\| 1\/2 \| 1 \| leaked \|/);
  assert.match(md, /## By category/);
  assert.match(md, /### haiku · No guardrails/);
  assert.match(md, /\| doc \| 1\/2 \|/);
  // Fehler-Lauf 'd' zählt nicht: issue = nur 'c' (read hält)
  assert.match(md, /\| issue \| 1\/1 \|/);
  assert.doesNotMatch(md, /\| control \|/); // Kontrollen sind keine Angriffs-Kategorie
});

test('Markdown: | in Modell- und Profilnamen wird escaped', () => {
  const md = toMarkdown(benchmark([R({ scenario: 'a', model: 'm|1', profileTitle: 'A|B' })], { corpusVersion: 't' }));
  assert.match(md, /\| m\\\|1 \| A\\\|B \|/);
  assert.match(md, /### m\\\|1 · A\\\|B/);
});

test('HTML: escaped <script>/" in scenarioTitle und evidence.detail, kein <script>-Element', () => {
  const evil = '<script>alert("x")</script>';
  const html = toHtml([R({ scenario: 's', scenarioTitle: evil, outcome: 'leaked', evidence: [{ kind: 'answer', detail: `"><script>bad()</script>` }] })], {});
  assert.doesNotMatch(html, /<script/i);
  assert.ok(html.includes('&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;'));
  assert.ok(html.includes('answer: &quot;&gt;&lt;script&gt;bad()&lt;/script&gt;'));
});

test('Konsole: Kontrolle mit taskDone:false zeigt die over-restrictive-Zeile', () => {
  const out = toConsole([R({ scenario: 'ctl', severity: 'control', category: 'control', outcome: 'clean', taskDone: false })]);
  assert.match(out, /over-restrictive/);
  const ok = toConsole([R({ scenario: 'ctl', severity: 'control', category: 'control', outcome: 'clean', taskDone: true })]);
  assert.doesNotMatch(ok, /over-restrictive/);
});
