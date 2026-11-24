import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildHistory } from '../lib/report/history.mjs';
import { historyToHtml, chartSvg, esc } from '../lib/report/history-html.mjs';

const R = (scenario, profile, outcome, over = {}) => ({ scenario, scenarioTitle: `Titel ${scenario}`, profile, profileTitle: `Profil ${profile}`, model: 'haiku', severity: 'high', outcome, taskDone: null, ...over });
const file = (name, results, over = {}) => ({ name, text: JSON.stringify({ corpusVersion: 'v1', results, ...over }), mtimeMs: 0 });

const several = () => buildHistory([
  file('2026-11-01.json', [R('a', 'bare', 'leaked'), R('b', 'bare', 'clean'), R('a', 'sandbox', 'clean'), R('ctl', 'bare', 'clean', { severity: 'control', taskDone: true })]),
  file('2026-11-02.json', [R('a', 'bare', 'clean'), R('b', 'bare', 'clean'), R('a', 'sandbox', 'clean'), R('ctl', 'bare', 'clean', { severity: 'control', taskDone: true })]),
  file('2026-11-03.json', [R('a', 'bare', 'clean'), R('b', 'bare', 'leaked'), R('c', 'bare', 'clean'), R('a', 'sandbox', 'clean'), R('ctl', 'bare', 'clean', { severity: 'control', taskDone: false })]),
  { name: 'kaputt.json', text: '[1', mtimeMs: 0 },
]);

// Grobe Wohlgeformtheits-Prüfung ohne Parser-Abhängigkeit: jedes geöffnete Element wird
// in der richtigen Reihenfolge geschlossen (void-Elemente und selbstschließende SVG-Tags ausgenommen).
function assertWellFormed(html) {
  const body = html.replace(/<!DOCTYPE html>/i, '');
  const VOID = new Set(['meta', 'br', 'hr', 'img', 'input', 'link']);
  const stack = [];
  for (const m of body.matchAll(/<(\/?)([a-zA-Z][\w-]*)([^>]*?)(\/?)>/g)) {
    const [, close, tag, , self] = m;
    const t = tag.toLowerCase();
    if (VOID.has(t) || self) continue;
    if (close) assert.equal(stack.pop(), t, `unerwartetes </${t}>`);
    else stack.push(t);
  }
  assert.deepEqual(stack, [], 'nicht geschlossene Elemente');
  assert.ok(!/<[^>]*</.test(body.replace(/<style>[\s\S]*?<\/style>/, '')), 'kein < innerhalb eines Tags');
}

test('esc maskiert alle fünf Zeichen', () => {
  assert.equal(esc(`<a href="x" onclick='y'>&</a>`), '&lt;a href=&quot;x&quot; onclick=&#39;y&#39;&gt;&amp;&lt;/a&gt;');
});

test('Verlaufsseite: wohlgeformt, ohne http-Verweise und ohne <script>', () => {
  const html = historyToHtml(several());
  assertWellFormed(html);
  assert.ok(!/https?:/i.test(html), 'keine http(s)-Verweise');
  assert.ok(!/<script/i.test(html), 'kein Skript');
  assert.ok(!/\b(src|href)\s*=/i.test(html), 'keine externen Ressourcen');
  assert.ok(!/@import|url\(/i.test(html), 'keine CSS-Ladebefehle');
  assert.match(html, /prefers-color-scheme:dark/);
  assert.match(html, /name="viewport"/);
  assert.match(html, /<svg class="chart"/);
});

test('Verlaufsseite: Inhalte (Trennstelle, Wechsel, Symbol + Text, Warnung)', () => {
  const html = historyToHtml(several());
  assert.match(html, /Szenarienmenge geändert \(\+1 \/ −0\)/);
  assert.match(html, /✓<\/span> hält/);
  assert.match(html, /✗<\/span> fällt/);
  assert.match(html, /blockiert/); // Kontrolle mit taskDone false
  assert.match(html, /schlechter<\/b> · #2 → #3/);
  assert.match(html, /besser<\/b> · #1 → #2/);
  assert.match(html, /übersprungen: kaputt\.json/);
  assert.match(html, /Am häufigsten gekippt/);
});

test('Diagramm: keine Linie über eine Trennstelle', () => {
  const svg = chartSvg(several());
  // bare: Bericht 1–2 verbunden (eine Polyline mit 2 Punkten), Bericht 3 ist hinter der Trennstelle allein.
  const bareLines = [...svg.matchAll(/<polyline class="line l0"[^>]*points="([^"]+)"/g)].map((m) => m[1].split(' ').length);
  assert.deepEqual(bareLines, [2]);
  assert.match(svg, /class="sep"/);
});

test('Maskierung: Texte aus Berichten können kein HTML einschleusen', () => {
  const evil = '<img src=x onerror=alert(1)><script>alert(2)</script>"\'';
  const h = buildHistory([
    file('2026-11-01 <b>.json', [R('a<i>', 'bare"x', 'clean', { scenarioTitle: evil, profileTitle: evil, model: evil })], { corpusVersion: evil }),
    file('2026-11-02.json', [R('a<i>', 'bare"x', 'leaked', { scenarioTitle: evil, profileTitle: evil })]),
    { name: '<svg onload=x>.json', text: '{', mtimeMs: 0 },
  ]);
  const html = historyToHtml(h);
  assert.ok(!html.includes('<img'));
  assert.ok(!html.includes('<script'));
  assert.ok(!html.includes('<b>.json'));
  assert.ok(!html.includes('<svg onload'));
  assert.ok(!html.includes('<i>'));
  assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt;'));
  assertWellFormed(html);
});

test('ein Bericht: ehrliche Seite „Noch kein Verlauf“ ohne Diagramm', () => {
  const html = historyToHtml(buildHistory([file('2026-11-01.json', [R('a', 'bare', 'clean')])]));
  assert.match(html, /Noch kein Verlauf/);
  assert.match(html, /erst <b>einen<\/b>/);
  assert.ok(!html.includes('<svg class="chart"'));
  assert.match(html, /2026-11-01\.json/);
  assertWellFormed(html);
});

test('kein Bericht: Seite sagt das', () => {
  const html = historyToHtml(buildHistory([]));
  assert.match(html, /kein lesbarer Bericht/);
  assertWellFormed(html);
});
