/** Conservative commands allowed by our gate while planning/reviewing. No shell composition except a verified read pipeline. */

// First command of a read pipeline (or the only command).
const READ_HEADS = /^(pwd|ls|cat|head|tail|wc|rg|Get-Content|Get-ChildItem|Get-Item|Test-Path|Select-String|Get-Location)$/i;
// Later pipeline stages: only filters/formatters that read their input and print.
const PIPE_STAGES = /^(Select-Object|Select-String|Sort-Object|Measure-Object|Format-Table|Format-List|Out-String|head|tail|wc|rg)$/i;
const GIT_READ = /^(status|diff|log|show|ls-files|rev-parse)$/i;
// git options that write files or run external programs.
const GIT_BANNED = ["--output", "--ext-diff", "--textconv", "--exec-path"];
// ripgrep options that run external programs (preprocessor, decompressors, hostname command).
const RG_BANNED = ["--pre", "--pre-glob", "--search-zip", "--hostname-bin"];

/** Splits one command into arguments. Quotes are literal ('' is an escaped ' inside single quotes). Unbalanced quotes → null. */
function splitArgs(s: string): string[] | null {
  const args: string[] = [];
  let i = 0;
  while (i < s.length) {
    while (i < s.length && /\s/.test(s[i])) i++;
    if (i >= s.length) break;
    let arg = "";
    while (i < s.length && !/\s/.test(s[i])) {
      const c = s[i];
      if (c === "'") {
        i++;
        for (;;) {
          if (i >= s.length) return null;
          if (s[i] === "'") {
            if (s[i + 1] === "'") { arg += "'"; i += 2; continue; }
            i++;
            break;
          }
          arg += s[i++];
        }
      } else if (c === '"') {
        const end = s.indexOf('"', i + 1);
        if (end < 0) return null;
        arg += s.slice(i + 1, end);
        i = end + 1;
      } else {
        arg += c;
        i++;
      }
    }
    args.push(arg);
  }
  return args;
}

/** Option name without its attached value: --pre=x / -OutVariable:x → --pre / -outvariable. */
function optionName(arg: string): string {
  return arg.toLowerCase().split(/[=:]/)[0];
}

function hasBannedArg(head: string, args: string[]): boolean {
  const lower = head.toLowerCase();
  for (const arg of args) {
    const name = optionName(arg);
    if (!name.startsWith("-")) continue;
    if (name === "-exec" || name === "-delete") return true;
    // PowerShell common parameters that create variables; PowerShell accepts any unique prefix.
    if (/^-(ov|pv|outv[a-z]*|pi[a-z]*)$/.test(name)) return true;
    // git -c (config override, case-sensitive; -C on log/diff is copy detection)
    if (lower === "git" && (arg.startsWith("-c") && name === "-c" || GIT_BANNED.includes(name))) return true;
    if (lower === "rg" && (RG_BANNED.includes(name) || /^-[a-y]*z[a-z]*$/i.test(name))) return true;
  }
  return false;
}

function isReadStage(stage: string, first: boolean): boolean {
  const args = splitArgs(stage);
  if (!args?.length) return false;
  const [head, ...rest] = args;
  if (first && head.toLowerCase() === "git") {
    if (!rest.length || !GIT_READ.test(rest[0])) return false;
  } else if (!(first ? READ_HEADS : PIPE_STAGES).test(head)) return false;
  return !hasBannedArg(head, rest);
}

/** Splits on | outside quotes (a quoted | is a literal pattern character). Unbalanced quotes → null. */
function splitPipeline(s: string): string[] | null {
  const stages: string[] = [];
  let quote = "", start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quote) { if (c === quote) quote = ""; continue; }
    if (c === "'" || c === '"') quote = c;
    else if (c === "|") { stages.push(s.slice(start, i)); start = i + 1; }
  }
  if (quote) return null;
  stages.push(s.slice(start));
  return stages;
}

export function isReadCommand(command: string): boolean {
  const s = command.trim();
  if (!s || /[;&<>`$\r\n(){}]/.test(s) || s.includes("||")) return false;
  const stages = splitPipeline(s);
  return !!stages && stages.every((stage, i) => isReadStage(stage.trim(), i === 0));
}

const PS_EXE = /^(powershell|pwsh)(\.exe)?$/i;
const PS_POLICIES = /^(Bypass|RemoteSigned|Unrestricted|AllSigned|Restricted|Default|Undefined)$/i;

/**
 * Script of a whole-command PowerShell wrapper, e.g. `"…\powershell.exe" -NoProfile -Command "git status"`
 * or `powershell.exe -Command 'git log'`. The executable must start the command and one quoted script
 * argument must end it; anything else (extra commands, unknown options, ambiguous quoting) → null.
 */
export function unwrapPowerShell(command: string): string | null {
  const s = command.trim();
  let i: number;
  let exe: string;
  if (s.startsWith('"')) {
    const end = s.indexOf('"', 1);
    if (end < 0) return null;
    exe = s.slice(1, end);
    i = end + 1;
  } else {
    exe = /^\S*/.exec(s)![0];
    i = exe.length;
  }
  if (!PS_EXE.test(exe.split(/[\\/]/).pop() ?? "")) return null;
  for (;;) {
    const m = /^\s+(-\S+)/.exec(s.slice(i));
    if (!m) return null;
    i += m[0].length;
    const flag = m[1];
    if (/^-(NoProfile|NonInteractive|NoLogo)$/i.test(flag)) continue;
    if (/^-ExecutionPolicy$/i.test(flag)) {
      const p = /^\s+(\S+)/.exec(s.slice(i));
      if (!p || !PS_POLICIES.test(p[1])) return null;
      i += p[0].length;
      continue;
    }
    if (/^-(Command|c)$/i.test(flag)) break;
    return null;
  }
  const payload = s.slice(i).trim();
  if (payload.length < 2) return null;
  if (payload[0] === "'") {
    let out = "";
    for (let j = 1; j < payload.length; j++) {
      if (payload[j] !== "'") { out += payload[j]; continue; }
      if (payload[j + 1] === "'") { out += "'"; j++; continue; }
      return j === payload.length - 1 ? out : null;
    }
    return null;
  }
  if (payload[0] === '"') {
    const inner = payload.slice(1, -1);
    // Windows parses \" as an escaped quote: any inner quote or a trailing backslash is ambiguous.
    if (!payload.endsWith('"') || inner.includes('"') || inner.endsWith("\\")) return null;
    return inner;
  }
  return null;
}

export function isMutatingTool(name: string, input: string, hasDiffs = false): boolean {
  if (hasDiffs || ["Write", "Edit", "MultiEdit", "NotebookEdit", "파일 변경", "write_file", "edit_file", "save_video"].includes(name)) return true;
  if (name === "run_command") {
    try { const command = JSON.parse(input).command; return typeof command !== "string" || !isReadCommand(command); }
    catch { return true; }
  }
  return ["Bash", "PowerShell", "명령"].includes(name) && !isReadCommand(input);
}
