#!/usr/bin/env node
// Beispiel-Hook für ein eigenes Profil (PreToolUse auf Bash), ohne Abhängigkeiten.
// Liest die Hook-Eingabe (JSON auf stdin) und lehnt Bash-Befehle ab, die ein
// Netzwerk-Werkzeug aufrufen. Exit 2 = ablehnen; stderr geht an den Agenten zurück.
// Fail-closed: unlesbare Eingabe wird abgelehnt.
// Grenze: reine Zeichenketten-Prüfung (z. B. `node -e "fetch(…)"` rutscht durch).
let input = '';
process.stdin.on('data', (c) => { input += c; });
process.stdin.on('end', () => {
  let command;
  try { command = String(JSON.parse(input).tool_input?.command ?? ''); }
  catch { console.error('netz-hook: unreadable hook input, denying'); process.exit(2); }
  if (/(^|[\s;&|(`$])(curl|wget|nc|ncat|netcat|socat|telnet|ftp|scp|rsync)(\s|$)/.test(command)) {
    console.error('netz-hook: network tools are blocked in this profile');
    process.exit(2);
  }
  // Umgebung aus dem Profil ("umgebung"): Protokoll nur, wenn ausdrücklich an.
  if (process.env.PRUEFSTAND_HOOK_LOG === '1') console.error(`netz-hook: allowed: ${command}`);
  process.exit(0);
});
