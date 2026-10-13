// One AI_ChatterBox per data folder, across versions. 0.2.1+ instances hold Electron's single-instance
// lock; 0.2.0 doesn't, so we also look for another process using our --user-data-dir. Two instances on
// the same DB would resume the same Claude/Codex sessions concurrently, so we never open a second one.
// Runs before the Store opens the DB (opening it marks running chats as interrupted).
import { dialog } from "electron";
import { execFile, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

function otherInstancePid(userData: string): Promise<number | null> {
  if (process.platform !== "win32") return Promise.resolve(null);
  const ps =
    "Get-CimInstance Win32_Process -Filter \"Name='AI_ChatterBox.exe' OR Name='electron.exe'\" | " +
    "Select-Object ProcessId,ParentProcessId,CommandLine | ConvertTo-Json -Compress";
  return new Promise((resolve) => {
    execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", ps], { windowsHide: true, timeout: 15000 }, (err, out) => {
      if (err || !out.trim()) return resolve(null);
      try {
        const rows = [].concat(JSON.parse(out)) as { ProcessId: number; ParentProcessId: number; CommandLine: string | null }[];
        const needle = `--user-data-dir=${userData}`.toLowerCase();
        // Chromium child processes carry --user-data-dir; their parent is the other app's main process.
        const child = rows.find(
          (r) =>
            r.CommandLine &&
            r.CommandLine.replace(/"/g, "").toLowerCase().includes(needle) &&
            r.ParentProcessId !== process.pid &&
            r.ProcessId !== process.pid,
        );
        resolve(child ? child.ParentProcessId : null);
      } catch {
        resolve(null);
      }
    });
  });
}

function busyChats(dbFile: string): number {
  if (!existsSync(dbFile)) return 0;
  try {
    const db = new DatabaseSync(dbFile, { readOnly: true });
    try {
      const r = db.prepare("SELECT COUNT(*) n FROM chats WHERE status IN ('working','approval')").get() as { n: number };
      return r.n;
    } finally {
      db.close();
    }
  } catch {
    return 0;
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Resolves true when this instance may open the data folder; false = quit. */
export async function ensureOnlyInstance(userData: string, dbFile: string): Promise<boolean> {
  for (;;) {
    const pid = await otherInstancePid(userData);
    if (!pid) return true;
    console.log(`[guard] another AI_ChatterBox (pid ${pid}) uses ${userData}`);
    const busy = busyChats(dbFile);
    const buttons = ["이전 창 보기", "다시 시도", ...(busy === 0 ? ["이전 버전 종료 후 열기"] : []), "닫기"];
    const r = await dialog.showMessageBox({
      type: "warning",
      title: "AI_ChatterBox",
      message: "이전 버전이 실행 중입니다.",
      detail:
        (busy > 0 ? `진행 중인 작업이 ${busy}개 있습니다. ` : "") +
        "작업이 끝나면 이전 버전을 종료한 뒤 다시 실행하세요. 같은 채팅을 두 곳에서 동시에 열면 작업이 꼬일 수 있어 새 창을 열지 않습니다.",
      buttons,
      defaultId: 0,
      cancelId: buttons.length - 1,
      noLink: true,
    });
    const choice = buttons[r.response];
    if (choice === "이전 창 보기") {
      spawnSync("powershell.exe", ["-NoProfile", "-Command", `(New-Object -ComObject WScript.Shell).AppActivate(${pid}) | Out-Null`], { windowsHide: true });
      return false;
    }
    if (choice === "닫기") return false;
    if (choice === "이전 버전 종료 후 열기") {
      // Graceful: ask its window to close (no /F). Only offered while nothing is running.
      spawnSync("taskkill", ["/PID", String(pid)], { windowsHide: true });
      for (let i = 0; i < 60 && alive(pid); i++) await new Promise((res) => setTimeout(res, 500));
      if (alive(pid)) {
        await dialog.showMessageBox({ type: "info", message: "이전 버전이 아직 종료되지 않았습니다.", detail: "이전 버전 창을 직접 닫은 뒤 다시 시도하세요.", buttons: ["확인"] });
      }
    }
    // "다시 시도" or after closing: check again.
  }
}
