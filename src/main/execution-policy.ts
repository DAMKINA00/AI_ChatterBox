/** Unwrap only a complete PowerShell invocation, never a trailing -Command in another command. */
export function innerShellCommand(command: string): string {
  const match = /^(?:"(?:[^"\r\n]*[\\/])?(?:powershell|pwsh)(?:\.exe)?"|'(?:[^'\r\n]*[\\/])?(?:powershell|pwsh)(?:\.exe)?'|(?:powershell|pwsh)(?:\.exe)?)(?:\s+-(?:NoLogo|NoProfile|NonInteractive))*\s+-(?:Command|c)\s+(['"])([\s\S]*)\1\s*$/i.exec(command.trim());
  if (!match) return command;
  return match[1] === "'" ? match[2].replace(/''/g, "'") : match[2].replace(/\\"/g, '"');
}

/** Conservative reads and simple read-only pipelines; unknown shell syntax still needs a write lock. */
export function isReadCommand(command: string): boolean {
  const s = innerShellCommand(command).trim();
  if (!s || /[;&<>`$\r\n(){}]/.test(s)) return false;
  return s.split("|").every((part, index) => {
    const segment = part.trim();
    if (!segment || /['"]/.test(segment.replace(/'(?:[^']|'')*'|"(?:[^"]|"")*"/g, ""))) return false;
    if (/(?:^|\s)(?:-exec|-delete|--pre(?:=|\s)|--pre-glob|-OutVariable|-ov|-PipelineVariable|-pv)\b/i.test(segment)) return false;
    if (index > 0) return /^Select-Object(?:\s|$)/i.test(segment)
      || /^Where-Object\s+\w+\s+-(?:eq|ne|gt|ge|lt|le|like|notlike|match|notmatch|contains|notcontains|in|notin)\s+(?:'[^']*'|"[^"]*"|[^\s'"]+)$/i.test(segment);
    if (/^git\s+(status|diff|log|show|ls-files|rev-parse)\b/i.test(segment))
      return !/--(output|ext-diff|textconv|exec-path)|\s-c\s/i.test(segment);
    return /^(pwd|ls|cat|head|tail|wc|rg|Get-Content|Get-ChildItem|Get-Item|Get-FileHash|Test-Path|Select-String|Get-Location)(?:\s|$)/i.test(segment);
  });
}

export function isMutatingTool(name: string, input: string, hasDiffs = false): boolean {
  if (hasDiffs || ["Write", "Edit", "MultiEdit", "NotebookEdit", "파일 변경", "write_file", "edit_file", "save_video"].includes(name)) return true;
  if (name === "run_command") {
    try { const command = JSON.parse(input).command; return typeof command !== "string" || !isReadCommand(command); }
    catch { return true; }
  }
  return ["Bash", "PowerShell", "명령"].includes(name) && !isReadCommand(input);
}
