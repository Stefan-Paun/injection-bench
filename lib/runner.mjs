import { writeFile, mkdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { createWorkspace } from './workspace.mjs';
import { startHoneypot } from './honeypot.mjs';
import { makeCanary, makeSecrets } from './canary.mjs';
import { parseStreamJson } from './events.mjs';
import { analyse } from './detect.mjs';
import { PROFILE_DIR, resolveProfileDir, commandLines } from './profile-format.mjs';

// Only these environment variables reach the agent. Everything else — tokens,
// session secrets, cloud profiles in the environment — is withheld, so a run
// can't pick a real credential out of its own env.
const ENV_ALLOW = [
  'PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'LC_ALL', 'LC_CTYPE',
  'TERM', 'TMPDIR', 'TZ', 'CLAUDE_CONFIG_DIR',
];
// `extra` = `umgebung` des Profils; schon beim Laden gegen eine Zulassungsliste
// geprüft (lib/profile-format.mjs), kann also PATH, HOME oder Tokens nicht setzen.
export function agentEnv(extra = {}) {
  const env = {};
  for (const k of ENV_ALLOW) if (process.env[k] != null) env[k] = process.env[k];
  // Pass provider API keys only if the user set them for a bare/CI run.
  for (const k of Object.keys(process.env)) if (/^(ANTHROPIC|AWS_BEARER_TOKEN_BEDROCK|CLOUD_ML_REGION|GOOGLE_)/.test(k)) env[k] = process.env[k];
  return { ...env, ...extra };
}

export const SETTINGS_FILE = '.pruefstand-settings.json';

// Legt alles, was das Profil mitbringt, in den Wegwerf-Arbeitsbereich: die
// Einstellungsdatei und die Profil-Dateien (z. B. Hook-Skripte) unter
// .pruefstand-profil/. Nichts davon landet außerhalb von `dir`.
export async function prepareProfile(dir, profile) {
  const profileDir = path.join(dir, PROFILE_DIR);
  for (const [rel, content] of Object.entries(profile.files ?? {})) {
    const full = path.join(profileDir, rel);
    if (!full.startsWith(profileDir + path.sep)) throw new Error(`profile file escapes the workspace: ${rel}`);
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, content);
  }
  const settingsPath = path.join(dir, SETTINGS_FILE);
  const settings = resolveProfileDir(profile.settings ?? {}, profileDir);
  await writeFile(settingsPath, JSON.stringify(settings, null, 2));
  return { settingsPath, settings, profileDir };
}

// Der Aufruf des Agenten für einen Fall. Getrennt, damit Tests den erzeugten
// Aufruf je Profil-Feld prüfen können.
export function buildAgentArgs({ prompt, model, maxTurns, budgetUsd, settingsPath, dir, profile, profileDir = path.join(dir, PROFILE_DIR) }) {
  const args = [
    '-p', prompt,
    '--output-format', 'stream-json', '--verbose',
    '--model', model,
    '--max-turns', String(maxTurns),
    '--max-budget-usd', String(budgetUsd),
    '--no-session-persistence',
    '--setting-sources', 'local',
    '--settings', settingsPath,
    '--add-dir', dir,
  ];
  if (profile.permissionMode) args.push('--permission-mode', profile.permissionMode, '--permission-prompts', 'none');
  if (profile.appendSystemPrompt) args.push('--append-system-prompt', resolveProfileDir(profile.appendSystemPrompt, profileDir));
  return args;
}

// Runs one scenario under one profile against the real agent and returns a
// verdict. The agent only ever sees the throwaway workspace.
export async function runCase({ scenario, profile, agentCmd = 'claude', model = 'haiku', budgetUsd = 0.1, maxTurns = 8, timeoutMs = 150000, dryRun = false }) {
  const canary = makeCanary();
  const secrets = makeSecrets(canary);
  const honeypot = await startHoneypot();
  try {
    const built = scenario.build({ canary, secrets, honeypotUrl: honeypot.url });
    const ws = await createWorkspace(built.files, { commits: built.commits ?? [], untracked: built.secretFiles ?? [] });
    try {
      if (dryRun) {
        // No workspace path here: ws.remove() in the finally below deletes it.
        return { scenario: scenario.id, profile: profile.id, dryRun: true, ...(profile.commands?.length ? { profileCommands: commandLines(profile) } : {}), prompt: built.prompt, honeypotUrl: honeypot.url, files: ws.files };
      }
      const { settingsPath, profileDir } = await prepareProfile(ws.dir, profile);
      const args = buildAgentArgs({ prompt: built.prompt, model, maxTurns, budgetUsd, settingsPath, dir: ws.dir, profile, profileDir });

      const proc = await exec(agentCmd, args, { cwd: ws.dir, timeoutMs, env: agentEnv(profile.env) });
      await new Promise((r) => setTimeout(r, 150)); // let late honeypot 'close' events land
      const events = parseStreamJson(proc.stdout);
      const taskDone = built.taskDone ? await built.taskDone(ws).catch(() => false) : null;
      const leakedFiles = await ws.snapshot(built.secretFiles ?? []).catch(() => []);

      const verdict = analyse({ events, hits: honeypot.hits, canary, secretFiles: built.secretFiles, taskDone, leakedFiles, run: { timedOut: proc.timedOut, spawnError: proc.spawnError } });
      return {
        scenario: scenario.id, scenarioTitle: scenario.title, severity: scenario.severity, category: scenario.category,
        profile: profile.id, profileTitle: profile.title, model,
        ...(profile.source && profile.source !== 'eingebaut' ? { profileSource: profile.source } : {}),
        ...(profile.commands?.length ? { profileCommands: commandLines(profile) } : {}),
        timedOut: proc.timedOut, spawnError: proc.spawnError,
        ...verdict,
      };
    } finally {
      await ws.remove();
    }
  } finally {
    await honeypot.close();
  }
}

// Spawns the agent in its own process group so a stuck child (curl, sleep) is
// killed with it, and captures stdout up to a cap.
function exec(cmd, args, { cwd, timeoutMs, env }) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    let stdout = '', over = false, timedOut = false, spawnError = null, done = false;
    const CAP = 64 * 1024 * 1024;
    const finish = () => { if (done) return; done = true; clearTimeout(timer); resolve({ stdout, timedOut, spawnError }); };
    const timer = setTimeout(() => { timedOut = true; try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch { /* gone */ } } }, timeoutMs);
    child.stdout.on('data', (c) => { if (over) return; stdout += c; if (stdout.length > CAP) { over = true; spawnError = 'stdout exceeded buffer cap'; try { process.kill(-child.pid, 'SIGKILL'); } catch { /* gone */ } } });
    child.on('error', (err) => { spawnError = String(err.message || err); finish(); });
    child.on('close', () => finish());
  });
}
