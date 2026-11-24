import { readdir, lstat, readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { LIMITS } from './report/diff.mjs';
import { buildHistory, historyToJson } from './report/history.mjs';
import { historyToHtml } from './report/history-html.mjs';

export const DEFAULT_DIR = 'berichte';
export const MAX_FILES = 2000;

export const VERLAUF_HELP = `pruefstand verlauf — trend over all reports as one HTML file

Usage:
  pruefstand verlauf [ordner] [options]

Reads every *.json report (written by \`pruefstand --json <path>\`) in the folder
(default: ${DEFAULT_DIR}/, not recursive), sorts them by time and writes one page:
attack rate per profile as a line, per scenario the pass/fail history, the
changes, "since when", and the five scenarios that flipped most often.

Options:
  --aus <datei>           Output file (default: <ordner>/verlauf.html; "-" = stdout).
                          With --format json the default is stdout.
  --format <html|json>    Output format (default: html)
  -h, --help              Show this help

Time of a report: "createdAt" in the report, else a date in the file name
(2026-11-24.json, 2026-11-24_2130.json), else the file's modification time.
Broken files are skipped with a warning. Symlinks are not followed.
Exit codes: 0 page written, 2 error (folder missing, no readable report, bad option).
`;

class VerlaufError extends Error {}

export function parseVerlaufArgs(argv) {
  const o = { dir: null, aus: null, format: 'html', help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => { if (i + 1 >= argv.length) throw new VerlaufError(`option ${a} needs a value`); return argv[++i]; };
    if (a === '-h' || a === '--help') o.help = true;
    else if (a === '--aus' || a === '--out') o.aus = val();
    else if (a === '--format') o.format = val();
    else if (a.startsWith('-')) throw new VerlaufError(`unknown option: ${a}`);
    else if (o.dir == null) o.dir = a;
    else throw new VerlaufError(`only one folder expected (got "${o.dir}" and "${a}")`);
  }
  if (!['html', 'json'].includes(o.format)) throw new VerlaufError(`--format must be html or json (got "${o.format}")`);
  o.dir ??= DEFAULT_DIR;
  if (o.aus == null) o.aus = o.format === 'html' ? path.join(o.dir, 'verlauf.html') : '-';
  return o;
}

// Liest alle *.json eines Ordners (nicht rekursiv). Symlinks, Nicht-Dateien und zu große
// Dateien werden übersprungen und gemeldet; die eigene Ausgabedatei wird ausgelassen.
export async function readReportDir(dir, { skip = null } = {}) {
  let entries;
  try { entries = await readdir(dir, { withFileTypes: true }); } catch (e) { throw new VerlaufError(`${dir}: cannot read folder (${e.code ?? e.message})`); }
  const names = entries.map((e) => e.name).filter((n) => n.toLowerCase().endsWith('.json')).sort();
  const notes = [];
  if (names.length > MAX_FILES) {
    notes.push(`${names.length} JSON files found; only the last ${MAX_FILES} by name are read.`);
    names.splice(0, names.length - MAX_FILES);
  }
  const skipAbs = skip ? path.resolve(skip) : null;
  const files = [];
  for (const name of names) {
    const p = path.join(dir, name);
    if (skipAbs && path.resolve(p) === skipAbs) continue;
    let st;
    try { st = await lstat(p); } catch (e) { notes.push(`${name}: skipped (${e.code ?? e.message})`); continue; }
    if (st.isSymbolicLink()) { notes.push(`${name}: skipped (symlink, not followed)`); continue; }
    if (!st.isFile()) continue;
    if (st.size > LIMITS.maxBytes) { notes.push(`${name}: skipped (too large, ${st.size} bytes)`); continue; }
    let text;
    try { text = await readFile(p, 'utf8'); } catch (e) { notes.push(`${name}: skipped (${e.code ?? e.message})`); continue; }
    files.push({ name, text, mtimeMs: st.mtimeMs });
  }
  return { files, notes };
}

// Gibt den Exit-Code zurück. I/O ist injizierbar, damit es ohne Prozess testbar ist.
export async function runVerlauf(argv, { stdout = process.stdout, stderr = process.stderr } = {}) {
  try {
    const o = parseVerlaufArgs(argv);
    if (o.help) { stdout.write(VERLAUF_HELP); return 0; }
    const toStdout = o.aus === '-';
    const { files, notes } = await readReportDir(o.dir, { skip: toStdout ? null : o.aus });
    for (const n of notes) stderr.write(`pruefstand verlauf: ${n}\n`);
    if (!files.length) throw new VerlaufError(`${o.dir}: no *.json report found. Write reports with: pruefstand --json ${DEFAULT_DIR}/<datum>.json`);
    const h = buildHistory(files);
    for (const w of h.warnungen) stderr.write(`pruefstand verlauf: ${w.message}\n`);
    if (!h.berichte.length) throw new VerlaufError(`${o.dir}: none of the ${files.length} JSON file(s) is a readable report`);
    const out = o.format === 'json' ? historyToJson(h) : historyToHtml(h);
    if (toStdout) { stdout.write(out); return 0; }
    await mkdir(path.dirname(path.resolve(o.aus)), { recursive: true });
    await writeFile(o.aus, out);
    const note = h.genugFuerVerlauf ? `${h.berichte.length} reports, ${h.wechselGesamt} change(s), ${h.abschnitte} comparable section(s)` : 'only one report: no trend yet';
    stdout.write(`  Verlauf: ${note}\n  ${o.format.toUpperCase()}: ${o.aus}\n`);
    return 0;
  } catch (e) {
    if (!(e instanceof VerlaufError)) throw e;
    stderr.write(`pruefstand verlauf: ${e.message}\n`);
    return 2;
  }
}
