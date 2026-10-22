import { app } from "electron";
import { createServer, type Server } from "node:net";
import { randomBytes } from "node:crypto";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { CoreRpc } from "./core-rpc";

const psQuote = (value: string) => `'${value.replace(/'/g, "''")}'`;
const windowsArg = (value: string) => `"${value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, "$1$1")}"`;

/** Tests use the same process boundary without UAC unless explicitly requested. */
export async function launchCore(dataDir: string, test: boolean): Promise<CoreRpc> {
  const token = randomBytes(32).toString("hex");
  const pipe = process.platform === "win32" ? `\\\\.\\pipe\\chatterbox-core-${randomBytes(16).toString("hex")}` : `${dataDir}/core-${process.pid}.sock`;
  const args = [
    ...(!app.isPackaged ? [app.getAppPath()] : []),
    "--agent-core", `--core-pipe=${pipe}`, `--core-token=${token}`, `--core-data=${dataDir}`,
    ...(test ? ["--test-data"] : []),
  ];
  let server: Server;
  let child: ChildProcess | undefined;
  let launcher: ChildProcess | undefined;
  const peers = new Set<CoreRpc>();
  return new Promise<CoreRpc>((resolve, reject) => {
    let finished = false;
    const timer = setTimeout(() => fail(new Error("관리자 코어가 시작되지 않았습니다. Windows 승인 창을 확인해 주세요.")), 120_000);
    const fail = (error: Error) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      server?.close();
      for (const peer of peers) peer.close();
      child?.kill();
      launcher?.kill();
      reject(error);
    };
    server = createServer(socket => {
      const peer = new CoreRpc(socket, token);
      peers.add(peer);
      peer.onClose = () => peers.delete(peer);
      void peer.ready.then(() => {
        if (finished) return peer.close();
        finished = true;
        clearTimeout(timer);
        server.close();
        for (const other of peers) if (other !== peer) other.close();
        resolve(peer);
      }).catch(() => peers.delete(peer));
    });
    server.once("error", fail);
    server.listen(pipe, () => {
      const elevate = process.platform === "win32" && (!test || process.argv.includes("--elevate-test-core"));
      if (elevate) {
        const command = `$ErrorActionPreference='Stop'; Start-Process -FilePath ${psQuote(process.execPath)} -ArgumentList ${psQuote(args.map(windowsArg).join(" "))} -Verb RunAs -WindowStyle Hidden`;
        launcher = execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(command, "utf16le").toString("base64")], { windowsHide: true }, error => {
          if (error) fail(new Error("관리자 코어 실행이 취소됐거나 실패했습니다. 다시 실행해 Windows 권한 요청을 승인해 주세요."));
        });
      } else {
        child = spawn(process.execPath, args, { windowsHide: true, stdio: "ignore", env: process.env });
        child.once("error", fail);
        child.once("exit", () => fail(new Error("코어 프로세스가 시작 중 종료됐습니다.")));
      }
    });
  });
}
