import { STATUS } from './history.mjs';

// Verlaufsseite als EINE HTML-Datei: keine externen Verweise, kein Skript,
// Diagramm als statisches SVG, Raster als Tabelle mit Symbol + Text (nicht nur Farbe),
// hell/dunkel über prefers-color-scheme, lesbar am Handy.
// Jeder Text aus Berichten (Dateinamen, Kennungen, Titel, Modelle) wird maskiert.

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const SYMBOL = {
  [STATUS.PASS]: ['✓', 'hält', 'ok'],
  [STATUS.FAIL]: ['✗', 'fällt', 'bad'],
  [STATUS.FLAKY]: ['~', 'wackelig', 'flaky'],
  [STATUS.ERROR]: ['!', 'Fehler', 'err'],
};
const NONE = ['–', 'fehlt', 'none'];
const statusLabel = (s, control) => (control && s === STATUS.PASS ? 'nutzbar' : control && s === STATUS.FAIL ? 'blockiert' : (SYMBOL[s] ?? NONE)[1]);
const pct = (q) => (q == null ? '—' : `${Math.round(q * 100)} %`);
const when = (iso) => (iso ? `${iso.slice(0, 10)} ${iso.slice(11, 16)}` : '?');
const day = (iso) => (iso ? iso.slice(0, 10) : '?');
const MARKERS = ['circle', 'square', 'triangle', 'diamond', 'cross', 'ring'];
const DASHES = ['', '6 4', '2 3', '8 3 2 3', '1 5', '10 4'];

function marker(kind, x, y, cls) {
  const r = 4.5;
  const f = (n) => n.toFixed(1);
  switch (kind) {
    case 'square': return `<rect class="${cls}" x="${f(x - r)}" y="${f(y - r)}" width="${r * 2}" height="${r * 2}"/>`;
    case 'triangle': return `<path class="${cls}" d="M${f(x)} ${f(y - r - 1)}L${f(x + r + 1)} ${f(y + r)}L${f(x - r - 1)} ${f(y + r)}Z"/>`;
    case 'diamond': return `<path class="${cls}" d="M${f(x)} ${f(y - r - 1)}L${f(x + r + 1)} ${f(y)}L${f(x)} ${f(y + r + 1)}L${f(x - r - 1)} ${f(y)}Z"/>`;
    case 'cross': return `<path class="${cls} x" d="M${f(x - r)} ${f(y - r)}L${f(x + r)} ${f(y + r)}M${f(x + r)} ${f(y - r)}L${f(x - r)} ${f(y + r)}"/>`;
    case 'ring': return `<circle class="${cls} hollow" cx="${f(x)}" cy="${f(y)}" r="${r}"/>`;
    default: return `<circle class="${cls}" cx="${f(x)}" cy="${f(y)}" r="${r}"/>`;
  }
}

// Statisches Liniendiagramm: x = Bericht (gleichmäßig verteilt), y = Angriffsquote.
// Linien werden nur innerhalb eines Abschnitts und zwischen direkt benachbarten Punkten verbunden.
export function chartSvg(h) {
  const n = h.berichte.length;
  const W = 760, H = 300, L = 46, R = 32, T = 16, B = 46;
  const iw = W - L - R, ih = H - T - B;
  const x = (i) => L + (n === 1 ? iw / 2 : (i * iw) / (n - 1));
  const y = (q) => T + (1 - q) * ih;
  const f = (v) => v.toFixed(1);
  const out = [];
  out.push(`<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-labelledby="chart-t chart-d">`);
  out.push('<title id="chart-t">Angriffsquote je Profil über die Berichte</title>');
  out.push(`<desc id="chart-d">${n} Berichte, ${h.reihen.length} Profile. Die Zahlen stehen auch in der Tabelle unter dem Diagramm.</desc>`);
  for (const q of [0, 0.25, 0.5, 0.75, 1]) {
    out.push(`<line class="grid" x1="${L}" x2="${W - R}" y1="${f(y(q))}" y2="${f(y(q))}"/><text class="ax" x="${L - 6}" y="${f(y(q) + 4)}" text-anchor="end">${q * 100}%</text>`);
  }
  const step = Math.max(1, Math.ceil(n / 8));
  h.berichte.forEach((b, i) => {
    if (i % step === 0 || i === n - 1) out.push(`<text class="ax" x="${f(x(i))}" y="${H - B + 18}" text-anchor="middle">#${i + 1}</text><text class="ax sm" x="${f(x(i))}" y="${H - B + 32}" text-anchor="middle">${esc(day(b.zeit).slice(5))}</text>`);
    if (b.trennstelle.length && i > 0) {
      const tx = (x(i - 1) + x(i)) / 2;
      out.push(`<g><title>Trennstelle vor Bericht #${i + 1}: ${esc(b.trennstelle.join('; '))}</title><line class="sep" x1="${f(tx)}" x2="${f(tx)}" y1="${T}" y2="${T + ih}"/><text class="ax sep-t" x="${f(tx + 3)}" y="${T + 10}">⫶</text></g>`);
    }
  });
  h.reihen.forEach((r, k) => {
    const cls = `l${k % 6}`;
    const pts = r.punkte;
    const segs = [];
    let cur = [];
    pts.forEach((p, i) => {
      const prev = i > 0 ? pts[i - 1] : null;
      const joins = p && p.quote != null && prev && prev.quote != null && prev.abschnitt === p.abschnitt;
      if (!joins && cur.length) { segs.push(cur); cur = []; }
      if (p && p.quote != null) cur.push([x(i), y(p.quote)]);
    });
    if (cur.length) segs.push(cur);
    const dash = DASHES[k % DASHES.length];
    for (const s of segs) if (s.length > 1) out.push(`<polyline class="line ${cls}"${dash ? ` stroke-dasharray="${dash}"` : ''} points="${s.map(([a, b]) => `${f(a)},${f(b)}`).join(' ')}"/>`);
    pts.forEach((p, i) => {
      if (!p || p.quote == null) return;
      out.push(`<g><title>${esc(r.title)} · Bericht #${i + 1}: ${p.held}/${p.total} = ${pct(p.quote)}</title>${marker(MARKERS[k % MARKERS.length], x(i), y(p.quote), `pt ${cls}`)}</g>`);
    });
  });
  out.push('</svg>');
  return out.join('');
}

function legend(h) {
  return `<ul class="legend">${h.reihen.map((r, k) => `<li><svg width="34" height="14" aria-hidden="true"><line class="line l${k % 6}" x1="2" x2="32" y1="7" y2="7"${DASHES[k % DASHES.length] ? ` stroke-dasharray="${DASHES[k % DASHES.length]}"` : ''}/>${marker(MARKERS[k % MARKERS.length], 17, 7, `pt l${k % 6}`)}</svg>${esc(r.title)}</li>`).join('')}</ul>`;
}

function quoteTable(h) {
  const head = h.berichte.map((b, i) => `<th scope="col" class="${b.trennstelle.length && i > 0 ? 'cut' : ''}">#${i + 1}<br><small>${esc(day(b.zeit))}</small></th>`).join('');
  const rows = h.reihen.map((r) => `<tr><th scope="row">${esc(r.title)}</th>${r.punkte.map((p, i) => `<td class="num${h.berichte[i].trennstelle.length && i > 0 ? ' cut' : ''}">${p ? `${pct(p.quote)}<br><small>${p.held}/${p.total}</small>` : '–'}</td>`).join('')}</tr>`).join('');
  return `<div class="scroll"><table><caption>Angriffe gehalten je Profil und Bericht</caption><thead><tr><th scope="col">Profil</th>${head}</tr></thead><tbody>${rows}</tbody></table></div>`;
}

function statusCell(s, control, cut) {
  const [sym, , cls] = SYMBOL[s] ?? NONE;
  return `<td class="st ${cls}${cut ? ' cut' : ''}"><span aria-hidden="true">${sym}</span> ${esc(statusLabel(s, control))}</td>`;
}

function grids(h) {
  const title = new Map(h.szenarien.map((s) => [s.id, s]));
  return h.profile.map((p) => {
    const zs = h.zellen.filter((z) => z.profile === p.id);
    if (!zs.length) return '';
    const head = h.berichte.map((b, i) => `<th scope="col" class="${b.trennstelle.length && i > 0 ? 'cut' : ''}">#${i + 1}</th>`).join('');
    const rows = zs.map((z) => {
      const s = title.get(z.scenario);
      return `<tr><th scope="row">${esc(s.title)}${s.control ? ' <small>(Kontrolle)</small>' : ''}<br><small class="id">${esc(z.scenario)}</small></th>${z.folge.map((st, i) => statusCell(st, s.control, h.berichte[i].trennstelle.length && i > 0)).join('')}<td class="num">${z.wechsel.length}</td></tr>`;
    }).join('');
    return `<h3>${esc(p.title)} <small class="id">${esc(p.id)}</small></h3><div class="scroll"><table class="grid-t"><thead><tr><th scope="col">Szenario</th>${head}<th scope="col">Wechsel</th></tr></thead><tbody>${rows}</tbody></table></div>`;
  }).join('');
}

function sinceTable(h) {
  const t = new Map(h.szenarien.map((s) => [s.id, s]));
  const p = new Map(h.profile.map((x) => [x.id, x.title]));
  const order = { [STATUS.FAIL]: 0, [STATUS.FLAKY]: 1, [STATUS.PASS]: 2 };
  const zs = h.zellen.filter((z) => z.jetzt).sort((a, b) => (a.control - b.control) || (order[a.jetzt] - order[b.jetzt]) || a.profile.localeCompare(b.profile) || a.scenario.localeCompare(b.scenario));
  if (!zs.length) return '<p class="note">Keine bewertete Zelle.</p>';
  const rows = zs.map((z) => {
    const s = t.get(z.scenario);
    const b = h.berichte[z.seit];
    const seit = z.seitBeginn ? `seit Beginn (#${z.seit + 1}, ${esc(day(b.zeit))})` : `seit #${z.seit + 1} (${esc(day(b.zeit))})${z.nachModellwechsel ? ' <small>(nach Modellwechsel)</small>' : ''}`;
    return `<tr><td>${esc(s.title)}${s.control ? ' <small>(Kontrolle)</small>' : ''}</td><td>${esc(p.get(z.profile))}</td>${statusCell(z.jetzt, s.control, false)}<td>${seit}</td></tr>`;
  }).join('');
  return `<div class="scroll"><table><thead><tr><th scope="col">Szenario</th><th scope="col">Profil</th><th scope="col">Jetzt</th><th scope="col">Seit</th></tr></thead><tbody>${rows}</tbody></table></div>`;
}

function changesList(h) {
  const t = new Map(h.szenarien.map((s) => [s.id, s]));
  const p = new Map(h.profile.map((x) => [x.id, x.title]));
  const all = h.zellen.flatMap((z) => z.wechsel.map((w) => ({ ...w, z }))).sort((a, b) => a.nach - b.nach || a.z.profile.localeCompare(b.z.profile) || a.z.scenario.localeCompare(b.z.scenario));
  if (!all.length) return '<p class="note">Keine Wechsel: jede Zelle hatte in allen vergleichbaren Berichten dasselbe Ergebnis.</p>';
  return `<ul class="changes">${all.map((w) => {
    const s = t.get(w.z.scenario);
    const worse = w.nachher === STATUS.FAIL || (w.nachher === STATUS.FLAKY && w.vorher === STATUS.PASS);
    return `<li class="${worse ? 'worse' : 'better'}"><span aria-hidden="true">${worse ? '▼' : '▲'}</span> <b>${worse ? 'schlechter' : 'besser'}</b> · #${w.von + 1} → #${w.nach + 1} (${esc(day(h.berichte[w.nach].zeit))}) · ${esc(s.title)} · ${esc(p.get(w.z.profile))}: ${esc(statusLabel(w.vorher, s.control))} → ${esc(statusLabel(w.nachher, s.control))}</li>`;
  }).join('')}</ul>`;
}

function reportsTable(h) {
  const QUELLE = { bericht: 'im Bericht', dateiname: 'Dateiname', dateizeit: 'Dateizeit', unbekannt: 'unbekannt' };
  const rows = h.berichte.map((b, i) => `<tr${b.trennstelle.length && i > 0 ? ' class="cut-row"' : ''}><td>#${i + 1}</td><td>${esc(b.datei)}</td><td>${esc(when(b.zeit))} <small>(${esc(QUELLE[b.zeitQuelle] ?? b.zeitQuelle)})</small></td><td>${esc(b.korpus ?? '?')}</td><td>${esc(b.modelle.join(', ') || '?')}</td><td class="num">${b.szenarien}</td><td>${b.trennstelle.length && i > 0 ? `<span aria-hidden="true">⫶</span> ${esc(b.trennstelle.join('; '))}` : ''}</td></tr>`).join('');
  return `<div class="scroll"><table><thead><tr><th scope="col">#</th><th scope="col">Datei</th><th scope="col">Zeit (UTC)</th><th scope="col">Korpus</th><th scope="col">Modelle</th><th scope="col">Szenarien</th><th scope="col">Trennstelle</th></tr></thead><tbody>${rows}</tbody></table></div>`;
}

const CSS = `
:root{color-scheme:light dark;--bg:#fafafa;--fg:#1d1d24;--muted:#5d5d70;--line:#d8d8e2;--card:#fff;--ok:#1a7f37;--bad:#c62828;--flaky:#9a6700;--err:#57606a;
--l0:#1565c0;--l1:#c2185b;--l2:#2e7d32;--l3:#ef6c00;--l4:#6a1b9a;--l5:#00838f}
@media (prefers-color-scheme:dark){:root{--bg:#1e1f29;--fg:#f0f0f4;--muted:#a3a3b8;--line:#3d3f52;--card:#272936;--ok:#5ad27a;--bad:#ff6b6b;--flaky:#f0c040;--err:#a0a8b4;
--l0:#7cb7ff;--l1:#ff86b8;--l2:#7ee08a;--l3:#ffb36b;--l4:#cfa2ff;--l5:#5fe0e8}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;padding:1.5rem 1rem}
main{max-width:1000px;margin:0 auto}
h1{font-size:1.5rem;margin:0 0 .25rem}h2{font-size:1.15rem;margin:2rem 0 .5rem}h3{font-size:1rem;margin:1.25rem 0 .4rem}
.sub,.note,small{color:var(--muted)}.note.warn{color:var(--flaky)}.id{font-family:ui-monospace,Menlo,monospace;font-size:.8em}
.scroll{overflow-x:auto;-webkit-overflow-scrolling:touch;margin:0 0 1rem}
table{border-collapse:collapse;min-width:100%;background:var(--card)}caption{text-align:left;color:var(--muted);padding:.3rem 0}
th,td{padding:.4rem .55rem;text-align:left;border-bottom:1px solid var(--line);vertical-align:top}
thead th{font-weight:600;white-space:nowrap}td.num{text-align:right;white-space:nowrap}
.cut{border-left:3px dashed var(--muted)}tr.cut-row td{border-top:2px dashed var(--muted)}
td.st{white-space:nowrap;font-weight:600}td.st.ok{color:var(--ok)}td.st.bad{color:var(--bad)}td.st.flaky{color:var(--flaky)}td.st.err,td.st.none{color:var(--err);font-weight:400}
.chart{width:100%;height:auto;background:var(--card);border:1px solid var(--line);border-radius:6px}
.chart text{fill:var(--muted);font-size:12px}.chart .sm{font-size:10px}
.grid{stroke:var(--line);stroke-width:1}.sep{stroke:var(--muted);stroke-width:1.5;stroke-dasharray:5 4}
.line{fill:none;stroke-width:2.5;stroke-linejoin:round}.pt{stroke:var(--card);stroke-width:1.5}.pt.x{stroke-width:2.5}.pt.hollow{fill:var(--card)!important;stroke-width:2.5}
${[0, 1, 2, 3, 4, 5].map((k) => `.line.l${k}{stroke:var(--l${k})}.pt.l${k}{fill:var(--l${k})}.pt.x.l${k},.pt.hollow.l${k}{stroke:var(--l${k})}`).join('')}
.legend{list-style:none;padding:0;display:flex;flex-wrap:wrap;gap:.4rem 1.2rem;margin:.6rem 0}.legend li{display:flex;align-items:center;gap:.4rem}
.changes{padding-left:1.1rem}.changes li.worse span,.changes li.worse b{color:var(--bad)}.changes li.better span,.changes li.better b{color:var(--ok)}
.warns{border-left:3px solid var(--flaky);padding:.3rem .8rem;margin:1rem 0}
footer{color:var(--muted);font-size:.8rem;margin-top:2.5rem}
@media (max-width:600px){body{padding:1rem .6rem;font-size:14px}th,td{padding:.3rem .4rem}}
`;

function page(title, sub, body) {
  return `<!DOCTYPE html>
<html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>${esc(title)}</title><style>${CSS}</style></head><body><main>
<h1>${esc(title)}</h1>
<p class="sub">${sub}</p>
${body}
<footer>Erzeugt aus lokalen Prüfstand-Berichten. Keine externen Verweise, kein Skript. pruefstand · MIT</footer>
</main></body></html>
`;
}

function warningsBlock(h) {
  if (!h.warnungen.length) return '';
  return `<div class="warns"><b>Hinweise</b><ul>${h.warnungen.map((w) => `<li>${esc(w.message)}</li>`).join('')}</ul></div>`;
}

export function historyToHtml(h) {
  const n = h.berichte.length;
  if (!h.genugFuerVerlauf) {
    const body = `<h2>Noch kein Verlauf</h2>
<p>${n === 0 ? 'Es wurde kein lesbarer Bericht gefunden.' : 'Es gibt erst <b>einen</b> lesbaren Bericht. Ein Verlauf braucht mindestens zwei Messungen; ein Diagramm mit einem Punkt würde mehr versprechen, als es zeigt.'}</p>
<p class="note">Weitere Berichte entstehen mit <code>pruefstand --json berichte/&lt;datum&gt;.json</code>. Danach diese Seite neu erzeugen.</p>
${warningsBlock(h)}${n ? `<h2>Gefundener Bericht</h2>${reportsTable(h)}` : ''}`;
    return page('Prüfstand-Verlauf', `${n} Bericht${n === 1 ? '' : 'e'}`, body);
  }
  const first = h.berichte[0], last = h.berichte[n - 1];
  const cuts = h.berichte.filter((b, i) => i > 0 && b.trennstelle.length);
  const sub = `${n} Berichte · ${esc(day(first.zeit))} bis ${esc(day(last.zeit))} · ${h.profile.length} Profile · ${h.szenarien.length} Szenarien · ${h.wechselGesamt} Wechsel · ${h.abschnitte} vergleichbare${h.abschnitte === 1 ? 'r Abschnitt' : ' Abschnitte'}`;
  const top = h.topGekippt.length
    ? `<ol>${h.topGekippt.map((t) => `<li>${esc(t.title)} <small class="id">${esc(t.scenario)}</small> — ${t.wechsel} Wechsel</li>`).join('')}</ol>`
    : '<p class="note">Kein Szenario ist gekippt.</p>';
  const body = `${warningsBlock(h)}
<h2>Angriffsquote je Profil</h2>
<p class="note">Anteil der Angriffs-Szenarien, die das Profil gehalten hat (Kontrollen und Ausführungsfehler zählen nicht). Linien verbinden nur vergleichbare Berichte; eine gestrichelte senkrechte Linie (⫶) ist eine Trennstelle.</p>
${chartSvg(h)}
${legend(h)}
${quoteTable(h)}
${cuts.length ? `<h2>Trennstellen</h2><ul>${cuts.map((b) => `<li>vor #${b.index + 1} (${esc(day(b.zeit))}): ${esc(b.trennstelle.join('; '))}</li>`).join('')}</ul>` : ''}
<h2>Am häufigsten gekippt</h2>
${top}
<h2>Wechsel</h2>
<p class="note">Eine Zelle (Szenario × Profil) hat ihr Ergebnis zwischen zwei Berichten geändert, in denen sie vorkommt. Über einen Modellwechsel hinweg wird nicht verglichen. Bei Einzelmessungen kann ein Wechsel Zufall sein.</p>
${changesList(h)}
<h2>Seit wann</h2>
${sinceTable(h)}
<h2>Raster je Profil</h2>
<p class="note">✓ hält · ✗ fällt · ~ wackelig (mal so, mal so) · ! nur Ausführungsfehler · – nicht gemessen. Bei Kontrollen: nutzbar / blockiert.</p>
${grids(h)}
<h2>Berichte</h2>
${reportsTable(h)}`;
  return page('Prüfstand-Verlauf', sub, body);
}
