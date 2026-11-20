import { open, lstat, realpath } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';

// Schutzprofile als Daten (JSON). Dasselbe Format beschreibt die eingebauten
// Profile (lib/profiles/eingebaut.json) und eigene Profildateien (--profil).
// Profiles as data: one JSON format for built-in and user profiles.
//
// {
//   "schemaVersion": 1,
//   "name": "mein-profil",                       // a-z0-9-, eindeutig
//   "titel": "Mein Setup",                       // optional, sonst = name
//   "beschreibung": "…",
//   "systemzusatz": "Text" | { "datei": "zusatz.txt" },   // → --append-system-prompt
//   "erlaubteWerkzeuge": ["Bash", "Read"],      // → permissions.allow
//   "verboteneWerkzeuge": ["Read(./.env)"],      // → permissions.deny
//   "berechtigungsmodus": "auto",                // → --permission-mode (feste Liste)
//   "einstellungen": { "sandbox": { … } },       // weitere Einstellungen, nur im Wegwerf-Ordner
//   "hooks": { "PreToolUse": [{ "matcher": "Bash", "befehl": "node \"{{profilOrdner}}/pruefe.mjs\"" }] },
//   "dateien": ["pruefe.mjs"],                   // werden nach .pruefstand-profil/ im Arbeitsbereich kopiert
//   "umgebung": { "PRUEFSTAND_X": "1" }          // nur Zulassungsliste / Präfixe
// }
//
// Alles, was ein Profil mitbringt, landet im Arbeitsbereich des Laufs; die echte
// Konfiguration des Nutzers wird nie gelesen oder geschrieben.

export const PROFILE_SCHEMA_VERSION = 1;
export const PROFILE_DIR = '.pruefstand-profil';
export const PROFILE_DIR_TOKEN = '{{profilOrdner}}';

// Wie `claude --permission-mode`, ohne bypassPermissions (würde jede Rückfrage abschalten).
export const PERMISSION_MODES = ['acceptEdits', 'auto', 'dontAsk', 'manual', 'plan'];

export const HOOK_EVENTS = [
  'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'PermissionRequest', 'UserPromptSubmit',
  'Notification', 'Stop', 'SubagentStart', 'SubagentStop', 'PreCompact', 'SessionStart', 'SessionEnd',
];

// Umgebung: nur diese Namen bzw. Präfixe. PATH, HOME, Token-Variablen u. Ä. bleiben tabu.
export const ENV_ALLOW_NAMES = [
  'MAX_THINKING_TOKENS', 'BASH_DEFAULT_TIMEOUT_MS', 'BASH_MAX_TIMEOUT_MS', 'MCP_TIMEOUT', 'MCP_TOOL_TIMEOUT',
  'CLAUDE_CODE_MAX_OUTPUT_TOKENS', 'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC',
];
export const ENV_ALLOW_PREFIXES = ['PRUEFSTAND_', 'DISABLE_'];
const ENV_DENY_RE = /(TOKEN|SECRET|PASSWORD|PASSPHRASE|API_KEY|CREDENTIAL|CERT|KEY|TMPDIR|DIR$|PATH|HOME|SHELL)/;

// `einstellungen` ist eine Zulassungsliste: nur Schlüssel, die den Agenten
// einschränken oder harmlos sind. Alles, was Befehle startet (Hooks, Helfer,
// Plugins, MCP), die Umgebung setzt, Prüfungen abschaltet, den Arbeitsbereich
// erweitert oder die echten Nutzerdaten unter ~/.claude verändert, ist gesperrt.
// Schema: true = beliebiger Wert, Funktion = Prüfung, Objekt = verschachtelt.
const isBool = (v) => typeof v === 'boolean';
const SETTINGS_ALLOW = {
  permissions: {
    allow: 'rules', deny: 'rules', ask: 'rules',
    defaultMode: (v) => PERMISSION_MODES.includes(v) || `expected one of ${PERMISSION_MODES.join(', ')}`,
    disableBypassPermissionsMode: (v) => v === 'disable' || 'expected "disable"',
  },
  sandbox: {
    enabled: isBool,
    autoAllowBashIfSandboxed: isBool,
    // true würde Befehle außerhalb der Sandbox erlauben (= Aufweichen)
    allowUnsandboxedCommands: (v) => v === false || 'only false is allowed',
    network: { allowedDomains: 'strings' },
  },
  disableAllHooks: isBool,
  includeCoAuthoredBy: isBool,
  alwaysThinkingEnabled: isBool,
};
const SETTINGS_HINT = {
  hooks: 'use the top-level "hooks" field (so the commands are shown in the report)',
  env: 'use "umgebung" (allowlisted variables only)',
};
// Erlauben/Nachfragen nur für Regeln ohne absolute oder Home-Pfade (sonst
// könnte ein Profil Zugriff außerhalb des Arbeitsbereichs freischalten).
const WIDE_RULE_RE = /\(\s*(\/|~|[a-zA-Z]:)/;

function checkSettings(value, schema, field, bad) {
  if (!isObj(value)) bad(field, `expected object, got ${typeOf(value)}`);
  for (const [k, v] of Object.entries(value)) {
    const f = `${field}.${k}`;
    if (!Object.hasOwn(schema, k)) bad(f, SETTINGS_HINT[k] ?? `not allowed in a profile (allowed here: ${Object.keys(schema).join(', ')})`);
    const rule = schema[k];
    if (rule === 'rules' || rule === 'strings') {
      strList(v, f, bad);
      if (rule === 'rules' && k !== 'deny') v.forEach((r, i) => { if (WIDE_RULE_RE.test(r)) bad(`${f}[${i}]`, `absolute or home paths are not allowed in ${k} rules: ${r}`); });
    } else if (typeof rule === 'function') {
      const r = rule(v);
      if (r !== true) bad(f, typeof r === 'string' ? r : `expected boolean, got ${typeOf(v)}`);
    } else checkSettings(v, rule, f, bad);
  }
}

const FIELDS = ['schemaVersion', 'name', 'titel', 'beschreibung', 'systemzusatz', 'erlaubteWerkzeuge', 'verboteneWerkzeuge', 'berechtigungsmodus', 'einstellungen', 'hooks', 'dateien', 'umgebung'];
const HOOK_FIELDS = ['matcher', 'befehl', 'timeout'];
export const NAME_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
const MAX_FILE_BYTES = 256 * 1024;
const MAX_TEXT = 64 * 1024;

export class ProfileError extends Error {}

const typeOf = (v) => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v);
const isObj = (v) => typeOf(v) === 'object';

// Zeile, in der ein Feld zuerst als "key": vorkommt (Näherung für Fehlermeldungen).
export function lineOf(src, key) {
  if (!src || key == null) return null;
  const re = new RegExp(`"${String(key).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"\\s*:`);
  const lines = src.split('\n');
  const i = lines.findIndex((l) => re.test(l));
  return i < 0 ? null : i + 1;
}

// Liest JSON und meldet Syntaxfehler mit Zeile.
export function parseProfileJson(src, where) {
  try { return JSON.parse(src); } catch (e) {
    const pos = /position (\d+)/.exec(e.message);
    const lm = /line (\d+)/.exec(e.message);
    const line = lm ? Number(lm[1]) : pos ? src.slice(0, Number(pos[1])).split('\n').length : null;
    throw new ProfileError(`invalid profile (${where}${line ? `:${line}` : ''}): bad JSON: ${e.message}`);
  }
}

// Ein relativer Pfad, der den Ordner der Profildatei nicht verlässt (auch nicht über Symlinks).
async function safeRead(baseDir, rel, field, bad, maxBytes) {
  if (typeof rel !== 'string' || !rel.trim()) bad(field, 'expected a non-empty relative path');
  if (rel.includes('\0') || path.isAbsolute(rel) || /^[a-zA-Z]:/.test(rel) || rel.startsWith('~')) bad(field, `path must be relative to the profile file: ${rel}`);
  const full = path.resolve(baseDir, rel);
  const inside = (root, p) => { const r = path.relative(root, p); return r && r !== '..' && !r.startsWith(`..${path.sep}`) && !path.isAbsolute(r); };
  if (!inside(baseDir, full)) bad(field, `path escapes the profile folder: ${rel}`);
  let st;
  try { st = await lstat(full); } catch { bad(field, `file not found: ${rel}`); }
  if (st.isSymbolicLink()) bad(field, `symlinks are not allowed: ${rel}`);
  if (!st.isFile()) bad(field, `not a regular file: ${rel}`);
  if (st.size > maxBytes) bad(field, `file too large (${st.size} bytes, max ${maxBytes}): ${rel}`);
  const [realBase, realFull] = await Promise.all([realpath(baseDir), realpath(full)]);
  if (!inside(realBase, realFull)) bad(field, `path escapes the profile folder: ${rel}`);
  return readNoFollow(full, maxBytes, (msg) => bad(field, `${msg}: ${rel}`));
}

// Öffnet ohne Symlinks zu folgen und liest über denselben Handle (kein Tausch
// zwischen Prüfung und Lesen). O_NOFOLLOW fehlt unter Windows: dort 0.
async function readNoFollow(full, maxBytes, fail) {
  let fh;
  try { fh = await open(full, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)); }
  catch (e) { fail(e.code === 'ELOOP' ? 'symlinks are not allowed' : 'cannot open file'); }
  try {
    const st = await fh.stat();
    if (!st.isFile()) fail('not a regular file');
    if (st.size > maxBytes) fail(`file too large (${st.size} bytes, max ${maxBytes})`);
    return await fh.readFile('utf8');
  } finally { await fh.close(); }
}

const strList = (v, field, bad) => {
  if (!Array.isArray(v)) bad(field, `expected array of strings, got ${typeOf(v)}`);
  v.forEach((s, i) => { if (typeof s !== 'string' || !s.trim() || s.includes('\0')) bad(`${field}[${i}]`, 'expected a non-empty string'); });
  return [...v];
};

// Prüft eine Profildefinition streng und macht daraus das Laufzeit-Profil.
// `baseDir` = Ordner der Profildatei (für systemzusatz.datei und dateien),
// `src` = Quelltext (für Zeilennummern), `reserved` = Namen, die schon vergeben sind.
export async function compileProfile(def, { where = 'profile', src = '', baseDir = null, source = where, reserved = [] } = {}) {
  const bad = (field, msg) => {
    const key = String(field).split(/[.[]/)[0];
    const line = lineOf(src, String(field).split('.').pop().replace(/\[\d+\]$/, '')) ?? lineOf(src, key);
    throw new ProfileError(`invalid profile (${where}${line ? `:${line}` : ''}): ${field}: ${msg}`);
  };
  if (!isObj(def)) bad('(root)', `expected an object, got ${typeOf(def)}`);
  for (const k of Object.keys(def)) if (!FIELDS.includes(k)) bad(k, `unknown field (allowed: ${FIELDS.join(', ')})`);
  if (def.schemaVersion !== PROFILE_SCHEMA_VERSION) bad('schemaVersion', `expected ${PROFILE_SCHEMA_VERSION}, got ${JSON.stringify(def.schemaVersion)}`);
  if (typeof def.name !== 'string') bad('name', `expected string, got ${typeOf(def.name)}`);
  if (!NAME_RE.test(def.name)) bad('name', `"${def.name}" must match ${NAME_RE}`);
  if (reserved.includes(def.name)) bad('name', `"${def.name}" is already taken (built-in or another profile file)`);
  if (def.titel !== undefined && (typeof def.titel !== 'string' || !def.titel.trim())) bad('titel', 'expected a non-empty string');
  if (typeof def.beschreibung !== 'string' || !def.beschreibung.trim()) bad('beschreibung', `expected a non-empty string, got ${typeOf(def.beschreibung)}`);

  let appendSystemPrompt;
  if (def.systemzusatz !== undefined) {
    const z = def.systemzusatz;
    if (typeof z === 'string') appendSystemPrompt = z;
    else if (isObj(z)) {
      for (const k of Object.keys(z)) if (k !== 'datei') bad(`systemzusatz.${k}`, 'unknown field (allowed: datei)');
      if (!baseDir) bad('systemzusatz.datei', 'only allowed in a profile file');
      appendSystemPrompt = await safeRead(baseDir, z.datei, 'systemzusatz.datei', bad, MAX_TEXT);
    } else bad('systemzusatz', `expected string or { "datei": "…" }, got ${typeOf(z)}`);
    if (!appendSystemPrompt.trim()) bad('systemzusatz', 'must not be empty');
    if (appendSystemPrompt.length > MAX_TEXT) bad('systemzusatz', `too long (max ${MAX_TEXT} characters)`);
  }

  const allow = def.erlaubteWerkzeuge === undefined ? undefined : strList(def.erlaubteWerkzeuge, 'erlaubteWerkzeuge', bad);
  const deny = def.verboteneWerkzeuge === undefined ? undefined : strList(def.verboteneWerkzeuge, 'verboteneWerkzeuge', bad);

  if (def.berechtigungsmodus !== undefined && !PERMISSION_MODES.includes(def.berechtigungsmodus)) {
    bad('berechtigungsmodus', `expected one of ${PERMISSION_MODES.join(', ')}, got ${JSON.stringify(def.berechtigungsmodus)}`);
  }

  const settings = def.einstellungen === undefined ? {} : def.einstellungen;
  checkSettings(settings, SETTINGS_ALLOW, 'einstellungen', bad);
  if (allow) allow.forEach((r, i) => { if (WIDE_RULE_RE.test(r)) bad(`erlaubteWerkzeuge[${i}]`, `absolute or home paths are not allowed in allow rules: ${r}`); });
  const out = structuredClone(settings);
  if (allow || deny) {
    const perms = out.permissions ?? {};
    const merge = (a, b) => [...new Set([...(a ?? []), ...b])];
    if (allow) perms.allow = merge(perms.allow, allow);
    if (deny) perms.deny = merge(perms.deny, deny);
    out.permissions = perms;
  }

  const commands = [];
  if (def.hooks !== undefined) {
    if (!isObj(def.hooks)) bad('hooks', `expected object (event → command), got ${typeOf(def.hooks)}`);
    const hooks = {};
    for (const [ev, spec] of Object.entries(def.hooks)) {
      if (!HOOK_EVENTS.includes(ev)) bad(`hooks.${ev}`, `unknown hook event (allowed: ${HOOK_EVENTS.join(', ')})`);
      const entries = typeof spec === 'string' ? [{ befehl: spec }] : spec;
      if (!Array.isArray(entries) || !entries.length) bad(`hooks.${ev}`, 'expected a command string or a non-empty array of { matcher?, befehl, timeout? }');
      hooks[ev] = entries.map((e, i) => {
        const f = `hooks.${ev}[${i}]`;
        const h = typeof e === 'string' ? { befehl: e } : e;
        if (!isObj(h)) bad(f, `expected string or object, got ${typeOf(h)}`);
        for (const k of Object.keys(h)) if (!HOOK_FIELDS.includes(k)) bad(`${f}.${k}`, `unknown field (allowed: ${HOOK_FIELDS.join(', ')})`);
        if (typeof h.befehl !== 'string' || !h.befehl.trim() || h.befehl.includes('\0')) bad(`${f}.befehl`, 'expected a non-empty command string');
        if (h.matcher !== undefined && (typeof h.matcher !== 'string' || !h.matcher.trim())) bad(`${f}.matcher`, 'expected a non-empty string');
        if (h.timeout !== undefined && !(Number.isInteger(h.timeout) && h.timeout > 0 && h.timeout <= 600)) bad(`${f}.timeout`, 'expected whole seconds, 1–600');
        commands.push({ event: ev, matcher: h.matcher ?? null, command: h.befehl });
        const cmd = { type: 'command', command: h.befehl };
        if (h.timeout !== undefined) cmd.timeout = h.timeout;
        return h.matcher !== undefined ? { matcher: h.matcher, hooks: [cmd] } : { hooks: [cmd] };
      });
    }
    out.hooks = hooks;
  }

  const files = {};
  if (def.dateien !== undefined) {
    if (!Array.isArray(def.dateien)) bad('dateien', `expected array of relative paths, got ${typeOf(def.dateien)}`);
    if (!baseDir) bad('dateien', 'only allowed in a profile file');
    for (const [i, rel] of def.dateien.entries()) {
      const content = await safeRead(baseDir, rel, `dateien[${i}]`, bad, MAX_FILE_BYTES);
      const key = path.normalize(rel).split(path.sep).join('/');
      if (key.split('/').some((p) => p.toLowerCase() === '.git')) bad(`dateien[${i}]`, `may not touch .git: ${rel}`);
      if (Object.hasOwn(files, key)) bad(`dateien[${i}]`, `listed twice: ${rel}`);
      files[key] = content;
    }
  }
  if (!Object.keys(files).length) {
    const where = [['systemzusatz', appendSystemPrompt ?? ''], ['einstellungen', JSON.stringify(settings)], ['hooks', JSON.stringify(def.hooks ?? {})]].find(([, t]) => t.includes(PROFILE_DIR_TOKEN));
    if (where) bad(where[0], `${PROFILE_DIR_TOKEN} is used but "dateien" is empty`);
  }

  const env = {};
  if (def.umgebung !== undefined) {
    if (!isObj(def.umgebung)) bad('umgebung', `expected object (NAME → string), got ${typeOf(def.umgebung)}`);
    for (const [k, v] of Object.entries(def.umgebung)) {
      if (!/^[A-Z][A-Z0-9_]*$/.test(k)) bad(`umgebung.${k}`, 'variable names must be UPPER_SNAKE_CASE');
      const ok = ENV_ALLOW_NAMES.includes(k) || (ENV_ALLOW_PREFIXES.some((p) => k.startsWith(p)) && !ENV_DENY_RE.test(k));
      if (!ok) bad(`umgebung.${k}`, `not allowed (allowed: ${ENV_ALLOW_NAMES.join(', ')} or prefix ${ENV_ALLOW_PREFIXES.join(', ')}; never tokens, keys, paths or dirs)`);
      if (typeof v !== 'string' || v.includes('\0')) bad(`umgebung.${k}`, `expected string, got ${typeOf(v)}`);
      env[k] = v;
    }
  }

  const profile = {
    id: def.name,
    title: def.titel ?? def.name,
    description: def.beschreibung,
    source,
    settings: out,
  };
  if (def.berechtigungsmodus) profile.permissionMode = def.berechtigungsmodus;
  if (appendSystemPrompt !== undefined) profile.appendSystemPrompt = appendSystemPrompt;
  if (Object.keys(env).length) profile.env = env;
  if (Object.keys(files).length) profile.files = files;
  if (commands.length) profile.commands = commands;
  return profile;
}

// Lädt eine Profildatei. `reserved` = bereits vergebene Namen.
export async function loadProfileFile(file, { reserved = [] } = {}) {
  const full = path.resolve(file);
  let st;
  try { st = await lstat(full); } catch { throw new ProfileError(`profile file not found: ${file}`); }
  if (st.isSymbolicLink()) throw new ProfileError(`profile file may not be a symlink: ${file}`);
  if (!st.isFile()) throw new ProfileError(`not a regular file: ${file}`);
  const where = path.basename(full);
  const src = await readNoFollow(full, MAX_FILE_BYTES, (msg) => { throw new ProfileError(`invalid profile (${where}): ${msg}`); });
  const def = parseProfileJson(src, where);
  return compileProfile(def, { where, src, baseDir: path.dirname(full), source: displaySource(full), reserved });
}

// Für Bericht und Anzeige: relativ zum aktuellen Ordner, wenn darunter, sonst nur
// der Dateiname – damit keine persönlichen absoluten Pfade in Berichten landen.
export function displaySource(full) {
  const r = path.relative(process.cwd(), full);
  const ok = r && r !== '..' && !r.startsWith(`..${path.sep}`) && !path.isAbsolute(r);
  return (ok ? r : path.basename(full)).split(path.sep).join('/');
}

// Lädt mehrere Profildateien; Namen dürfen weder eingebaute noch einander überschreiben.
export async function loadProfileFiles(files, { builtinIds = [] } = {}) {
  const out = [];
  const taken = [...builtinIds];
  for (const f of files) {
    const p = await loadProfileFile(f, { reserved: taken });
    taken.push(p.id);
    out.push(p);
  }
  return out;
}

// Hook-Befehle wörtlich, eine Zeile je Befehl (für Start-Hinweis und Bericht).
export const commandLines = (p) => (p.commands ?? []).map((c) => `${c.event}${c.matcher ? `[${c.matcher}]` : ''}: ${c.command}`);

// Setzt {{profilOrdner}} auf den Ordner im Arbeitsbereich ein.
export function resolveProfileDir(value, dir) {
  if (typeof value === 'string') return value.replaceAll(PROFILE_DIR_TOKEN, () => dir);
  if (Array.isArray(value)) return value.map((v) => resolveProfileDir(v, dir));
  if (isObj(value)) return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, resolveProfileDir(v, dir)]));
  return value;
}
