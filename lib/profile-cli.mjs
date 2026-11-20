// `pruefstand profile …`: Profile auflisten und Profildateien prüfen.
// Liest nur die angegebenen Dateien; startet keinen Agenten, führt keinen Hook aus.

import { profiles as builtin } from './profiles.mjs';
import { loadProfileFile, loadProfileFiles, commandLines } from './profile-format.mjs';

export const PROFILE_HELP = `pruefstand profile — list defence profiles and check profile files

Usage:
  pruefstand profile [--profil <datei>]...   list built-in profiles (and the given files)
  pruefstand profile pruefe <datei>...       only check profile files, run nothing

A profile file is JSON (schemaVersion 1); see README, section "Eigenes Profil",
and examples/profile/. Exit codes: 0 ok, 1 invalid profile file, 2 usage error.
`;

const describe = (p) => {
  const L = [`  ${p.id.padEnd(22)} ${p.source === 'eingebaut' ? 'eingebaut' : `Datei: ${p.source}`}`, `      ${p.title} — ${p.description}`];
  if (p.permissionMode) L.push(`      Berechtigungsmodus: ${p.permissionMode}`);
  if (p.appendSystemPrompt) L.push(`      Systemzusatz: ${p.appendSystemPrompt.length} Zeichen`);
  if (p.env) L.push(`      Umgebung: ${Object.keys(p.env).join(', ')}`);
  if (p.files) L.push(`      Dateien: ${Object.keys(p.files).join(', ')}`);
  for (const c of commandLines(p)) L.push(`      Befehl ${c}`);
  return L.join('\n');
};

// Gibt den Exit-Code zurück; `out`/`err` sind für Tests austauschbar.
export async function runProfileCli(argv, { out = (s) => process.stdout.write(s), err = (s) => process.stderr.write(s) } = {}) {
  if (argv.includes('-h') || argv.includes('--help')) { out(PROFILE_HELP); return 0; }
  const builtinIds = Object.keys(builtin);
  if (argv[0] === 'pruefe') {
    const files = argv.slice(1);
    if (!files.length || files.some((f) => f.startsWith('-'))) { err('usage: pruefstand profile pruefe <datei>...\n'); return 2; }
    let bad = 0;
    const seen = [...builtinIds];
    for (const f of files) {
      try {
        const p = await loadProfileFile(f, { reserved: seen });
        seen.push(p.id);
        out(`ok  ${f}  →  ${p.id}${p.commands ? ` (enthält ${p.commands.length} Befehl${p.commands.length > 1 ? 'e' : ''})` : ''}\n`);
      } catch (e) { bad++; err(`FEHLER  ${e.message}\n`); }
    }
    return bad ? 1 : 0;
  }
  const files = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--profil') {
      if (argv[i + 1] === undefined) { err('missing value for --profil\n'); return 2; }
      files.push(argv[++i]);
    } else { err(`unknown argument: ${argv[i]}\n${PROFILE_HELP}`); return 2; }
  }
  let extra;
  try { extra = await loadProfileFiles(files, { builtinIds }); }
  catch (e) { err(`${e.message}\n`); return 1; }
  out('Profile:\n');
  for (const p of [...Object.values(builtin), ...extra]) out(`${describe(p)}\n`);
  return 0;
}
