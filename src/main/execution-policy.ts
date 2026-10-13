/** Conservative commands allowed by our gate while planning/reviewing. No shell composition. */
export function isReadCommand(command: string): boolean {
  const s = command.trim();
  if (!s || /[;&|<>`$\r\n(){}]/.test(s)) return false;
  if (/^git\s+(status|diff|log|show|ls-files|rev-parse)\b/i.test(s))
    return !/--(output|ext-diff|textconv|exec-path)|\s-c\s/i.test(s);
  return /^(pwd|ls|cat|head|tail|wc|rg|Get-Content|Get-ChildItem|Get-Item|Test-Path|Select-String|Get-Location)\b/i.test(s)
    && !/(?:^|\s)(?:-exec|-delete|--pre(?:=|\s)|--pre-glob|-OutVariable|-ov|-PipelineVariable|-pv)\b/i.test(s);
}

export function isMutatingTool(name: string, input: string, hasDiffs = false): boolean {
  if (hasDiffs || ["Write", "Edit", "MultiEdit", "NotebookEdit", "파일 변경"].includes(name)) return true;
  return ["Bash", "PowerShell", "명령"].includes(name) && !isReadCommand(input);
}
