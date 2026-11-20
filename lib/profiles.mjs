// A profile is one way of running the agent: which permission mode, which
// deny rules, sandbox on or off. Running the same scenarios under several
// profiles shows whether each defence actually changes the outcome.
//
// Die eingebauten Profile stehen als Daten in lib/profiles/eingebaut.json, im
// selben Format wie eigene Profildateien (siehe lib/profile-format.mjs).

import { readFileSync } from 'node:fs';
import { compileProfile } from './profile-format.mjs';

const src = readFileSync(new URL('./profiles/eingebaut.json', import.meta.url), 'utf8');
const defs = JSON.parse(src);

export const profiles = {};
for (const def of defs) {
  profiles[def.name] = await compileProfile(def, { where: 'eingebaut.json', src, source: 'eingebaut', reserved: Object.keys(profiles) });
}

export const DEFAULT_PROFILES = ['bare', 'deny-reads', 'sandbox'];
export const DENY_SECRETS = [...profiles['deny-reads'].settings.permissions.deny];

// PreToolUse hook for Bash: blocks any command that mentions .env/.npmrc
// (exit code 2 = deny, stderr goes back to the agent). Self-contained, so it
// needs no extra file in the workspace. Closes the `cat .env` gap that
// Read-deny rules leave open, without the full OS sandbox.
// Grenze: reine Zeichenketten-Prüfung — Umgehungen wie `cat .e*` greifen nicht,
// und Treffer wie `process.env` sind Falsch-Positive. Unlesbare Eingabe wird abgelehnt (fail-closed).
export const BASH_GUARD_COMMAND = profiles['deny-hook'].settings.hooks.PreToolUse[0].hooks[0].command;

// `extra` = Profile aus Dateien (--profil). Ohne Auswahl laufen die Standard-
// Profile plus alle Profile aus Dateien.
export function getProfiles(ids, extra = []) {
  const all = { ...profiles };
  for (const p of extra) {
    if (Object.hasOwn(all, p.id)) throw new Error(`profile name "${p.id}" is already taken`);
    all[p.id] = p;
  }
  const keys = ids && ids.length ? ids : [...DEFAULT_PROFILES, ...extra.map((p) => p.id)];
  return [...new Set(keys)].map((k) => {
    if (!Object.hasOwn(all, k)) throw new Error(`unknown profile: ${k} (have ${Object.keys(all).join(', ')})`);
    return all[k];
  });
}
