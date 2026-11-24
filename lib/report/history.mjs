import { parseReport, DiffInputError, LIMITS } from './diff.mjs';

// Verlauf über viele Berichte (die --json-Ausgabe). Reines Modul: kein Dateisystem,
// kein Netz, keine Uhr. Eingabe ist eine Liste { name, text, mtimeMs }; das Lesen
// der Dateien macht lib/history-cli.mjs.
//
// Begriffe:
//  - Zelle    = Szenario × Profil in einem Bericht (Modelle werden zusammengelegt, wie in `diff`).
//  - Status   = bestanden | durchgefallen | wackelig | fehler (nur Ausführungsfehler) | null (fehlt).
//  - Abschnitt = Folge von Berichten mit gleicher Korpus-Version, gleichen Modellen und gleicher
//               Szenarienmenge. Profil-Linien werden nur innerhalb eines Abschnitts verbunden.
//  - Wechsel  = eine Zelle kippt zwischen zwei Berichten, in denen sie vorkommt
//               (bestanden ↔ durchgefallen ↔ wackelig). Über einen Modellwechsel hinweg
//               wird nicht verglichen: das wäre kein Vergleich gleicher Dinge.

export const HISTORY_KIND = 'pruefstand-verlauf';
export const HISTORY_SCHEMA = 1;
export const STATUS = { PASS: 'bestanden', FAIL: 'durchgefallen', FLAKY: 'wackelig', ERROR: 'fehler' };
const RATED = new Set([STATUS.PASS, STATUS.FAIL, STATUS.FLAKY]);

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const short = (v, max = LIMITS.maxIdLength) => (typeof v === 'string' && v.length <= max ? v : null);

// Zeitpunkt eines Berichts, in dieser Reihenfolge:
//  1. `createdAt` im Bericht (ISO-Zeit, ab dieser Version geschrieben),
//  2. ein Datum im Dateinamen (2026-11-24, optional mit Uhrzeit 2026-11-24T21-30 / _2130),
//  3. die Änderungszeit der Datei.
// `quelle` sagt, woher die Zeit stammt, damit die Seite das offen zeigen kann.
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})$/;
const validUtc = (y, mo, d, h = 0, mi = 0) => {
  if (h > 23 || mi > 59) return null;
  const t = Date.UTC(y, mo - 1, d, h, mi);
  const back = new Date(t);
  return back.getUTCMonth() === mo - 1 && back.getUTCDate() === d ? t : null;
};

export function reportTime({ data, name, mtimeMs }) {
  // createdAt nur als vollständige ISO-Zeit mit Zeitzone (sonst hinge das Ergebnis von der Ortszeit ab).
  const iso = isObj(data) ? short(data.createdAt, 40) : null;
  if (iso && ISO_TIME.test(iso)) {
    const t = Date.parse(iso);
    if (Number.isFinite(t)) return { ms: t, quelle: 'bericht' };
  }
  // Uhrzeit nur nach „T“ oder „_“ (2026-11-24T2130, 2026-11-24_21-30), damit Laufnummern wie -0001 keine Uhrzeit werden.
  const m = /(\d{4})-(\d{2})-(\d{2})(?:[T_](\d{2})[-:h.]?(\d{2}))?/.exec(String(name ?? ''));
  if (m) {
    const [y, mo, d] = [+m[1], +m[2], +m[3]];
    const t = (m[4] != null ? validUtc(y, mo, d, +m[4], +m[5]) : null) ?? validUtc(y, mo, d); // ungültige Uhrzeit: nur das Datum
    if (t != null) return { ms: t, quelle: 'dateiname' };
  }
  if (Number.isFinite(mtimeMs)) return { ms: mtimeMs, quelle: 'dateizeit' };
  return { ms: null, quelle: 'unbekannt' };
}

export function cellStatus(c) {
  if (!c) return null;
  if (!c.total) return c.errors ? STATUS.ERROR : null;
  if (c.held === c.total) return STATUS.PASS;
  if (c.held === 0) return STATUS.FAIL;
  return STATUS.FLAKY;
}

// Liest einen Bericht. Wirft DiffInputError bei kaputtem Inhalt.
// Gibt null zurück für eine Verlaufsdatei (eigene Ausgabe im selben Ordner): kein Bericht, aber auch kein Fehler.
function readOne({ name, text, mtimeMs }) {
  let data;
  try { data = JSON.parse(text); } catch (e) { throw new DiffInputError(`${name}: not valid JSON (${e.message})`); }
  if (isObj(data) && data.kind === HISTORY_KIND) return null;
  const parsed = parseReport(data, name);
  // Titel für die Anzeige (parseReport hält nur Kennungen).
  const scenarioTitles = new Map();
  const profileTitles = new Map();
  for (const r of data.results) {
    if (!scenarioTitles.has(r.scenario) && short(r.scenarioTitle)) scenarioTitles.set(r.scenario, r.scenarioTitle);
    if (!profileTitles.has(r.profile) && short(r.profileTitle)) profileTitles.set(r.profile, r.profileTitle);
  }
  const t = reportTime({ data, name, mtimeMs });
  const cells = new Map();
  for (const c of parsed.cells.values()) cells.set(`${c.scenario}\u0000${c.profile}`, c);
  return {
    name,
    timeMs: t.ms,
    zeitQuelle: t.quelle,
    corpusVersion: parsed.corpusVersion == null ? null : String(parsed.corpusVersion),
    schema: parsed.schema == null ? null : String(parsed.schema),
    models: parsed.models,
    scenarios: [...new Set([...cells.values()].map((c) => c.scenario))].sort(),
    profiles: [...new Set([...cells.values()].map((c) => c.profile))].sort(),
    cells, scenarioTitles, profileTitles,
  };
}

// Sammler: liest alle Berichte, überspringt kaputte mit Warnung, sortiert nach Zeit
// (gleiche Zeit: nach Dateiname) und markiert Trennstellen.
export function collectReports(files) {
  const warnings = [];
  const reports = [];
  for (const f of files) {
    try {
      const r = readOne(f);
      if (r) reports.push(r);
    } catch (e) {
      if (!(e instanceof DiffInputError)) throw e;
      warnings.push({ code: 'kaputt', datei: f.name, message: `übersprungen: ${e.message}` });
    }
  }
  reports.sort((a, b) => (a.timeMs ?? Infinity) - (b.timeMs ?? Infinity) || a.name.localeCompare(b.name, 'en', { numeric: true }));
  const guessed = reports.filter((r) => r.zeitQuelle === 'dateizeit').length;
  if (guessed) warnings.push({ code: 'zeit', message: `${guessed} Bericht(e) ohne Zeitangabe: sortiert nach Änderungszeit der Datei. Ein Datum im Dateinamen (z. B. 2026-11-24.json) macht die Reihenfolge stabil.` });

  // Trennstellen: Gründe, warum Bericht i nicht mit Bericht i-1 vergleichbar ist.
  let segment = 0;
  reports.forEach((r, i) => {
    r.index = i;
    r.trenngruende = [];
    if (i > 0) {
      const p = reports[i - 1];
      if (p.corpusVersion !== r.corpusVersion) r.trenngruende.push({ code: 'korpus', text: `Korpus ${p.corpusVersion ?? '?'} → ${r.corpusVersion ?? '?'}` });
      if (p.models.join() !== r.models.join()) r.trenngruende.push({ code: 'modell', text: `Modell ${p.models.join(', ') || '?'} → ${r.models.join(', ') || '?'}` });
      if (p.scenarios.join('\u0000') !== r.scenarios.join('\u0000')) {
        const before = new Set(p.scenarios);
        const after = new Set(r.scenarios);
        const plus = r.scenarios.filter((s) => !before.has(s)).length;
        const minus = p.scenarios.filter((s) => !after.has(s)).length;
        r.trenngruende.push({ code: 'szenarien', text: `Szenarienmenge geändert (+${plus} / −${minus})` });
      }
      if (r.trenngruende.length) segment++;
    }
    r.abschnitt = segment;
  });
  return { reports, warnings };
}

// Auswertung über die gesammelten Berichte.
export function analyzeHistory({ reports, warnings = [] }) {
  const profileIds = [...new Set(reports.flatMap((r) => r.profiles))].sort();
  const scenarioIds = [...new Set(reports.flatMap((r) => r.scenarios))].sort();
  const lastTitle = (ids, key) => new Map(ids.map((id) => {
    for (let i = reports.length - 1; i >= 0; i--) if (reports[i][key].has(id)) return [id, reports[i][key].get(id)];
    return [id, id];
  }));
  const scenarioTitles = lastTitle(scenarioIds, 'scenarioTitles');
  const profileTitles = lastTitle(profileIds, 'profileTitles');
  const controls = new Set();
  for (const r of reports) for (const c of r.cells.values()) if (c.control) controls.add(c.scenario);
  const isControl = new Map(scenarioIds.map((s) => [s, controls.has(s)]));

  // Zeitreihe der Angriffsquote je Profil (Kontrollen und Fehlerläufe zählen nicht).
  const reihen = profileIds.map((profile) => ({
    profile,
    title: profileTitles.get(profile),
    punkte: reports.map((r) => {
      let held = 0; let total = 0; let found = false;
      for (const c of r.cells.values()) {
        if (c.profile !== profile) continue;
        found = true;
        if (c.control) continue;
        held += c.held; total += c.total;
      }
      if (!found) return null;
      return { index: r.index, abschnitt: r.abschnitt, held, total, quote: total ? held / total : null };
    }),
  }));

  // Folge je Szenario × Profil, Wechsel und „seit wann“.
  const modelBreak = (i) => reports[i].trenngruende.some((g) => g.code === 'modell');
  const zellen = [];
  for (const scenario of scenarioIds) for (const profile of profileIds) {
    const key = `${scenario}\u0000${profile}`;
    const folge = reports.map((r) => cellStatus(r.cells.get(key)));
    if (folge.every((s) => s == null)) continue;
    const wechsel = [];
    let prev = null; // Index des letzten bewerteten Berichts
    let seit = null;
    for (let i = 0; i < folge.length; i++) {
      if (i > 0 && modelBreak(i)) { prev = null; seit = null; } // nicht über einen Modellwechsel vergleichen
      if (!RATED.has(folge[i])) continue;
      if (prev != null && folge[prev] !== folge[i]) { wechsel.push({ von: prev, nach: i, vorher: folge[prev], nachher: folge[i] }); seit = i; }
      if (seit == null) seit = i;
      prev = i;
    }
    const jetzt = prev == null ? null : folge[prev];
    const ersteBewertung = folge.findIndex((s) => RATED.has(s));
    zellen.push({
      scenario, profile, control: isControl.get(scenario), folge, wechsel,
      jetzt, seit, letzter: prev,
      // seitBeginn: Status gilt seit dem ersten bewerteten Bericht dieser Zelle.
      // nachModellwechsel: Status gilt seit einem Modellwechsel (davor wurde nicht verglichen).
      seitBeginn: seit != null && seit === ersteBewertung,
      nachModellwechsel: seit != null && seit !== ersteBewertung && !wechsel.some((w) => w.nach === seit),
    });
  }

  // Die fünf Szenarien, die am häufigsten gekippt sind (über alle Profile summiert).
  const perScenario = new Map();
  for (const z of zellen) if (z.wechsel.length) perScenario.set(z.scenario, (perScenario.get(z.scenario) ?? 0) + z.wechsel.length);
  const topGekippt = [...perScenario].map(([scenario, wechsel]) => ({ scenario, title: scenarioTitles.get(scenario), wechsel }))
    .sort((a, b) => b.wechsel - a.wechsel || a.scenario.localeCompare(b.scenario)).slice(0, 5);

  return {
    kind: HISTORY_KIND,
    schema: HISTORY_SCHEMA,
    berichte: reports.map((r) => ({
      index: r.index, datei: r.name,
      zeit: r.timeMs == null ? null : new Date(r.timeMs).toISOString(), zeitQuelle: r.zeitQuelle,
      korpus: r.corpusVersion, schema: r.schema, modelle: r.models,
      szenarien: r.scenarios.length, profile: r.profiles,
      abschnitt: r.abschnitt, trennstelle: r.trenngruende.map((g) => g.text),
    })),
    abschnitte: reports.length ? reports[reports.length - 1].abschnitt + 1 : 0,
    profile: profileIds.map((id) => ({ id, title: profileTitles.get(id) })),
    szenarien: scenarioIds.map((id) => ({ id, title: scenarioTitles.get(id), control: isControl.get(id) })),
    reihen, zellen, topGekippt,
    wechselGesamt: zellen.reduce((n, z) => n + z.wechsel.length, 0),
    warnungen: warnings,
    genugFuerVerlauf: reports.length >= 2,
  };
}

// Bequemer Einstieg: Dateien rein, Auswertung raus.
export function buildHistory(files) {
  return analyzeHistory(collectReports(files));
}

// JSON-Ausgabe (stabile Feldnamen, keine Maps).
export function historyToJson(h) {
  return JSON.stringify(h, null, 2) + '\n';
}
