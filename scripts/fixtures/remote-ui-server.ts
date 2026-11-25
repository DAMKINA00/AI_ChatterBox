// Remote web page against the real remote server (RemoteWeb: auth, CSP, routes, static files) with a fake
// core: synthetic projects, chats, a checklist, a review and messages. No app, no user data.
// Used by scripts/e2e-remote-ui-screens.mjs (bundled with esbuild).
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RemoteWeb } from "../../src/main/remote-web";
import { DEFAULT_SETTINGS, type Chat, type ChatAgent, type Consult, type ModelOption, type Project, type TimelineEvent } from "../../src/shared/types";
import type { PendingApproval } from "../../src/shared/event-page";
import { remoteError } from "../../src/main/remote-core";
import { CharacterMeeting } from "../../src/main/character-meeting";
import type { MeetingRequest } from "../../src/shared/character-meeting";

const NOW = Date.now();
const min = 60_000;

const project = (id: number, name: string): Project => ({ id, name, folder: `C:\\fixture\\${id}`, settings: { ...DEFAULT_SETTINGS }, createdAt: NOW - 30 * 24 * 60 * min, archived: false });
const PROJECTS = [project(1, "AI APPS"), project(2, "FantasyMasters"), project(3, "Photo")];

function chat(id: number, projectId: number, title: string, status: Chat["status"], minutesAgo: number, extra: Partial<Chat> = {}): Chat {
  return {
    id, projectId, title, status, unread: false, archived: false, createdAt: NOW - 600 * min, lastActiveAt: NOW - minutesAgo * min,
    orchClaudeSessionId: null, orchCodexThreadId: null, claudeSessionId: null, codexThreadId: null,
    orchestratorModelOverride: null, claudeModelOverride: null, codexModelOverride: null, geminiModelOverride: null, grokModelOverride: null, deepseekModelOverride: null,
    orchestratorEffortOverride: null, claudeEffortOverride: null, codexEffortOverride: null, geminiEffortOverride: null, grokEffortOverride: null, deepseekEffortOverride: null,
    approvalModeOverride: null, goal: null, sidebarOrder: 100 - id, ...extra,
  };
}

const CHATS: Chat[] = [
  chat(1, 1, "원격 웹 UI를 앱과 같게 개선", "done", 2),
  chat(2, 1, "사용량 모니터 정리", "done", 1200, { unread: true }),
  chat(3, 2, "카드 일러스트 교체 검토", "working", 1),
  chat(4, 2, "NAS 의존도 줄이기", "approval", 5),
  chat(5, 2, "복구 폴더 데이터 정리", "done", 180),
  chat(6, 3, "스냅샷 보정", "done", 48),
];

const AGENTS: ChatAgent[] = [
  { id: 1, chatId: 1, key: "w1", kind: "claude", number: 1, nickname: "클로드 1호", job: "로컬 Caddy 설정", sessionId: null, status: "released", createdAt: NOW - 50 * min } as ChatAgent,
  { id: 2, chatId: 1, key: "w2", kind: "gpt", number: 1, nickname: "지피티 1호", job: "비작성자 검증", sessionId: null, status: "released", createdAt: NOW - 40 * min } as ChatAgent,
];

const consult = (id: number, seq: number, to: "w1" | "w2", kind: Consult["kind"], request: string, summary: string, minutesAgo: number): Consult => ({
  id, chatId: 1, seq, fromRole: "orch", toRole: to, scope: [], kind, request, responseSummary: summary, filesChanged: [], status: "done",
  startedAt: NOW - minutesAgo * min, endedAt: NOW - (minutesAgo - 4) * min,
});
const CONSULTS: Consult[] = [
  consult(12, 12, "w1", "implement", "노트북 IP 확인, 로컬 Caddy 설정·문서를 새 IP에 맞춤", "로컬 구성은 IP에 의존하지 않아 바꿀 것이 없었습니다.", 40),
  consult(13, 13, "w1", "implement", "NAS Caddy를 새 IP·새 인증서로 변경", "NAS 설정 두 파일만 바꾸고 reload 했습니다.", 30),
  { ...consult(14, 14, "w2", "review", "비작성자 검증 및 공개 주소 확인", "공개 주소 200, 비로그인 401 확인.", 20),
    review: { verdict: "pass", revision: "작업 트리", summary: "의도한 줄만 바뀌었습니다.", findings: [{ severity: "low", message: "Caddyfile 권한이 넓습니다(사용자 결정 필요)." }], tests: [{ name: "공개 주소 응답", status: "passed" }, { name: "휴대폰 로그인", status: "not_run" }] } },
];

let eid = 0;
const ev = (event: TimelineEvent["event"], role: TimelineEvent["role"], minutesAgo: number, node: TimelineEvent["node"] = "orch", chatId = 1): TimelineEvent =>
  ({ id: ++eid, chatId, node, role, at: NOW - minutesAgo * min, event });

const REPORT = `NAS 설정을 바꿨고, **https://ai.damkina.net/ 이 이제 200으로 응답합니다.** 로그인 전 \`/api/chats\`는 401로 막혀 있습니다.

## NAS에서 바꾼 것
- \`Caddyfile\`: ai.damkina.net의 연결 대상 한 줄을 새 IP로 바꿨습니다.
- \`data/chatterbox-pc-root.crt\`: 이 노트북의 새 인증서로 교체했습니다.

## 검증
| 확인 | 결과 |
|---|---|
| 공개 주소 \`/\` | 200 |
| 비로그인 \`/api/chats\` | 401 |

\`\`\`sh
curl -sI https://ai.damkina.net/
\`\`\`

<script>alert("xss")</script> 위 줄은 원문 HTML이라 그대로 글자로만 보여야 합니다.`;

const EVENTS: TimelineEvent[] = [
  ev({ type: "user", text: "원격 웹 UI를 실제 프로그램과 같게 바꾸고, 휴대폰 화면도 만들어 줘.", attachments: [] }, null, 60, "orch"),
  ev({ type: "expression", expression: "thinking" }, "orch", 59),
  ev({ type: "text", text: "확인했습니다. 작업을 나눠 맡기겠습니다." }, "orch", 58),
  ev({ type: "plan_update", planId: 99, steps: [{ title: "연결 상태 확인", status: "completed" }] }, "orch", 58),
  ev({ type: "plan_state", planId: 99, state: "done" }, "orch", 58),
  ev({ type: "plan_update", planId: 1, steps: [
    { title: "노트북 IP 192.168.0.200 확인, 로컬 Caddy 설정·문서를 새 IP에 맞춤", status: "completed", owner: "클로드 1호", consultIds: [12] },
    { title: "NAS Caddy를 새 IP·새 인증서로 변경", status: "completed", owner: "클로드 1호", consultIds: [13] },
    { title: "비작성자 검증 및 공개 주소 확인", status: "completed", owner: "지피티 1호", consultIds: [14] },
    { title: "최종 보고", status: "inProgress", owner: "마스터" },
  ] }, "orch", 57),
  ev({ type: "consult_start", consultId: 12, kind: "implement", from: "orch", to: "w1", request: CONSULTS[0].request, attachments: [] }, "orch", 40),
  ev({ type: "consult_end", consultId: 12, status: "done", summary: CONSULTS[0].responseSummary!, files: [] }, "w1", 36, "consult:12"),
  ev({ type: "consult_start", consultId: 13, kind: "implement", from: "orch", to: "w1", request: CONSULTS[1].request, attachments: [] }, "orch", 30),
  ev({ type: "consult_end", consultId: 13, status: "done", summary: CONSULTS[1].responseSummary!, files: [] }, "w1", 26, "consult:13"),
  ev({ type: "consult_start", consultId: 14, kind: "review", from: "orch", to: "w2", request: CONSULTS[2].request, attachments: [] }, "orch", 20),
  ev({ type: "review_result", consultId: 14, review: CONSULTS[2].review! }, "w2", 16, "consult:14"),
  ev({ type: "consult_end", consultId: 14, status: "done", summary: CONSULTS[2].responseSummary!, files: [] }, "w2", 16, "consult:14"),
  ev({ type: "expression", expression: "happy" }, "orch", 3),
  ev({ type: "agent_usage", metrics: { turnId: "native-fixture-turn", nativeId: "native-fixture-session", elapsedMs: 10_000, inputTokens: 900, outputTokens: 248, cachedInputTokens: 20, cacheWriteInputTokens: 0 } }, "orch", 3),
  ev({ type: "text", text: REPORT }, "orch", 2),
  ev({ type: "turn_end", ok: true }, "orch", 2),
];

const APPROVAL_EVENTS: TimelineEvent[] = [
  ev({ type: "user", text: "NAS 의존도를 줄일 방법을 찾아 줘.", attachments: [] }, null, 10, "orch", 4),
  ev({ type: "text", text: "웹페이지 정적 파일을 PC로 옮기려면 명령 실행 승인이 필요합니다." }, "orch", 6, "orch", 4),
  ev({ type: "approval_request", request: { id: "ap-1", role: "orch", title: "명령 실행", detail: "robocopy dist C:\\site /MIR", risk: "high", riskReason: "폴더를 덮어씁니다." } }, "orch", 5, "orch", 4),
];
const WORKING_EVENTS = [
  ev({ type: "user", text: "카드 일러스트를 검토해 줘.", attachments: [] }, null, 2, "orch", 3),
  ev({ type: "expression", expression: "thinking" }, "orch", 2, "orch", 3),
];
const older: PendingApproval[] = [
  { eventId: 1, at: NOW - 80 * min, id: "older-1", role: "orch", title: "명령 실행", risk: "low" },
  { eventId: 2, at: NOW - 70 * min, id: "older-2", role: "orch", title: "파일 변경", risk: "high" },
];

const model = (id: string, label: string, isDefault = false): ModelOption => ({ id, label, isDefault, reasoningEfforts: ["low", "medium", "high"], defaultReasoningEffort: "medium" });
const MODELS: Record<string, ModelOption[]> = {
  claude: [model("opus", "Opus 5.5", true), model("sonnet", "Sonnet 5.5")],
  codex: [model("gpt-6-astra", "6.2-Sol", true)],
  gemini: [model(DEFAULT_SETTINGS.geminiModel, "4 Hydrogen", true)],
  grok: [model("", "Grok 4.7", true)],
  deepseek: [model("deepseek-flash", "Flash", true)],
};

const accounts = [
  { accountId: "claude-1", kind: "claude", label: "클로드", configDir: null, enabled: true, createdAt: NOW, isDefault: true, authStatus: "authenticated", runningWorkers: 0, usage: { weekly: { usedPercent: 53, resetsAt: NOW + 2 * 864e5 }, checkedAt: NOW } },
  { accountId: "gpt-1", kind: "gpt", label: "PRIVATE", configDir: null, enabled: true, createdAt: NOW, isDefault: true, authStatus: "authenticated", runningWorkers: 0, usage: { weekly: { usedPercent: 37, resetsAt: NOW + 3 * 864e5 }, checkedAt: NOW } },
  { accountId: "gpt-2", kind: "gpt", label: "PUBLIC", configDir: null, enabled: true, createdAt: NOW, isDefault: false, authStatus: "authenticated", runningWorkers: 0, usage: { weekly: { usedPercent: 32, resetsAt: NOW + 5 * 864e5 }, checkedAt: NOW } },
  { accountId: "gpt-3", kind: "gpt", label: "PUBLIC", configDir: null, enabled: true, createdAt: NOW, isDefault: false, authStatus: "authenticated", runningWorkers: 0, usage: { weekly: { usedPercent: 26, resetsAt: NOW + 6 * 864e5 }, checkedAt: NOW } },
  { accountId: "gemini-1", kind: "gemini", label: "안티그래비티", configDir: null, enabled: true, createdAt: NOW, isDefault: true, authStatus: "authenticated", runningWorkers: 0, usage: { weekly: { usedPercent: 0 }, checkedAt: NOW } },
  { accountId: "grok-1", kind: "grok", label: "그록", configDir: null, enabled: true, createdAt: NOW, isDefault: true, authStatus: "authenticated", runningWorkers: 0, usage: { weekly: { usedPercent: 18 }, checkedAt: NOW } },
];

export async function startFixture(staticDir: string, password: string) {
  const dir = mkdtempSync(join(tmpdir(), "cbx-remote-ui-"));
  const calls: string[] = [];
  const chats = structuredClone(CHATS);
  const projects = structuredClone(PROJECTS);
  let nextChatId = 7;
  const liveEvent = (chatId: number, event: TimelineEvent["event"]) =>
    remote.publish("chat:event", [{ id: ++eid, chatId, node: "orch", role: "orch", at: Date.now(), event }]);
  const patchChat = (id: number, patch: Partial<Chat>, publish = true) => {
    const current = chats.find(c => c.id === id)!;
    Object.assign(current, patch);
    if (publish) remote.publish("chat:updated", [current]);
    return current;
  };
  const meeting = new CharacterMeeting({
    configured: () => ["claude", "codex", "deepseek"],
    meetingReply: async (agent, _model, input, signal, stream) => {
      if (!stream) return '{"assignee":"gpt","task":"비교 기준 검토","keywords":[]}';
      if (agent === "codex") {
        stream("비교 기준을 확인하고 있어요.");
        await new Promise(resolve => setTimeout(resolve, 1_200));
        signal.throwIfAborted();
        return "검토를 마쳤어요.\n\n| 방안 | 검토 |\n| --- | --- |\n| A | 추천 |\n\n![회의 자료](https://images.example/meeting.png)";
      }
      if ("reviews" in input) return "A안을 추천합니다.";
      return "추천 결과에 동의합니다.";
    },
  }, () => ({}), event => remote.publish("boardroom:event", [event]));
  const remote = new RemoteWeb({
    file: join(dir, "remote-web.json"), staticDir,
    call: async (channel, args) => {
      calls.push(channel);
      const id = args[0] as number;
      switch (channel) {
        case "monitor:meeting-snapshot": return meeting.snapshot();
        case "monitor:meeting-submit":
          try { void meeting.start(args[0] as MeetingRequest); return true; }
          catch { return false; }
        case "monitor:meeting-cancel": meeting.cancel(String(args[0])); return undefined;
        case "chats:list": return chats;
        case "projects:list": return projects;
        case "chats:eventsPage": {
          const events = id === 1 ? EVENTS : id === 3 ? WORKING_EVENTS : id === 4 ? APPROVAL_EVENTS : [];
          const snapshot = id === 4 ? { plan: { view: null, state: "live", stepsOmitted: 0 }, approvals: { pending: older.slice(0, 1), total: older.length }, goal: null, conversations: [] } : undefined;
          return { events, start: events[0]?.id ?? 0, hasMore: !!snapshot, ...(args[1] === undefined ? { context: [], ...(snapshot ? { snapshot } : {}) } : {}) };
        }
        case "chats:pendingApprovals": return { items: older.slice(Number(args[2]), Number(args[2]) + 1), total: older.length };
        case "chats:reorder": {
          const moving = chats.find(c => c.id === id)!;
          const ordered = chats.filter(c => c.projectId === moving.projectId && c.id !== id).sort((a, b) => (b.sidebarOrder ?? 0) - (a.sidebarOrder ?? 0));
          ordered.splice(ordered.findIndex(c => c.id === args[1]) + Number(args[2] === "after"), 0, moving);
          return ordered.map((c, i) => patchChat(c.id, { sidebarOrder: ordered.length - i }));
        }
        case "remote:chat-patch": {
          const patch = args[1] as Partial<Chat>;
          if (patch.approvalModeOverride === "orchestrator-all" && args[2] !== true) throw remoteError(428, "승인 범위를 넓힐까요?");
          return { chat: patchChat(id, patch) };
        }
        case "remote:project-patch": {
          const project = projects.find(p => p.id === id)!;
          const { settings, ...patch } = args[1] as Partial<Project>;
          Object.assign(project, patch);
          Object.assign(project.settings, settings);
          return { project };
        }
        case "remote:chat-delete": {
          const current = chats.find(c => c.id === id);
          if (!current) throw remoteError(404, "채팅이 없습니다.");
          const expected = args[2] as Pick<Chat, "createdAt" | "projectId"> | undefined;
          if (expected && (current.createdAt !== expected.createdAt || current.projectId !== expected.projectId || current.title !== args[1]))
            throw remoteError(412, "삭제할 채팅이 바뀌었습니다.");
          chats.splice(chats.indexOf(current), 1);
          return undefined;
        }
        case "remote:fork-anchor": return id === 1 ? { id: EVENTS[0].id, preview: "이전 페이지의 분기 기준" } : null;
        case "remote:chat-fork": {
          const source = chats.find(c => c.id === id)!;
          const options = args[1] as { eventId: number; range: "through" | "from"; includeAttachments: boolean };
          const branched = chat(nextChatId++, source.projectId, `${source.title} (분기)`, "idle", 0,
            { fork: { sourceChatId: id, sourceEventId: options.eventId, sourceTitle: source.title, range: options.range, includeAttachments: options.includeAttachments } });
          chats.push(branched);
          return branched;
        }
        case "remote:send": liveEvent(id, { type: "text", text: "원격 지시를 받았습니다." }); return undefined;
        case "chats:pause": patchChat(id, { status: "paused" }); return undefined;
        case "chats:resume": patchChat(id, { status: "working" }); return undefined;
        case "chats:agents": return id === 1 ? AGENTS : [];
        case "chats:consults": return id === 1 ? CONSULTS : [];
        case "chats:search": return [];
        case "chats:runStats": return { total: { eventCount: EVENTS.length }, roles: [], consults: [] };
        case "models:list": return MODELS[args[0] as string] ?? [];
        case "cli:info": return [
          { agent: "claude", path: "C:\\fixture\\claude.exe", authStatus: "authenticated" }, { agent: "codex", path: "C:\\fixture\\codex.exe", authStatus: "authenticated" },
          { agent: "gemini", path: "C:\\fixture\\agy.exe", authStatus: "authenticated" }, { agent: "grok", path: "C:\\fixture\\grok.exe", authStatus: "authenticated" },
          { agent: "deepseek", path: "api", authStatus: "authenticated" },
        ];
        case "usage:get": return { deepseek: { state: "ready", balances: [{ currency: "USD", total: "5.21", granted: "0", toppedUp: "5.21" }], updatedAt: NOW } };
        case "cli-accounts:list": return accounts;
        case "chats:viewed": case "chats:markViewed": return undefined;
        default: return [];
      }
    },
  });
  const port = 47000 + Math.floor(Math.random() * 900);
  await remote.action("set-password", { password });
  await remote.action("update", { enabled: true, port, publicOrigin: `http://127.0.0.1:${port}` });
  return {
    base: `http://127.0.0.1:${port}`, calls,
    /** A core change event, as the app would forward it (a live reply in chat 1). */
    liveText: (chatId: number, text: string) => liveEvent(chatId, { type: "text", text }),
    expression: (chatId: number, expression: "thinking" | "happy") => liveEvent(chatId, { type: "expression", expression }),
    updateStatus: (chatId: number, status: Chat["status"]) => patchChat(chatId, { status }),
    changeChat: patchChat,
    deleteExternally(chatId: number) {
      chats.splice(chats.findIndex(c => c.id === chatId), 1);
      remote.publish("chat:deleted", [chatId]);
    },
    async stop() { await meeting.dispose(); await remote.stop(); rmSync(dir, { recursive: true, force: true }); },
  };
}
