import { existsSync, mkdirSync, readdirSync, renameSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

/** Claude -p has no native archive API. Move only our closed session's transcript and sidecars
 * outside the CLI's projects scan; restore them before --resume. Never delete history. */
export class ClaudeSessionArchive {
  constructor(private configDir = process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude")) {}

  archive(id: string) { this.move(id, "projects", "chatterbox-archived-sessions"); }
  restore(id: string) { this.move(id, "chatterbox-archived-sessions", "projects"); }

  private move(id: string, from: string, to: string) {
    if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id)) throw new Error("잘못된 Claude 대화 ID");
    const sourceRoot = join(this.configDir, from);
    if (!existsSync(sourceRoot)) return;
    const projects = readdirSync(sourceRoot, { withFileTypes: true }).filter((d) => d.isDirectory() && !d.isSymbolicLink()
      && existsSync(join(sourceRoot, d.name, `${id}.jsonl`)));
    if (!projects.length) return; // new or already restored/archived
    if (projects.length !== 1) throw new Error("같은 Claude 대화 기록이 여러 곳에 있어 보관을 건너뜁니다.");
    const project = projects[0].name;
    const source = join(sourceRoot, project), destination = join(this.configDir, to, project);
    // A future CLI index format must be handled explicitly; do not leave stale picker entries.
    if (existsSync(join(source, "sessions-index.json")) || existsSync(join(destination, "sessions-index.json")))
      throw new Error("이 Claude 버전의 대화 색인 형식은 자동 보관을 지원하지 않습니다.");
    const names = [`${id}.jsonl`, id].filter((name) => existsSync(join(source, name)));
    if (names.some((name) => existsSync(join(destination, name)))) throw new Error("복원 위치에 같은 Claude 기록이 있어 덮어쓰지 않았습니다.");
    mkdirSync(destination, { recursive: true });
    const moved: string[] = [];
    try {
      for (const name of names) { renameSync(join(source, name), join(destination, name)); moved.push(name); }
    } catch (error) {
      for (const name of moved.reverse()) renameSync(join(destination, name), join(source, name));
      throw error;
    }
  }
}
