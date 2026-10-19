// Collaboration engine: one master (마스터, Claude or Codex) and a pool of workers
// (클로드 N호 / 지피티 N호) the master spawns and releases as the work needs. Everyone talks through
// the Bridge MCP server:
//   master:  spawn · ask · release · agents · checklist · update_goal · ask_user
//   workers: ask · agents          (call each other by nickname)
// An "ask" runs one turn on the target worker's own Claude session / Codex thread, streams it into the
// chat under a consult node, and returns the answer + changed files as the tool result.
// Parallelism: a worker runs one turn at a time; review/opinion asks run concurrently; implement asks
// carry a scope (path globs) — non-overlapping scopes run concurrently, overlapping ones queue, and
// writes outside the scope are denied. A call that would wait in a cycle, or nest deeper than 3, is refused.
import { createHash, randomUUID } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { basename, isAbsolute, relative, resolve as resolvePath } from "node:path";
import {
  chatOrchestrator,
  AGENT_EXPRESSIONS,
  GEMINI_WRITING_INSTRUCTIONS,
  AGENT_LABEL,
  isAgentExpression,
  CONSULT_KIND_LABEL,
  MASTER_LABEL,
  WORKER_KIND_LABEL,
  WORKER_AGENT,
  isWorkerKey,
  roleName,
  type AgentEvent,
  type AgentKind,
  type AttachmentRef,
  type Chat,
  type ChatAgent,
  type ChatGoal,
  type ConsultKind,
  type NodeId,
  type PlanStep,
  type Project,
  type Role,
  type WorkerKind,
  type GeminiWebAccountId,
} from "../shared/types";
import type { ChatManager } from "./chats";
import { bridgeServerConfig, textResult, type ToolDef, type ToolResult } from "./local-bridge";
import { mimeOf } from "./attachments";
import type { AgentInput } from "./drivers/types";
import { ApprovalJudge } from "./judge";
import { scopesOverlap } from "./scope";
import { isMutatingTool, isReadCommand } from "./execution-policy";
import type { ApprovalInput } from "./approvals";
import { addWait, checkAsk, removeWait, type WaitGraph } from "./team";
import { completionIssue, dualInvestigationIssue } from "./dispatch";
import { WORKER_EFFORTS } from "./effort";
import { conversationAccount, webAccountId } from "./drivers/gemini-web-protocol";
import { WEB_LOW_REMAINING } from "./drivers/gemini-web-accounts";
import { isAIStudioModel } from "../shared/aistudio";

const KINDS: ConsultKind[] = ["implement", "review", "opinion", "writing"];
const MAX_DEPTH = 3;
const MAX_GOAL_TURNS = 6;
const WEB_ACCOUNT_INPUT = { type: "string", pattern: "^gemini-([1-9]|10)$", description: "마스터가 잔여량을 확인해 선택한 Gemini 웹 계정 ID. spawn 시 필수이며 ask에서는 기존 작업자의 계정을 변경할 때 지정합니다. 자동으로 다른 계정으로 바꾸지 않습니다." };
const WEB_ACCOUNTS_TOOL: ToolDef = {
  name: "gemini_web_accounts",
  description: "마스터가 직접 전체 Gemini 웹 계정의 잔여량·조회 시각·로그인·작업 상태와 작업자 연결을 확인합니다. 기본은 사용량 갱신. 모두 작업 중/잔여량 부족이면 waitForAvailable=true로 10초마다 재확인하며 기다립니다. 계정을 선택하거나 작업자를 실행하지 않으며 선택은 마스터가 spawn/ask의 webAccountId로 합니다.",
  inputSchema: { type: "object", properties: { refresh: { type: "boolean" }, waitForAvailable: { type: "boolean" } }, additionalProperties: false },
};
const DISCUSSION_INPUT = {
  type: "object", description: "관련 쟁점을 작업자끼리 직접 토의할 그룹. to는 진행자, peers는 의견을 주고받을 다른 작업자 닉네임입니다. opinion 또는 writing 전용이며 진행자는 각 참여자의 실제 응답을 취합해야 합니다.",
  properties: { topic: { type: "string" }, peers: { type: "array", items: { type: "string" }, minItems: 1, uniqueItems: true } },
  required: ["topic", "peers"], additionalProperties: false,
};

const ROUTE_TOOL: ToolDef = {
  name: "route_request",
  description: "사용자 지시마다 첫 단계로 처리 방식을 기록합니다. direct=간단한 답변·사전 확인만, delegated=본 작업 위임. 중요한 버그 수정·오류 분석은 delegated와 dualInvestigation=true로 기록하고 reason에 중요도를 판단한 이유를 적으세요. 팀의 모델·도구·사용량을 반환합니다. 위임은 앱 spawn/ask만 사용하세요.",
  inputSchema: { type: "object", properties: { mode: { type: "string", enum: ["direct", "delegated"] }, reason: { type: "string" }, dualInvestigation: { type: "boolean", description: "중요한 버그·오류를 클로드와 지피티 양쪽이 독립 조사해야 하면 true. 수정 전 두 계열의 opinion 결과가 필요합니다." } }, required: ["mode", "reason"], additionalProperties: false },
};

const EXPRESSION_TOOL: ToolDef = {
  name: "set_expression",
  description: "다음 대사의 감정에 맞는 얼굴 표정을 지정합니다. 본문은 그대로 쓰고 대사 전 한 번만 호출하세요. 사실 판단이나 작업 성공 여부를 바꾸지 않습니다.",
  inputSchema: { type: "object", properties: { expression: { type: "string", enum: [...AGENT_EXPRESSIONS] } }, required: ["expression"], additionalProperties: false },
};

// ---------- tool definitions
const ASK_TOOL = (forMaster: boolean): ToolDef => ({
  name: "ask",
  description:
    "작업자에게 닉네임으로 일을 맡기거나 질문하고 결과를 기다립니다 (예: to=\"클로드 2호\"). 받는 쪽은 이 대화를 보지 못하므로 message에 목표, 관련 파일, 조건, 완료 기준을 모두 적으세요. " +
    "kind: implement=구현·수정(받는 작업자가 파일을 고침, scope로 고칠 범위를 지정), review=기술 리뷰, opinion=의견·분석, writing=문장 다듬기·캐릭터 대사·문서 본문 등 글쓰기(파일을 고치지 않고 텍스트만 반환). 사용자가 담당을 명시하면 그 작업자에게 지정한 종류 그대로 맡깁니다. Gemini 웹은 로컬 코드·명령을 실행할 수 없습니다. " +
    "scope(implement 전용): 고쳐도 되는 경로 glob 목록(작업 폴더 기준, 예: [\"src/ui/**\", \"README.md\"]). 범위가 겹치지 않는 구현은 동시에 진행되고, 범위 밖 쓰기는 거부됩니다. " +
    (forMaster ? "관련 쟁점을 묶어 토의하려면 discussion={topic, peers}를 지정해 CLI 진행자에게 맡기세요. 진행자가 참여자에게 직접 ask로 묻고 결과를 취합합니다. 독립적인 일은 ask_parallel을 사용하세요." : "토의 진행자로 지정되면 참여 작업자에게 직접 ask하고 합의·이견·근거를 취합하세요. 마스터에게는 ask를 쓰지 말고 결과 보고에 질문을 포함하세요."),
  inputSchema: {
    type: "object",
    properties: {
      to: { type: "string", description: "받는 작업자 닉네임 (예: 클로드 1호, 지피티 2호)" },
      message: { type: "string" },
      kind: { type: "string", enum: KINDS },
      reason: { type: "string", description: "이 작업자를 선택한 이유. 마스터 배정 시 필수." },
      ...(forMaster ? { effort: { type: "string", enum: [...WORKER_EFFORTS], description: "추론 수준. 일반 작업 medium, 복잡한 분석·구현 high, 가장 어려운 추론·검증 xhigh. 모델 지원 범위를 확인하고 reason에 선택 근거를 적으세요." } } : {}),
      ...(forMaster ? { discussion: DISCUSSION_INPUT } : {}),
      ...(forMaster ? { webAccountId: WEB_ACCOUNT_INPUT } : {}),
      requiresImage: { type: "boolean", description: "실제 이미지 생성·편집 도구가 필요한 작업이면 true" },
      supersedes: { type: "integer", description: "이 배정으로 보완할 실패한 협의 id" },
      scope: { type: "array", items: { type: "string" } },
      ...(forMaster ? { attach: { type: "array", items: { type: "string" }, description: "함께 보낼 파일 절대경로 (사용자 첨부 이미지 등)" } } : {}),
    },
    required: ["to", "message", "kind", ...(forMaster ? ["reason", "effort"] : [])],
  },
});
const ASK_PARALLEL_TOOL: ToolDef = {
  name: "ask_parallel",
  description:
    "서로 독립적인 일을 여러 작업자에게 동시에 맡기고, 모두 끝나면 결과를 한꺼번에 돌려받습니다. tasks 항목은 ask와 같습니다(to, message, kind, scope). " +
    "구현을 나눠 맡길 때는 scope를 서로 겹치지 않게 주세요. 순서가 있는 일은 ask를 차례로 쓰세요.",
  inputSchema: {
    type: "object",
    properties: {
      tasks: {
        type: "array",
        items: {
          type: "object",
          properties: {
            to: { type: "string" },
            message: { type: "string" },
            kind: { type: "string", enum: KINDS },
            reason: { type: "string" },
            effort: { type: "string", enum: [...WORKER_EFFORTS] },
            requiresImage: { type: "boolean" },
            supersedes: { type: "integer" },
            attach: { type: "array", items: { type: "string" } },
            scope: { type: "array", items: { type: "string" } },
            discussion: DISCUSSION_INPUT,
            webAccountId: WEB_ACCOUNT_INPUT,
          },
          required: ["to", "message", "kind", "reason", "effort"],
        },
      },
    },
    required: ["tasks"],
  },
};

const SPAWN_TOOL: ToolDef = {
  name: "spawn",
  description:
    "해제된 같은 계열의 작업자를 낮은 번호부터 다시 활성화하며, 없을 때 새로 만듭니다. kind=claude → 클로드 N호(Claude Code), kind=gpt → 지피티 N호(Codex), kind=gemini → Antigravity N호, kind=grok → Grok N호. 이전 번호·대화 기록을 유지합니다. job에 맡길 역할을 한 줄로 적으세요. 동시에 필요한 수만 확보하세요.",
  inputSchema: {
    type: "object",
    properties: { kind: { type: "string", enum: ["claude", "gpt", "gemini", "grok"] }, job: { type: "string" }, webAccountId: WEB_ACCOUNT_INPUT },
    required: ["kind", "job"],
  },
};
const RELEASE_TOOL: ToolDef = {
  name: "release",
  description: "더 필요 없는 작업자를 해제합니다 (닉네임). 다음 spawn에서 같은 번호와 대화 기록으로 다시 활성화할 수 있습니다.",
  inputSchema: { type: "object", properties: { nickname: { type: "string" } }, required: ["nickname"] },
};
const MESSAGE_TOOL: ToolDef = {
  name: "send_message",
  description: "동료 또는 마스터에게 진행 상황·인터페이스·질문을 보내고 즉시 계속 작업합니다. 상대의 다음 앱 도구 호출/작업 시작 시 전달됩니다. 작업 중인 동료에게는 ask로 기다리지 말고 이 도구를 쓰세요. 명령 실행이나 새 작업 시작을 대신하지 않습니다.",
  inputSchema: { type: "object", properties: { to: { type: "string" }, message: { type: "string" } }, required: ["to", "message"], additionalProperties: false },
};
const MESSAGES_TOOL: ToolDef = {
  name: "read_messages", description: "나에게 온 새 협업 메시지를 확인합니다. 인터페이스 변경 전과 결과 보고 전에 확인하세요.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
};
const AGENTS_TOOL: ToolDef = {
  name: "agents",
  description: "이 채팅의 팀 목록: 닉네임, 종류, 맡은 역할, 상태(대기/작업 중/해제). 마스터에게는 현재 지시의 최근 협의 결과도 반환합니다. 즉시 추가 지시로 ask 응답을 놓쳤으면 재배정하기 전에 여기서 확인하세요.",
  inputSchema: { type: "object", properties: {} },
};
const CHECKLIST_TOOL: ToolDef = {
  name: "checklist",
  description:
    "작업 체크리스트를 등록·갱신합니다 (화면 상단 카드). 전체 단계 목록을 매번 보내세요. 각 단계 제목 앞에 담당을 붙이세요 (예: \"[클로드 1호] 로그인 화면 수정\"). status: pending | inProgress | completed.",
  inputSchema: {
    type: "object",
    properties: {
      steps: {
        type: "array",
        items: {
          type: "object",
          properties: { title: { type: "string" }, status: { type: "string", enum: ["pending", "inProgress", "completed"] } },
          required: ["title", "status"],
        },
      },
    },
    required: ["steps"],
  },
};
const GOAL_TOOL: ToolDef = {
  name: "update_goal",
  description:
    "이 채팅에 /goal 로 정해진 목표의 진행 상황을 보고합니다. 한 단계를 마칠 때마다 progress에 지금까지 한 일과 남은 일을 한두 문장으로 적고, 목표를 다 이루면 status=complete, 사용자 결정 없이는 더 못 나가면 status=blocked.",
  inputSchema: {
    type: "object",
    properties: { status: { type: "string", enum: ["active", "complete", "blocked"] }, progress: { type: "string" } },
    required: ["status", "progress"],
  },
};
const ASK_USER_TOOL: ToolDef = {
  name: "ask_user",
  description: "진행에 꼭 필요한 결정을 사용자에게 묻고 답을 기다립니다. 선택지가 있으면 options로 주세요. 사소한 일은 묻지 말고 스스로 판단하세요.",
  inputSchema: {
    type: "object",
    properties: { question: { type: "string" }, options: { type: "array", items: { type: "string" } } },
    required: ["question"],
  },
};

function masterInstructions(project: Project, agent: AgentKind): string {
  const s = project.settings;
  const t = (n: string) => (agent === "claude" ? `mcp__chatterbox_bridge__${n}` : n);
  return [
    "# 역할: AI_ChatterBox 마스터",
    `너는 사용자의 지시를 받아 팀을 꾸리고 일을 나눠 맡기는 마스터다. 작업 폴더: ${project.folder}`,
    "- 너는 배정·검토·취합 담당이다. 간단한 질문·짧은 설명·이미 주어진 정보만으로 답할 수 있는 확인은 direct로 기록한 뒤 작업자를 생성하거나 호출하지 않고 직접 답한다. 소스 분석·원인 조사·구현·이미지·문서 제작 등 본 작업은 반드시 앱 작업자에게 맡긴다. 결과에 누락·모순이 있으면 보완 요청하고 최종 답변을 취합한다. 사용자가 명시적으로 직접 수행을 요구한 예외에도 기존 승인·작업 범위 규칙을 지킨다.",
    `- 지시마다 먼저 ${t("route_request")}(mode=direct|delegated, reason=이유)를 호출한다. 반환되는 실제 사용 가능 도구·모델·사용량으로 후보를 확인한다. 도구 사용 불가/미확인은 가능하다고 가정하지 않는다.`,
    "- 모든 위임은 이 앱의 chatterbox_bridge spawn/ask/ask_parallel만 사용한다. CLI 내부 spawn_agent/Agent/Task/팀 도구나 별도 CLI 프로세스로 작업자를 만들지 않는다. 글로벌 스킬의 Luna 선호와 관계없이 앱 상단에서 선택한 Claude·Codex·Antigravity·Grok 모델을 사용한다.",
    "- 마스터 기본 추론은 xhigh다. 작업자의 추론은 마스터가 배정마다 effort=medium|high|xhigh로 선택한다. 일반·범위가 명확한 작업은 medium, 복잡한 분석·구현은 high, 가장 어려운 원인 추론·중요 검증은 xhigh를 쓴다. route_request의 reasoningEfforts에 나온 지원 수준 안에서 고르고 reason에 담당자와 추론 수준 선택 근거를 함께 적는다. Gemini Pro가 medium/high만 제공하면 그중 고른다. low/max를 지정하거나 CLI·환경 설정으로 우회하지 않는다. 사용자가 수동 지정한 추론은 우선 적용된다.",
    `- 클로드 선호 작업: ${s.claudeStrengths}\n  주의점: ${s.claudeCautions}`,
    `- 지피티 선호 작업: ${s.gptStrengths}\n  주의점: ${s.gptCautions}`,
    `- Grok 선호 작업: ${s.grokStrengths} 주의점: ${s.grokCautions}`,
    "- 사용자가 이름·봇·CLI를 명시한 작업은 그 담당에게 우선 배정한다. 글쓰기·코드·이미지의 기본 선호는 명시적 지정을 덮어쓰지 않는다. Gemini는 Antigravity 작업자를 뜻하며 웹 모델을 선택했을 때만 Gemini 웹으로 실행한다. 다른 봇으로 임의 변경하지 말고 실제 도구 오류와 한도를 보고한다.",
    `- 제미나이 선호 작업: ${s.geminiStrengths}\n  주의점: ${s.geminiCautions}` ,
    "- 글쓰기 본 작업은 제미나이에게 kind=writing으로 배정한다. 요청에 독자·목적·분량·말투와 확인된 사실, 캐릭터 대사에는 성격·관계·상황·말투 예시를 전달한다. 기술 문서는 클로드·지피티가 사실을 확인 → 제미나이가 본문을 작성·다듬기 → 클로드·지피티가 기술 내용과 파일 반영을 확인한다. 제미나이가 비활성·한도·실패 상태면 이유를 기록하고 글쓰기를 클로드·지피티에 재배정할 수 있다. 간단한 답변은 마스터가 직접 한다.",
    "- Gemini 웹 계정 판단·선택은 마스터가 직접 한다. 제미나이 1호 등 작업자에게 계정 선택을 맡기지 않는다. gemini_web_accounts로 전체 계정의 remainingPercent, usage.checkedAt, state, enabled를 확인한다. 이전 작업자의 계정이 대기 상태이고 잔여량 10% 초과이면 유지한다. 부족하거나 작업 중이면 대기 중인 활성 계정 중 잔여량이 가장 많은 계정을 선택해 spawn(kind=gemini, webAccountId=선택한 ID)으로 작업자를 만든다. 기존 작업의 맥락을 이어갈 때는 같은 작업자에게 ask(webAccountId=새 계정)로 지정한다. 작업자 수 제한이면 기존 작업자를 재사용한다. 미조회·오래된 잔여량을 가용으로 추정하지 않는다.",
    "- 모든 웹 계정이 작업 중이거나 잔여량 부족이면 gemini_web_accounts(waitForAvailable=true)로 완료·초기화를 기다린 뒤 마스터가 다시 선택한다. 선택 이후 한도가 부족해지면 작업자는 요청·대화·초안을 보존하고 마스터에게 실패를 반환한다. 마스터가 계정 목록을 갱신해 직접 새 계정을 지정하고 실패 협의 id를 supersedes로 이어받는다. 작업자가 임의로 계정을 바꾸지 않는다. agents와 ask 결과의 지정/실행 계정 ID를 보고하며 작업자 번호를 계정 번호로 추정하지 않는다.",
    "- Gemini 웹은 로컬 파일·명령·MCP를 실행할 수 없으므로 message에 필요한 자료를 포함하거나 attach에 UTF-8 텍스트 파일을 명시한다. 웹에는 추론 단계 설정·토큰 수가 없으므로 effort는 배정 의도로만 기록된다.",
    "- 기술 업무의 기본 배정은 클로드 중심이다. 일반 분석·구현·테스트·문서의 기술 검증과 파일 제작은 먼저 클로드에게 맡기고, 독립 작업이 많으면 클로드 작업자를 추가해 나눈다. 지피티는 이미지 도구가 필요한 작업, 중요한 양쪽 조사·다른 관점의 검증, 사용자의 지피티 지정, 또는 클로드의 한도·실행 불가·과부하에 따른 재배정에 우선 사용한다. 매번 두 계열을 균등하게 배정하지 않는다. 명시적인 담당 지정이 있으면 그 CLI 작업자에게 배정한다.",
    "- 위 기준은 기본 선호이며 절대적인 우열이 아니다. 필요한 도구 사용 가능 여부를 먼저 확인하고, 사용자가 지정한 담당·선호 기준·관련 맥락·작업량·사용 한도를 고려한다. 두 계열을 매번 모두 부르지 않는다. 실패하면 원인을 반영해 재배정하고 가능한 담당자가 없으면 미완료 사유를 알린다.",
    "- 시각 작업도 구분한다. 이미지 생성·편집은 지정이 없을 때 이미지 도구가 있는 Codex에게, 명시적으로 Antigravity/Grok 등 다른 작업자를 지정하면 그 작업자에게 requiresImage=true로 배정한다. 제공된 이미지 도구의 실제 결과만 완료로 인정한다. 그 밖의 모션그래픽·애니메이션의 코드·타임라인·연출 제작은 클로드에게 우선 배정한다. 모션그래픽에 새 이미지 소재가 필요하면 그 이미지 생성만 지피티에 맡기고 클로드가 결과를 통합한다.",
    `- 중요한 버그 수정·오류 분석이라고 판단하면 ${t("route_request")}(mode=delegated, dualInvestigation=true, reason=중요도 판단 근거)를 기록한다. 예: 데이터 손실·보안·설비 안전·서비스 중단에 영향이 크거나, 반복 장애의 원인이 불확실하고 잘못 고쳤을 때 피해가 큰 경우. 사용자에게 양쪽 조사를 명시적으로 요청받은 경우도 적용한다. 단순 문구·서식 수정이나 일반 질문에 모두 호출하지 않는다.`,
    `- 양쪽 조사: 클로드와 지피티에게 동일한 문제·증상·소스·로그·완료 기준을 주고 ${t("ask_parallel")}(각 kind=opinion)로 독립 조사시킨다. 다른 쪽 결론을 먼저 전달하거나 파일 수정을 맡기지 않는다. 각각 원인 후보·근거(파일/로그)·재현 방법·수정안·불확실성을 보고하게 한다. 두 결과가 오면 공통점과 차이를 대조하고, 충돌은 추가 증거로 확인해 마스터가 최종 원인·수정 방향을 취합한다. 이후 구현은 정한 담당자에게 맡기고 교차 리뷰 규칙을 유지한다. 한쪽을 실행할 수 없으면 양쪽 조사를 완료했다고 하지 말고 제한과 확인된 결과를 보고한다.`,
    `- 팀: ${t("spawn")}(kind=claude|gpt|gemini|grok)로 작업자를 만든다 → 클로드 N호 / 지피티 N호 / 제미나이 N호. 작업자 수는 일의 양에 맞춘다: 작은 일은 한 명, 큰 일은 범위를 나눠 여러 명(동시에 클로드 최대 ${s.maxClaudeWorkers}명, 지피티 최대 ${s.maxGptWorkers}명, Antigravity 최대 ${s.maxGeminiWorkers}명, Grok 최대 ${s.maxGrokWorkers}명). 다 쓴 작업자는 ${t("release")}로 해제한다. ${t("agents")}로 팀을 확인한다.`,
    "- 한 요청 안에서도 UI·로직·테스트·자료 조사처럼 독립 가능한 파트를 나누고 담당·파일 범위·입출력 계약·의존성을 체크리스트에 기록한다. 파트는 ask_parallel로 동시에 맡긴다. 각 파트 담당에게 동료 닉네임과 연결되는 부분을 명시하고 직접 협의하게 한다. 마스터가 모든 대화를 중계하지 않는다. 작업 중인 동료와는 send_message로 계약·진행·질문을 주고받고, 대기 동료의 결과가 필요하면 ask/ask_parallel을 사용한다. 결과는 read_messages와 agents로 확인한 뒤 통합·검증한다.",
    `- 일 맡기기: ${t("ask")}(to=닉네임, kind, message, scope). 서로 독립적인 일은 반드시 ${t("ask_parallel")}(tasks=[…])로 한 번에 맡겨 동시에 진행한다(하나씩 기다리지 말 것). 구현(implement)은 고칠 범위(scope)를 겹치지 않게 나눈다. 리뷰·의견은 언제든 동시에 가능하다.`,
    `- 관련 쟁점·서로 맞물린 설계·문장과 연출 등 직접 논의가 필요한 항목은 주제별 토의 그룹으로 묶는다. ${t("ask")}(to=클로드/지피티 진행자, kind=opinion|writing, discussion={topic:주제, peers:[참여 닉네임]}, message=목표·공통 자료·쟁점·완료 기준, reason, effort)로 맡긴다. 진행자가 참여자에게 직접 ask로 초안과 근거를 주고받아 합의·이견·남은 확인을 정리하고, 너는 그룹별 결과와 필요한 최종 결정만 취합한다. 사소한 확인까지 매번 중계하지 않는다.`,
    "- 토의는 파일을 고치지 않는다. 주제와 사용자의 지정을 따라 Claude·Codex·Antigravity·Grok에서 진행자와 참여자를 정한다. Gemini 웹은 MCP가 없어 진행자는 될 수 없으며 제공된 자료로 참여한다. 참여자는 토의 시점에 대기 상태로 두고 다른 병렬 작업·토의 그룹에 중복 배정하지 않는다. 중요한 오류는 먼저 양쪽 독립 조사 결과를 확보한 뒤 토의 그룹에서 대조한다. 토의 결과를 교차 리뷰로 대신하지 않는다. 실제 참여 응답이 없으면 토의 완료로 보고하지 말고 보완하거나 미완료 사유를 알린다.",
    s.reviewGate
      ? "- 너 자신 또는 작업자가 코드를 바꾸면 끝내기 전에, 그 코드를 만들지 않은 작업자에게 리뷰를 맡긴다 (kind=review). 일반 변경의 리뷰는 다른 클로드 작업자도 가능하다. 중요한 오류·보안·안전 등 다른 계열 관점이 꼭 필요한 경우 지피티로 교차검증한다. 네가 직접 바꾼 파일도 빠짐없이 넘긴다. 지적이 나오면 고치고 다시 리뷰받는다."
      : "- 리뷰는 필요하다고 판단할 때만 맡긴다 (kind=review).",
    "- ask/ask_parallel의 각 배정에 reason(선택 이유)을 넣는다. 이미지 생성·편집은 requiresImage=true, kind=implement로 요청한다. 기본은 Codex이며 사용자가 다른 작업자를 지정하면 그 지정을 우선한다. 배정 내용에는 목표, 제약, 산출물, 완료 기준을 포함한다.",
    "- 작업자는 이 대화를 보지 못한다. message에 목표, 관련 파일 경로, 제약, 완료 기준을 빠짐없이 적는다. 사용자가 첨부한 파일이 필요하면 attach로 경로를 넘긴다.",
    `- 작업 중 사용자의 즉시 추가 지시를 받으면 기존 작업자를 유지한다. CLI가 ask 응답 수신을 중단해도 작업자는 계속 실행될 수 있다. ${t("agents")}로 상태와 저장된 최근 결과를 확인하고, 이미 완료한 작업을 응답 재수신만을 위해 다시 배정하지 않는다.`,
    "- 즉시 추가 질문·수정 요청에는 작업자의 완료를 기다리지 말고 먼저 사용자에게 한국어로 직접 답한다. 이미 아는 내용은 바로 설명하고 수정 요청은 이해한 내용과 반영 방법을 먼저 말한다. 기존 지시의 위임·교차 검증 요건은 그대로 유지하며, 추가 질문에 답하려고 기존 지시를 direct로 변경하지 않는다. 답변하기 전에 작업 배정이나 체크리스트 갱신으로 넘어가지 않는다.",
    `- 여러 단계 작업은 ${t("checklist")}로 단계와 담당(닉네임)을 등록하고, 단계를 시작·완료할 때마다 갱신한다.`,
    `- 채팅에 목표(/goal)가 있으면 그 목표를 향해 일하고, 한 단계를 마칠 때마다 ${t("update_goal")}로 진행을 보고한다. 다 이루면 status=complete.`,
    `- 꼭 필요한 결정만 ${t("ask_user")}로 묻는다.`,
    `- 사용자에게 대사를 쓰기 전에 ${t("set_expression")}(expression=감정)으로 표정을 지정한다. 감정: ${AGENT_EXPRESSIONS.join(", ")}. 기술적 내용과 말투를 억지로 바꾸지 않는다.`,
    `- 지시·협의의 작업 시간 제한은 없다. 사용자가 중지를 요청하면 즉시 멈춘다. 지시당 배정 한도는 ${s.maxConsults}회, 그중 리뷰는 ${s.maxReviews}회다. 횟수 한도에 걸리면 그때까지의 결과로 보고한다.`,
    "- 마지막에는 항상 한국어로 취합한다: 담당별 결과, 산출물 링크, 검증·리뷰 결과, 남은 문제. 돌아오지 않았거나 실패한 결과를 완료했다고 말하지 않는다. 생성 이미지 파일 경로도 최종 답변에 포함한다.",
    "- 사용자에게 결과물을 제공할 때마다 반드시 해당 파일별로 클릭할 수 있는 Markdown 링크 [파일명](<절대경로>)를 함께 쓴다. 이미지도 같은 링크와 미리보기를 함께 제공한다. :codex-file-citation 같은 내부 앱 전용 표기나 링크 없는 완료 문장으로 대체하지 않는다. 수정한 기존 PDF·문서·ZIP도 빠뜨리지 않고 각각 연결한다.",
  ].join("\n");
}

function workerInstructions(a: ChatAgent): string {
  return [
    `# 역할: AI_ChatterBox ${a.nickname} (${WORKER_KIND_LABEL[a.kind]} 작업자)`,
    `너는 마스터가 이끄는 팀의 작업자 "${a.nickname}"이다.${a.job ? ` 맡은 역할: ${a.job}` : ""}`,
    "- 너의 모델은 앱이 지정한다. 네이티브 spawn_agent/Agent/Task 또는 별도 CLI로 하위 작업자를 생성하지 않는다. 추가 인력이 필요하면 마스터에게 send_message로 요청한다. 기존 팀과는 앱 ask/ask_parallel/send_message/read_messages로 협업한다.",
    "- 구현 지시(implement): 지정된 범위(scope) 안의 파일만 고친다. 사용자에게 지정받은 종류의 작업을 수행한다. 승인·범위·도구 한계는 지킨다.",
    "- 리뷰(review)·의견(opinion)은 파일을 고치지 않고 근거를 보고한다.",
    "- 다른 파트와 인터페이스·전제·변경 사항을 직접 협의한다. 작업 중인 동료에게는 send_message로 보내고 본 작업을 계속한다. read_messages를 작업 단계마다, 특히 최종 보고 전에 확인한다. 대기 동료는 ask/ask_parallel로 질문할 수 있다. 자신의 잠근 파일 범위를 다시 위임하지 않는다.",
    "- 글쓰기 지시(writing): 문장·대사·문서 본문만 작성해 반환한다. 로컬 파일과 기술적 사실은 바꾸지 않는다. 독자·캐릭터의 말투·길이 조건을 지킨다.",
    "- 다른 작업자에게 확인할 것이 있으면 ask(to=닉네임)로 직접 묻는다. 팀 목록은 agents. 마스터에게는 ask를 쓰지 말고 결과 보고에 질문을 적는다.",
    "- 토의 그룹의 진행자로 지정되면 공통 주제와 너의 초안·근거·질문을 각 참여자에게 앱 ask로 직접 보내고, 실제 의견을 받아 대조·보완한 뒤 합의, 이견, 근거, 남은 결정을 한 번에 보고한다. 참여자로 질문을 받으면 쟁점에 답하고 반론·확인 질문을 이번 응답에 담는다. 너의 답을 기다리는 진행자에게 다시 ask하여 순환 대기를 만들지 않는다. 그룹 밖 쟁점이나 사용자 결정만 마스터에게 최종 보고한다.",
    "- 끝나면 한국어로 짧게 보고한다: 한 일, 바뀐 파일, 확인 방법과 결과, 남은 문제.",
    `- 대사 전에 set_expression 도구로 감정을 지정한다 (${AGENT_EXPRESSIONS.join(", ")}). Claude에서는 mcp__chatterbox_bridge__set_expression. 기술적 내용과 말투는 그대로 유지한다.`,
  ].join("\n");
}

// ---------- state
interface Instruction {
  id: number;
  mode?: "direct" | "delegated";
  dualInvestigation?: boolean;
  repaired?: boolean;
  waitingForResults?: boolean;
  /** The user's instruction text (context for the approval judge). */
  text: string;
  asks: number;
  reviews: number;
  requests: Map<string, number>;
  /** Extra instructions the user sent while the team was working. */
  queued: { text: string; attachments: AttachmentRef[] }[];
  /** Extra instructions already handed over (repeated in later tool results). */
  pinned: string[];
  /** A user follow-up needs a visible master reply before further team management. */
  pendingImmediate?: boolean;
}

interface Discussion { topic: string; peers: ChatAgent[] }
interface PausedAssignment {
  caller: Role; target: ChatAgent; kind: ConsultKind; message: string; scope: string[];
  attach: string[]; reason: string; effort?: string; discussion?: Discussion; consultId?: number;
}
interface PauseState {
  folder: string;
  instruction: Omit<Instruction, "requests"> & { requests: [string, number][] };
  planning: boolean; reviewing: boolean; assignments: PausedAssignment[];
}
interface Running {
  webAccountId?: GeminiWebAccountId;
  consultId: number;
  caller: Role;
  target: Role;
  kind: ConsultKind;
  message: string;
  scope: string[];
  text: string;
  files: Set<string>;
  pendingFiles: Map<string, string[]>;
  discussion?: Discussion;
  discussionReplies?: Set<Role>;
  resolve: (r: { ok: boolean; interrupted?: boolean; error?: string }) => void;
}

export class Orchestrator {
  private bridgeKeys = new Map<string, { key: string; url: string }>();
  private instructions = new Map<number, Instruction>();
  /** Running consults per chat, by target worker. */
  private running = new Map<number, Map<Role, Running>>();
  /** Who waits on whom (caller → targets), for the cycle / depth guard. */
  private waits = new Map<number, WaitGraph>();
  /** One turn at a time per worker. */
  private workerQueue = new Map<string, Promise<unknown>>();
  /** Only the master's tool wait is released; the consultation itself keeps running. */
  private masterConsultWaiters = new Map<number, Set<() => void>>();
  /** Implement scopes currently held, per chat. */
  private scopeLocks = new Map<number, { consultId: number; scope: string[] }[]>();
  private scopeWaiters = new Map<number, (() => void)[]>();
  private asks = new Map<string, { chatId: number; resolve: (a: string) => void }>();
  private stopped = new Set<number>();
  private webChecks = new Map<number, Set<AbortController>>();
  private epochs = new Map<number, number>();
  private nextEpoch(chatId: number) {
    const epoch = (this.epochs.get(chatId) ?? 0) + 1;
    this.epochs.set(chatId, epoch);
    return epoch;
  }
  private pauseFlights = new Map<number, Promise<void>>();
  private assignments = new Map<number, Map<string, PausedAssignment>>();
  /** /plan: the master is only planning (no asks) / running an approved plan. */
  private planning = new Set<number>();
  private reviewing = new Set<number>();
  /** Master native tool calls which may still be changing the workspace. */
  private masterActions = new Map<number, Set<string>>();
  private planRunning = new Set<number>();
  readonly judge: ApprovalJudge;

  constructor(private chats: ChatManager) {
    chats.beforeMasterEnd = (chatId, event) => this.checkCompletion(chatId, event);
    this.judge = new ApprovalJudge(chats, (chatId, role) => {
      const r = role ? this.running.get(chatId)?.get(role) : undefined;
      return {
        instruction: this.instructions.get(chatId)?.text,
        consult: r ? { who: roleName(r.target, chats.store.listAgents(chatId)), kind: r.kind, message: r.message, scope: r.scope } : undefined,
      };
    });
    chats.judge = (chatId, request, input) => this.judge.decide(chatId, request, input);
    chats.writeScope = (chatId, role) => this.writeScope(chatId, role);
    chats.approvalGuard = (chatId, input) => this.guardApproval(chatId, input);
    chats.instructionsFor = (chat, project, role, agent) => {
      if (role === "orch") return masterInstructions(project, agent);
      const a = chats.store.agentByKey(chat.id, role);
      return a ? workerInstructions(a) : undefined;
    };
    chats.toolsFor = (chat, role) => ({ chatterbox_bridge: this.bridgeFor(chat.id, role) });
    chats.onDriverEvent = (chatId, role, event) => this.observe(chatId, role, event);
    chats.sendHandler = (chat, input) => this.instruct(chat, input);
    chats.busySend = (chat, input, delivery) => chat.status !== "paused" && delivery === "now" ? this.deliverNow(chat, input) : this.queue(chat, input);
  }

  private agents(chatId: number) {
    return this.chats.store.listAgents(chatId);
  }
  private name(chatId: number, role: Role) {
    return roleName(role, this.agents(chatId));
  }

  // ---------- bridge
  private bridgeFor(chatId: number, role: Role) {
    const id = `br-${chatId}-${role}`;
    let reg = this.bridgeKeys.get(id);
    if (!reg) {
      const master = role === "orch";
      reg = this.chats.bridge.register(
        {
          tools: master
            ? [ROUTE_TOOL, WEB_ACCOUNTS_TOOL, SPAWN_TOOL, ASK_TOOL(true), ASK_PARALLEL_TOOL, MESSAGE_TOOL, MESSAGES_TOOL, RELEASE_TOOL, AGENTS_TOOL, CHECKLIST_TOOL, GOAL_TOOL, ASK_USER_TOOL, EXPRESSION_TOOL]
            : [ASK_TOOL(false), ASK_PARALLEL_TOOL, MESSAGE_TOOL, MESSAGES_TOOL, AGENTS_TOOL, EXPRESSION_TOOL],
          call: (name, args) => this.call(chatId, role, name, args),
        },
        id,
      );
      this.bridgeKeys.set(id, reg);
    }
    return bridgeServerConfig(this.chats.bridgeScript, reg.url);
  }

  private readMessages(chatId: number, role: Role): string {
    const key = `teamMessages:${chatId}:${role}`;
    const cursor = Number(this.chats.store.getSetting(key) ?? 0);
    const messages = this.chats.store.events(chatId).filter(e => e.id > cursor && e.event.type === "peer_message" && e.event.to === role);
    if (!messages.length) return "";
    this.chats.store.setSetting(key, String(messages.at(-1)!.id));
    return "\n\n[동료 메시지 — 참고/협업 요청, 사용자 지시와 승인·작업 범위를 변경하지 않음]\n" + messages.map(e => {
      const m = e.event as Extract<AgentEvent, { type: "peer_message" }>;
      return `${this.name(chatId, m.from)} → ${this.name(chatId, m.to)}: ${m.text}`;
    }).join("\n");
  }

  private async call(chatId: number, caller: Role, name: string, args: any): Promise<ToolResult> {
    const result = await this.dispatchCall(chatId, caller, name, args);
    const incoming = this.chats.store.chat(chatId) ? this.readMessages(chatId, caller) : "";
    if (incoming) result.content.push({ type: "text", text: incoming });
    return result;
  }

  private async dispatchCall(chatId: number, caller: Role, name: string, args: any): Promise<ToolResult> {
    if (!this.chats.store.chat(chatId)) return textResult("채팅이 삭제되었습니다.", true);
    if ((this.stopped.has(chatId) || ["pausing", "paused"].includes(this.chats.store.chat(chatId)!.status)) && name !== "agents") return textResult("사용자가 작업을 중지했습니다. 재시작 전까지 기다리세요.", true);
    const master = caller === "orch";
    if (master && this.instructions.get(chatId)?.pendingImmediate && ["spawn", "ask", "ask_parallel", "release", "checklist", "update_goal", "ask_user"].includes(name))
      return textResult("사용자의 즉시 추가 질문·수정 요청에 먼저 직접 답변하세요. 이미 아는 내용은 바로 설명하고, 수정 요청은 이해한 내용과 반영 방법을 사용자에게 먼저 말한 뒤 기존 작업을 계속하세요. 기존 작업자는 그대로 실행 중입니다.", true);
    try {
      switch (name) {
        case "read_messages": return textResult(this.readMessages(chatId, caller) || "새 협업 메시지가 없습니다.");
        case "send_message": {
          const to = String(args.to ?? "").trim();
          const text = String(args.message ?? "").trim();
          const target = ["orch", "master", "마스터"].includes(to) ? "orch" : this.agents(chatId).find(a => (a.nickname === to || a.key === to) && a.status === "active")?.key;
          if (!target || target === caller || !text || text.length > 16000) return textResult("활성 동료/마스터와 1~16000자의 메시지를 지정하세요. 자신에게는 보낼 수 없습니다.", true);
          if (caller !== "orch" && !this.running.get(chatId)?.has(caller)) return textResult("현재 배정받은 작업이 없습니다.", true);
          this.chats.emit(chatId, this.chats.route(chatId, target), caller, { type: "peer_message", from: caller, to: target, text });
          return textResult(`${this.name(chatId, target)}에게 메시지를 저장했습니다. 다음 앱 도구 호출 또는 작업 시작 시 전달됩니다. 답을 기다리지 않고 맡은 작업을 계속하세요.`);
        }
        case "route_request": {
          if (!master) break;
          const inst = this.instructions.get(chatId);
          if (!inst || !["direct", "delegated"].includes(args.mode) || !String(args.reason ?? "").trim()) return textResult("mode와 reason을 지정하세요.", true);
          if (args.dualInvestigation !== undefined && typeof args.dualInvestigation !== "boolean") return textResult("dualInvestigation은 true 또는 false여야 합니다.", true);
          if (inst.pendingImmediate && args.mode === "direct" && args.dualInvestigation !== true)
            return textResult("이번 추가 질문은 마스터가 지금 직접 답변하세요. 기존 본 작업의 배정 방식·독립 조사·교차 리뷰 요건은 변경하지 않았습니다. 사용자에게 답한 뒤 기존 작업을 계속하세요.");
          const dualInvestigation = !!inst.dualInvestigation || args.dualInvestigation === true;
          if (dualInvestigation && args.mode !== "delegated") return textResult("중요 오류의 양쪽 조사는 delegated로 기록하세요.", true);
          if (inst.mode === "delegated" && args.mode === "direct") return textResult("위임할 본 작업을 직접 처리로 바꿀 수 없습니다. 가능한 작업자에게 맡기거나 미완료 사유를 보고하세요.", true);
          inst.mode = args.mode;
          inst.dualInvestigation = dualInvestigation;
          this.chats.emit(chatId, "orch", "orch", { type: "dispatch", instructionId: inst.id, mode: args.mode, reason: String(args.reason).trim(), dualInvestigation });
          const capabilities = await this.chats.teamCapabilities(this.chats.store.chat(chatId)!);
          return textResult(JSON.stringify({ capabilities, team: this.agentsText(chatId), dualInvestigation, note: "사용 가능 도구·사용량은 현재 확인값이며 인증/한도 오류는 실행 시 보고됩니다. 이미지 미확인은 사용 가능으로 간주하지 마세요." }));
        }
        case "set_expression":
          if (!isAgentExpression(args.expression)) return textResult("지원하지 않는 표정입니다.", true);
          this.chats.emit(chatId, this.chats.route(chatId, caller), caller, { type: "expression", expression: args.expression });
          return textResult("표정을 반영했습니다.");
        case "ask": {
          const task = this.askTool(chatId, caller, args);
          return await (master ? this.waitForMasterConsult(chatId, task) : task);
        }
        case "ask_parallel": {
          const tasks: any[] = Array.isArray(args.tasks) ? args.tasks : [];
          if (!tasks.length) return textResult("tasks가 비었습니다.", true);
          const result = Promise.all(tasks.map((t) => this.askTool(chatId, caller, t).catch((error) => textResult(error instanceof Error ? error.message : String(error), true)))).then((results) => textResult(
            results.map((r, i) => `## ${i + 1}. ${String(tasks[i]?.to ?? "")}\n${r.content.map((c) => c.text).join("\n")}`).join("\n\n"),
            results.every((r) => r.isError),
          ));
          return await (master ? this.waitForMasterConsult(chatId, result) : result);
        }
        case "gemini_web_accounts": {
          if (!master) return textResult("Gemini 웹 계정 선택·조회는 마스터가 직접 합니다.", true);
          if ((args.refresh !== undefined && typeof args.refresh !== "boolean") || (args.waitForAvailable !== undefined && typeof args.waitForAvailable !== "boolean"))
            return textResult("refresh와 waitForAvailable은 boolean이어야 합니다.", true);
          const controller = new AbortController();
          const checks = this.webChecks.get(chatId) ?? new Set<AbortController>();
          checks.add(controller); this.webChecks.set(chatId, checks);
          try {
            if (args.waitForAvailable) this.chats.emit(chatId, "orch", "orch", { type: "notice", text: "마스터가 Gemini 웹 계정의 작업 완료·사용량 초기화를 기다립니다. 10초마다 상태를 다시 확인하며 중지로 취소할 수 있습니다." });
            if (args.refresh !== false || args.waitForAvailable) await this.chats.geminiWebAccounts().inspect(controller.signal, !!args.waitForAvailable);
            return textResult(JSON.stringify({ accounts: this.chats.webAccountInfo(chatId), minimumRemainingPercent: WEB_LOW_REMAINING, selection: "master", note: "remainingPercent가 없으면 미확인/오래된 값입니다. usage.checkedAt와 로그인·busy 상태를 함께 확인하세요." }));
          } finally {
            checks.delete(controller);
            if (!checks.size) this.webChecks.delete(chatId);
          }
        }
        case "agents":
          return textResult(this.agentsText(chatId, true));
        case "spawn":
          if (!master) break;
          if (!["claude", "gpt", "gemini", "grok"].includes(args.kind)) return textResult("지원하지 않는 작업자 종류입니다.", true);
          return this.spawn(chatId, args.kind, String(args.job ?? ""), args.webAccountId);
        case "release":
          if (!master) break;
          return await this.release(chatId, String(args.nickname ?? ""));
        case "checklist":
          if (!master) break;
          return this.checklist(chatId, args.steps);
        case "update_goal":
          if (!master) break;
          return textResult(this.updateGoal(chatId, args.status, String(args.progress ?? "")));
        case "ask_user":
          if (!master) break;
          return textResult(await this.askUser(chatId, String(args.question ?? ""), Array.isArray(args.options) ? args.options.map(String) : []));
      }
      return textResult(`알 수 없는 도구: ${name}`, true);
    } catch (e) {
      return textResult(e instanceof Error ? e.message : String(e), true);
    }
  }

  private async waitForMasterConsult(chatId: number, result: Promise<ToolResult>): Promise<ToolResult> {
    const waiters = this.masterConsultWaiters.get(chatId) ?? new Set<() => void>();
    this.masterConsultWaiters.set(chatId, waiters);
    let wake!: () => void;
    const followup = new Promise<ToolResult>((resolve) => {
      wake = () => resolve(textResult(this.stopped.has(chatId)
        ? "사용자가 작업을 중지했습니다. 멈추세요."
        : "사용자의 즉시 추가 요청을 처리하도록 협의 결과 대기만 해제했습니다. 기존 작업자는 중지하지 않았으며 결과는 저장됩니다. 먼저 사용자 질문에 직접 답하고, 수정 요청에는 반영 방법을 먼저 말하세요. 완료한 작업을 중복 배정하지 말고 이후 agents로 결과를 확인하세요." + this.takeQueued(chatId)));
      waiters.add(wake);
    });
    try { return await Promise.race([result, followup]); }
    finally {
      waiters.delete(wake);
      if (!waiters.size && this.masterConsultWaiters.get(chatId) === waiters) this.masterConsultWaiters.delete(chatId);
    }
  }

  private wakeMasterConsults(chatId: number) {
    for (const controller of this.webChecks.get(chatId) ?? []) controller.abort(new Error("계정 조회 대기를 해제했습니다. 사용자의 추가 지시 또는 중지를 먼저 처리하세요."));
    for (const wake of this.masterConsultWaiters.get(chatId) ?? []) wake();
  }

  // ---------- team
  private agentsText(chatId: number, includeResults = false): string {
    const list = this.agents(chatId);
    if (!list.length) return "아직 작업자가 없습니다. spawn으로 만드세요.";
    const busy = this.running.get(chatId);
    const accounts = list.some(a => a.kind === "gemini") && this.chats.usesGeminiWeb(this.chats.store.chat(chatId)!) ? this.chats.geminiWebAccounts().list() : [];
    const instructionId = this.instructions.get(chatId)?.id;
    const consults = includeResults && instructionId !== undefined ? this.chats.store.listConsults(chatId).filter((c) => c.instructionId === instructionId) : [];
    return list
      .map((a) => {
        const r = busy?.get(a.key);
        const state = a.status === "released" ? "해제됨" : r ? `작업 중 (${CONSULT_KIND_LABEL[r.kind]}${r.scope.length ? ` · ${r.scope.join(", ")}` : ""})` : "대기";
        const latest = consults.findLast((c) => c.toRole === a.key);
        const result = latest ? `\n  최근 협의 id=${latest.id} · ${latest.status}${latest.responseSummary ? `\n${latest.responseSummary}` : ""}${latest.filesChanged.length ? `\n산출물:\n${latest.filesChanged.join("\n")}` : ""}` : "";
        const account = a.kind === "gemini" && this.chats.usesGeminiWeb(this.chats.store.chat(chatId)!)
          ? ` · 지정 계정=${a.webAccountId ?? "마스터 선택 필요"} · 현재 실행 계정=${r?.webAccountId ?? "없음"} · 최근 대화 계정=${conversationAccount(a.sessionId) ?? "없음"}` : "";
        const quota = accounts.find(x => x.accountId === (r?.webAccountId ?? a.webAccountId ?? conversationAccount(a.sessionId)));
        const balance = quota ? ` · 잔여=${quota.remainingPercent === undefined ? "미확인" : `${quota.remainingPercent}%`} · 사용량 조회=${quota.usage.checkedAt || "미조회"}` : "";
        return `- ${a.nickname} (${WORKER_KIND_LABEL[a.kind]}) · ${a.job || "역할 미정"} · ${state}${account}${balance}${result}`;
      })
      .join("\n");
  }

  private selectedWebAccount(value: unknown): GeminiWebAccountId {
    const id = webAccountId(value);
    if (!id) throw new Error("마스터가 gemini_web_accounts로 잔여량을 확인하고 webAccountId=gemini-1~gemini-10 중 하나를 지정하세요.");
    const account = this.chats.geminiWebAccounts().list().find(a => a.accountId === id);
    if (!account?.enabled || account.state === "busy" || account.state === "login_required" || account.remainingPercent === undefined || account.remainingPercent <= WEB_LOW_REMAINING)
      throw new Error(`계정 ${id}은 미등록·비활성·작업 중이거나 잔여량이 부족/미확인입니다. gemini_web_accounts로 갱신 후 선택하세요. 모두 불가이면 waitForAvailable=true로 기다리세요.`);
    return id;
  }

  private spawn(chatId: number, kind: WorkerKind, job: string, requestedAccount?: unknown): ToolResult {
    const chat = this.chats.store.chat(chatId)!;
    const project = this.chats.store.project(chat.projectId)!;
    if (this.planning.has(chatId)) return textResult("지금은 계획 모드입니다. 작업자를 만들지 말고 계획만 세우세요.", true);
    const web = kind === "gemini" && this.chats.usesGeminiWeb(chat);
    if (!web && requestedAccount !== undefined) return textResult("webAccountId는 Gemini 웹 작업자에게만 지정할 수 있습니다.", true);
    const accountId = web ? this.selectedWebAccount(requestedAccount) : undefined;
    if (!web && !this.chats.cliInfo().find((c) => c.agent === WORKER_AGENT[kind])?.path)
      return textResult(`${WORKER_KIND_LABEL[kind]} CLI가 설치되지 않았습니다. 사용 가능한 작업자를 선택하거나 미완료 사유를 보고하세요.`, true);
    const max = kind === "claude" ? project.settings.maxClaudeWorkers : kind === "gpt" ? project.settings.maxGptWorkers : kind === "grok" ? project.settings.maxGrokWorkers : project.settings.maxGeminiWorkers;
    const active = this.agents(chatId).filter((a) => a.kind === kind && a.status === "active").length;
    if (active >= max)
      return textResult(`${WORKER_KIND_LABEL[kind]}는 동시에 ${max}명까지입니다. 기존 작업자에게 맡기거나 다 쓴 작업자를 release 하세요.`, true);
    const a = this.chats.store.createAgent(chatId, kind, job);
    if (accountId) this.chats.store.updateAgent(a.id, { webAccountId: accountId });
    this.chats.agentsChanged(chatId);
    this.chats.emit(chatId, "orch", "orch", { type: "notice", text: `${a.nickname} 합류${accountId ? ` · 마스터 지정 웹 계정 ${accountId.slice(7)}` : ""}${job ? ` · ${job}` : ""}` });
    return textResult(`${a.nickname}이(가) 준비되었습니다.${accountId ? ` 마스터 지정 계정=${accountId}.` : ""} ask(to="${a.nickname}")로 일을 맡기세요. 이전 기록이 있으면 유지됩니다.`);
  }

  private async release(chatId: number, nickname: string): Promise<ToolResult> {
    const a = this.agents(chatId).find((x) => x.nickname === nickname.trim());
    if (!a) return textResult(`그런 작업자가 없습니다: ${nickname}`, true);
    if (a.status === "released") return textResult(`${a.nickname}은(는) 이미 해제되었습니다.`);
    if (this.running.get(chatId)?.has(a.key)) return textResult(`${a.nickname}은(는) 아직 작업 중이라 해제할 수 없습니다.`, true);
    await this.chats.disposeRole(chatId, a.key);
    this.chats.store.updateAgent(a.id, { status: "released" });
    this.chats.agentsChanged(chatId);
    this.chats.emit(chatId, "orch", "orch", { type: "notice", text: `${a.nickname} 해제` });
    return textResult(`${a.nickname}을(를) 해제했습니다.`);
  }

  private checklist(chatId: number, raw: unknown): ToolResult {
    const steps: PlanStep[] = (Array.isArray(raw) ? raw : [])
      .map((s: any) => ({
        title: String(s?.title ?? "").trim(),
        status: (s?.status === "completed" || s?.status === "inProgress" ? s.status : "pending") as PlanStep["status"],
      }))
      .filter((s) => s.title);
    if (!steps.length) return textResult("steps가 비었습니다.", true);
    this.chats.emit(chatId, "orch", "orch", { type: "plan_update", steps });
    return textResult(`체크리스트를 갱신했습니다 (${steps.filter((s) => s.status === "completed").length}/${steps.length} 완료).`);
  }

  // ---------- ask (consult)
  private graph(chatId: number): WaitGraph {
    let g = this.waits.get(chatId);
    if (!g) this.waits.set(chatId, (g = new Map()));
    return g;
  }

  private async askTool(chatId: number, caller: Role, args: any): Promise<ToolResult> {
    const to = String(args.to ?? "").trim();
    const kind: ConsultKind = KINDS.includes(args.kind) ? args.kind : "implement";
    let message = String(args.message ?? "");
    const scope: string[] = kind === "implement" && Array.isArray(args.scope) ? args.scope.map(String).filter(Boolean) : [];
    const attach: string[] = Array.isArray(args.attach) ? args.attach.map(String) : [];
    const callerName = this.name(chatId, caller);
    const reason = String(args.reason ?? "").trim();
    if (caller === "orch" && !reason) return textResult("작업자를 선택한 이유(reason)를 적으세요.", true);
    if (caller === "orch" && !(WORKER_EFFORTS as readonly unknown[]).includes(args.effort)) return textResult("effort는 medium, high, xhigh 중에서 선택하고 reason에 추론 수준 선택 이유를 적으세요.", true);
    if (kind === "implement" && (this.reviewing.has(chatId) || (caller !== "orch" && this.running.get(chatId)?.get(caller)?.kind !== "implement")))
      return textResult("리뷰·의견 요청에서는 다른 작업자에게 구현을 맡길 수 없습니다.", true);

    if (to === MASTER_LABEL || to === "마스터" || to.toLowerCase() === "master")
      return textResult("마스터는 지금 팀의 결과를 기다리고 있어 바로 답할 수 없습니다(교착 방지). 질문은 결과 보고에 적어 주세요.", true);
    const target = this.agents(chatId).find((a) => a.nickname === to);
    if (!target) {
      const names = this.agents(chatId).filter((a) => a.status === "active").map((a) => a.nickname);
      return textResult(`그런 작업자가 없습니다: "${to}". 지금 팀: ${names.join(", ") || "(없음 — 마스터가 spawn으로 만듭니다)"}`, true);
    }
    if (target.status === "released") return textResult(`${target.nickname}은(는) 해제되었습니다.`, true);
    let discussion: Discussion | undefined;
    if (args.discussion !== undefined) {
      if (caller !== "orch") return textResult("토의 그룹 구성은 마스터가 지정합니다.", true);
      if (!["opinion", "writing"].includes(kind) || (target.kind === "gemini" && this.chats.usesGeminiWeb(this.chats.store.chat(chatId)!)))
        return textResult("토의 진행자는 MCP를 사용하는 CLI 작업자이며 opinion 또는 writing으로 파일 변경 없이 맡기세요.", true);
      const raw = args.discussion;
      if (!raw || typeof raw !== "object" || typeof raw.topic !== "string" || !raw.topic.trim() || !Array.isArray(raw.peers) || !raw.peers.length || raw.peers.some((p: unknown) => typeof p !== "string" || !p.trim()))
        return textResult("토의 주제(topic)와 참여자(peers)를 지정하세요.", true);
      const names: string[] = raw.peers.map((p: string) => p.trim());
      if (new Set(names).size !== names.length || names.includes(target.nickname)) return textResult("토의 참여자는 진행자와 다른 닉네임을 중복 없이 지정하세요.", true);
      const peers = names.map(name => this.agents(chatId).find(a => a.nickname === name && a.status === "active"));
      if (peers.some(p => !p)) return textResult("토의 참여자는 현재 활성 작업자여야 합니다.", true);
      const available = peers as ChatAgent[];
      if (available.some(p => this.running.get(chatId)?.has(p.key))) return textResult("토의 참여자가 작업 중입니다. 완료 후 대기 상태에서 그룹으로 묶으세요.", true);
      const issue = this.investigationIssue(chatId);
      if (issue) return textResult(`독립 조사 결과를 확보한 뒤 토의하세요. ${issue}`, true);
      discussion = { topic: raw.topic.trim(), peers: available };
      message = `[토의 그룹: ${discussion.topic}]\n진행자: ${target.nickname}\n참여자: ${names.join(", ")}\n각 참여자에게 앱 ask(kind=${kind})로 너의 초안·근거·질문을 직접 보내고 실제 답을 받아 대조하라. 필요하면 후속 질문으로 보완하고 합의·이견·근거·남은 결정을 취합하라. 참여 응답 없이 토의 완료라고 하지 마라. 파일을 고치지 마라.\n\n${message}`;
    }
    const parent = this.running.get(chatId)?.get(caller);
    if (parent?.discussion) {
      if (kind !== parent.kind || !parent.discussion.peers.some(p => p.key === target.key))
        return textResult("마스터가 지정한 토의 참여자에게 같은 opinion/writing 종류로만 직접 질문하세요. 파일 변경이나 그룹 확장은 마스터에게 보고하세요.", true);
      message = `[토의 주제: ${parent.discussion.topic}]\n${callerName}이(가) 토의를 진행하며 너의 의견을 기다린다. 이번 응답에 반론·근거·확인 질문을 담고 진행자에게 다시 ask하지 마라.\n\n${message}`;
    }
    if (target.kind === "gemini" && this.chats.usesGeminiWeb(this.chats.store.chat(chatId)!) && kind === "implement" && !args.requiresImage)
      return textResult("Gemini 웹은 로컬 파일·명령을 실행할 수 없습니다. Antigravity CLI를 선택하거나 분석/글쓰기로 요청하세요.", true);
    if (args.requiresImage) {
      if (kind !== "implement") return textResult("이미지 생성은 implement로 요청하세요.", true);
      // Codex is the default; an explicitly chosen worker gets the chance to use its own tools.
      if (target.kind === "gpt") {
        const caps = await this.chats.teamCapabilities(this.chats.store.chat(chatId)!);
        if (caps.gpt.imageGeneration !== true) return textResult("선택된 Codex의 이미지 생성 도구를 확인하지 못했습니다. 모델·로그인·도구 설정을 확인하세요.", true);
      }
      message += "\n[이미지 결과 필수] 실제 이미지 도구를 사용하고 생성 파일/이미지 첨부를 반환하세요. 도구가 없거나 실패하면 그 사실을 보고하세요. 이미지를 만들었다고 추정하지 마세요.";
    }
    if (caller !== "orch" && kind === "implement") {
      if (!scope.length || (parent?.scope && scopesOverlap(parent.scope, scope)))
        return textResult("자신이 수정 중인 범위를 동료에게 다시 맡기면 대기가 막힙니다. 겹치지 않는 별도 범위를 명시하거나 send_message로 협의하세요.", true);
    }
    const refusal = checkAsk(this.graph(chatId), caller, target.key, MAX_DEPTH);
    if (refusal === "self") return textResult("자기 자신에게는 맡길 수 없습니다.", true);
    if (refusal === "cycle") {
      const msg = `교착 방지: ${target.nickname}은(는) 지금 ${callerName}의 결과를 기다리고 있어서, ${callerName}이(가) ${target.nickname}에게 다시 물을 수 없습니다.`;
      this.chats.emit(chatId, this.chats.route(chatId, caller), caller, { type: "notice", text: msg });
      return textResult(msg + " 직접 해결하거나 결과 보고에 적으세요.", true);
    }
    if (refusal === "depth")
      return textResult(`호출이 너무 깊습니다(최대 ${MAX_DEPTH}단계). 직접 처리하거나 결과 보고에 적으세요.`, true);
    const inst = this.instructions.get(chatId);
    if (caller === "orch" && inst?.mode !== "delegated") return textResult("먼저 route_request(mode=delegated, reason=이유)로 배정 방식을 기록하세요.", true);
    if (kind === "implement") {
      const issue = this.investigationIssue(chatId);
      if (issue) return textResult(issue, true);
    }
    const supersedes = args.supersedes;
    if (supersedes !== undefined) {
      const previous = this.chats.store.consult(supersedes);
      if (!Number.isSafeInteger(supersedes) || !previous || previous.chatId !== chatId || previous.instructionId !== inst?.id || ["running", "done"].includes(previous.status))
        return textResult("supersedes는 이번 지시에서 실패·중단된 협의 id여야 합니다.", true);
    }
    // Worker-to-worker questions inherit the level chosen by the master for the caller.
    const web = target.kind === "gemini" && this.chats.usesGeminiWeb(this.chats.store.chat(chatId)!);
    if (args.webAccountId !== undefined) {
      if (caller !== "orch") return textResult("웹 계정 지정은 마스터만 할 수 있습니다. 선택 요청은 마스터에게 보고하세요.", true);
      if (!web) return textResult("webAccountId는 Gemini 웹 작업자에게만 지정할 수 있습니다.", true);
      if ([...(this.assignments.get(chatId)?.values() ?? [])].some(a => a.target.key === target.key))
        return textResult("해당 작업자는 실행/대기 중입니다. 완료 후 계정을 지정하세요.", true);
      const accountId = this.selectedWebAccount(args.webAccountId);
      target.webAccountId = accountId;
      this.chats.store.updateAgent(target.id, { webAccountId: accountId });
      this.chats.agentsChanged(chatId);
    }
    if (web && !target.webAccountId) return textResult("기존 Gemini 웹 작업자의 계정이 지정되지 않았습니다. 마스터가 gemini_web_accounts 조회 후 ask의 webAccountId를 직접 지정하세요.", true);
    const inherited = caller === "orch" ? args.effort : this.chats.store.consult(this.running.get(chatId)?.get(caller)?.consultId ?? -1)?.effort || "medium";
    const response = await this.consult(chatId, caller, target, kind, message, scope, attach, reason || (parent?.discussion ? `토의 ${parent.discussion.topic} · ${callerName} → ${target.nickname}` : ""), supersedes, inherited, discussion);
    if (parent?.discussion && !response.isError) parent.discussionReplies!.add(target.key);
    return response;
  }

  private limitCheck(chatId: number, project: Project, target: Role, kind: ConsultKind, message: string, accountId?: GeminiWebAccountId): string | null {
    const inst = this.instructions.get(chatId);
    if (!inst) return null;
    const s = project.settings;
    if (this.stopped.has(chatId)) return "사용자가 작업을 중지했습니다. 더 이상 맡기지 말고 멈추세요.";
    if (this.planning.has(chatId)) return "지금은 계획 모드입니다. 작업자에게 맡기지 말고 계획(체크리스트)만 세워 보고하세요.";
    const maxAsks = s.maxConsults;
    if (inst.asks >= maxAsks) return `한도 도달: 이번 지시에서 ${maxAsks}번 맡겼습니다. 더 맡기지 말고 지금까지의 결과를 보고하세요.`;
    if (kind === "review" && inst.reviews >= s.maxReviews) return `한도 도달: 리뷰를 ${s.maxReviews}회 했습니다. 지금까지의 결과와 남은 지적 사항을 보고하세요.`;
    const h = createHash("sha1").update(`${target}|${kind}|${accountId ?? ""}|${message.trim()}`).digest("hex");
    const n = (inst.requests.get(h) ?? 0) + 1;
    inst.requests.set(h, n);
    if (n > 2) return "같은 요청을 이미 두 번 보냈습니다. 반복하지 말고 방법을 바꾸거나 지금까지의 결과를 보고하세요.";
    return null;
  }

  private async acquireScope(chatId: number, consultId: number, scope: string[]) {
    for (;;) {
      if (this.stopped.has(chatId)) return;
      const held = this.scopeLocks.get(chatId) ?? [];
      if (!this.masterActions.get(chatId)?.size && !held.some((h) => scopesOverlap(h.scope, scope))) {
        held.push({ consultId, scope });
        this.scopeLocks.set(chatId, held);
        return;
      }
      await new Promise<void>((res) => this.scopeWaiters.set(chatId, [...(this.scopeWaiters.get(chatId) ?? []), res]));
    }
  }
  private releaseScope(chatId: number, consultId: number) {
    this.scopeLocks.set(chatId, (this.scopeLocks.get(chatId) ?? []).filter((h) => h.consultId !== consultId));
    const w = this.scopeWaiters.get(chatId) ?? [];
    this.scopeWaiters.set(chatId, []);
    for (const f of w) f();
  }

  private async consult(chatId: number, caller: Role, target: ChatAgent, kind: ConsultKind, message: string, scope: string[], attach: string[], reason: string, supersedes?: number, requestedEffort?: string, discussion?: Discussion, resuming = false): Promise<ToolResult> {
    const epoch = this.epochs.get(chatId);
    const chat = this.chats.store.chat(chatId)!;
    const project = this.chats.store.project(chat.projectId)!;
    const callerName = this.name(chatId, caller);
    const limited = resuming ? (this.stopped.has(chatId) || this.planning.has(chatId) ? "작업이 중지되었거나 계획 모드입니다." : null) : this.limitCheck(chatId, project, target.key, kind, message, target.kind === "gemini" && this.chats.usesGeminiWeb(chat) ? target.webAccountId : undefined);
    if (limited) {
      this.chats.emit(chatId, this.chats.route(chatId, caller), caller, { type: "notice", text: `${target.nickname}에게 맡기기 거절 · ${limited.split(".")[0]}` });
      return textResult(limited + this.takeQueued(chatId), true);
    }
    const inst = this.instructions.get(chatId);
    if (inst && !resuming) {
      inst.asks++;
      if (kind === "review") inst.reviews++;
    }

    // The caller is now waiting on the target (cycle / depth guard).
    addWait(this.graph(chatId), caller, target.key);
    const queueKey = `${chatId}:${target.key}`;
    const prev = this.workerQueue.get(queueKey) ?? Promise.resolve();
    let done!: () => void;
    const mine = new Promise<void>((r) => (done = r));
    this.workerQueue.set(queueKey, prev.then(() => mine));
    const assignmentKey = randomUUID();
    const assignment: PausedAssignment = { caller, target, kind, message, scope, attach, reason, effort: requestedEffort, discussion };
    const assignments = this.assignments.get(chatId) ?? new Map();
    assignments.set(assignmentKey, assignment);
    this.assignments.set(chatId, assignments);
    try {
      await prev; // the target finishes its current turn first
      const reasoning = await this.chats.assignmentEffort(chatId, target.key, requestedEffort);
      // Web models have no effective effort; retain the master's valid intent for resume.
      assignment.effort = reasoning.effort || reasoning.requestedEffort;
      if (this.stopped.has(chatId) || this.epochs.get(chatId) !== epoch) return textResult("사용자가 작업을 중지했습니다.", true);
      const attachments = this.attachmentsFor(chatId, attach);
      const consult = this.chats.store.createConsult(chatId, caller, target.key, kind, message, scope, inst?.id, reason, supersedes, reasoning);
      assignment.consultId = consult.id;
      this.chats.sink.consult(consult);
      const node = `consult:${consult.id}` as NodeId;
      // The card goes where the caller is (master's timeline, or inside the calling worker's consult).
      this.chats.emit(chatId, this.chats.route(chatId, caller), caller, {
        type: "consult_start",
        consultId: consult.id,
        kind,
        from: caller,
        to: target.key,
        request: message,
        attachments,
        scope,
        reason,
        instructionId: inst?.id,
      });
      if (kind === "implement") await this.acquireScope(chatId, consult.id, scope);
      this.chats.setRoute(chatId, target.key, node);

      const result = await new Promise<{ ok: boolean; interrupted?: boolean; error?: string; text: string; files: string[]; webAccountId?: GeminiWebAccountId }>((resolve) => {
        let settled = false;
        const r: Running = {
          consultId: consult.id,
          caller,
          target: target.key,
          kind,
          message,
          scope,
          text: "",
          files: new Set(),
          pendingFiles: new Map(),
          discussion,
          discussionReplies: discussion ? new Set() : undefined,
          resolve: (end) => {
            if (settled) return;
            settled = true;
            const missing = discussion?.peers.filter(p => !r.discussionReplies!.has(p.key));
            const issue = end.ok && missing?.length ? `토의 미완료: ${missing.map(p => p.nickname).join(", ")}의 실제 참여 응답이 없습니다. 보완하거나 미완료 사유를 보고하세요.`
              : end.ok && message.includes("[이미지 결과 필수]") && ![...r.files].some(path => /\.(png|jpe?g|webp)$/i.test(path) && existsSync(resolvePath(project.folder, path))) ? "이미지 생성 미완료: 실제 이미지 파일이나 첨부 결과를 확인하지 못했습니다." : "";
            resolve({ ...end, ...(issue ? { ok: false, error: issue } : {}), text: issue ? `${issue}\n${r.text}` : r.text, files: [...r.files], webAccountId: r.webAccountId });
          },
        };
        const m = this.running.get(chatId) ?? new Map<Role, Running>();
        m.set(target.key, r);
        this.running.set(chatId, m);
        this.chats.agentsChanged(chatId);
        if (this.stopped.has(chatId) || this.epochs.get(chatId) !== epoch) return r.resolve({ ok: false, interrupted: true });
        void (async () => {
          try {
            const driver = await this.chats.driver(chatId, target.key, reasoning.effort);
            if (this.stopped.has(chatId) || this.epochs.get(chatId) !== epoch || settled) return r.resolve({ ok: false, interrupted: true });
            await driver.send({
              text: kindPrefix(kind, callerName, scope) + message + `\n\n[현재 팀과 최근 결과]\n${this.agentsText(chatId, true)}` + this.readMessages(chatId, target.key),
              requiresImage: message.includes("[이미지 결과 필수]"),
              webAccountId: target.kind === "gemini" && this.chats.usesGeminiWeb(chat) ? target.webAccountId : undefined,
              attachments,
              noWrites: kind !== "implement",
            });
          } catch (e) {
            r.resolve({ ok: false, error: e instanceof Error ? e.message : String(e) });
          }
        })();
      });

      this.chats.setRoute(chatId, target.key, undefined);
      if (kind === "implement") this.releaseScope(chatId, consult.id);
      this.chats.agentsChanged(chatId);
      const hasResult = !!result.text.trim() || result.files.length > 0;
      const status = this.stopped.has(chatId) ? "stopped" : result.ok && hasResult ? "done" : result.interrupted ? "stopped" : "error";
      const accountInfo = target.kind === "gemini" && this.chats.usesGeminiWeb(chat)
        ? `[Gemini 웹 지정 계정=${target.webAccountId ?? "없음"} · 실제 실행 계정=${result.webAccountId ?? "연결 전 실패/중지"}]\n` : "";
      const summary = accountInfo + [!result.ok ? result.error : undefined, result.text.trim()].filter(Boolean).join("\n")
        + (!result.text.trim() && !result.error ? (result.files.length ? `산출물 ${result.files.length}개를 생성·수정했습니다.` : "작업자의 응답과 산출물이 없습니다.") : "");
      const finished = this.chats.store.finishConsult(consult.id, status, summary, result.files);
      this.chats.sink.consult(finished);
      this.chats.emit(chatId, this.chats.route(chatId, caller), caller, { type: "consult_end", consultId: consult.id, status, summary, files: result.files });
      // The worker queue remains held until its native log is safely archived.
      await this.chats.archiveWorker(chatId, target.key);
      this.running.get(chatId)?.delete(target.key);
      this.chats.agentsChanged(chatId);

      const head =
        status === "done"
          ? `[${target.nickname} · ${CONSULT_KIND_LABEL[kind]} 결과]`
          : status === "stopped"
            ? `[${target.nickname}: 사용자가 중지했습니다. 더 맡기지 말고 멈추세요.]`
            : `[${target.nickname}: 오류 — ${result.error ?? "실패"}]`;
      const files = result.files.length ? `\n\n변경된 파일:\n${result.files.map((f) => `- ${f}`).join("\n")}` : "\n\n변경된 파일: 없음";
      const effortLabel = target.kind === "gemini" && this.chats.usesGeminiWeb(chat) ? "웹 모델 설정" : reasoning.effort || "CLI 기본";
      return textResult(`${head} 협의 id=${consult.id} · 추론 ${effortLabel}\n${summary}${files}${caller === "orch" ? this.takeQueued(chatId) : ""}`, status !== "done");
    } finally {
      assignments.delete(assignmentKey);
      removeWait(this.graph(chatId), caller, target.key);
      done();
    }
  }

  /** Writes a worker may make right now: its implement scope, nothing during review/opinion. */
  private guardApproval(chatId: number, input: ApprovalInput): string | null {
    if (this.stopped.has(chatId) || ["pausing", "paused"].includes(this.chats.store.chat(chatId)?.status ?? "")) return "작업이 중지되었습니다.";
    const mutation = !!input.writes || !!input.diffs?.length || (!!input.command && !isReadCommand(input.command));
    if (!mutation) return null;
    if (this.stopped.has(chatId)) return "작업이 중지되었습니다.";
    if (this.planning.has(chatId) || this.reviewing.has(chatId)) return "계획·리뷰 중에는 파일 수정이나 변경 명령을 실행할 수 없습니다.";
    const investigation = this.investigationIssue(chatId);
    if (investigation) return investigation;
    if (input.role === "orch") {
      if (this.scopeLocks.get(chatId)?.length) return "작업자가 구현 중입니다. 작업이 끝난 뒤 마스터의 직접 변경을 다시 요청하세요.";
    } else {
      const r = this.running.get(chatId)?.get(input.role);
      if (!r || r.kind !== "implement") return "구현을 맡은 동안에만 파일 수정이나 변경 명령을 실행할 수 있습니다.";
    }
    return null;
  }

  private writeScope(chatId: number, role: Role): { globs: string[] | null; why: string } | null {
    if (role === "orch" && (this.planning.has(chatId) || this.reviewing.has(chatId))) return { globs: [], why: "계획·리뷰 중에는 수정할 수 없습니다" };
    if (!isWorkerKey(role)) return null;
    const r = this.running.get(chatId)?.get(role);
    if (!r) return null;
    if (r.kind !== "implement") return { globs: [], why: `${CONSULT_KIND_LABEL[r.kind]} 요청 중에는 파일을 고치지 않습니다` };
    return r.scope.length ? { globs: r.scope, why: `맡은 범위(${r.scope.join(", ")}) 밖` } : null;
  }

  /** Collect each running consult's answer and changed files from the worker's events. */
  private observe(chatId: number, role: Role, event: AgentEvent) {
    if (role === "orch") {
      if (event.type === "text" && event.text.trim()) {
        const inst = this.instructions.get(chatId);
        if (inst) inst.pendingImmediate = false;
      }
      if (event.type === "tool_call" && isMutatingTool(event.name, event.input, !!event.diffs?.length)) {
        const active = this.masterActions.get(chatId) ?? new Set<string>();
        active.add(event.id);
        this.masterActions.set(chatId, active);
      } else if (event.type === "tool_result" || event.type === "file_change" || event.type === "turn_end") {
        if (event.type === "turn_end") this.masterActions.delete(chatId);
        else this.masterActions.get(chatId)?.delete(event.id);
        if (!this.masterActions.get(chatId)?.size) this.releaseScope(chatId, -1);
      }
    }
    if (role === "orch" && event.type === "turn_end") {
      if (event.ok && !event.interrupted) this.publishArtifacts(chatId);
      this.reviewing.delete(chatId);
      this.afterMasterTurn(chatId, event);
      // Extra instructions that arrived after the master's last ask become the next turn.
      const inst = this.instructions.get(chatId);
      if (inst?.queued.length && !event.interrupted && !this.stopped.has(chatId)) {
        const q = inst.queued.splice(0);
        setTimeout(() => {
          const chat = this.chats.store.chat(chatId);
          if (!chat || this.instructions.get(chatId) !== inst || this.stopped.has(chatId) || ["pausing", "paused"].includes(chat.status)) return;
          this.chats.updateChat(chatId, { status: "working", touch: true });
          this.instruct(chat, { text: q.map((x) => x.text).join("\n\n"), attachments: q.flatMap((x) => x.attachments) }).catch((e) => {
            this.chats.emit(chatId, "orch", "orch", { type: "error", kind: "process", message: String(e) });
            this.chats.orchTurnEnded(chatId, { type: "turn_end", ok: false, error: String(e) });
          });
        }, 0);
      }
      return;
    }
    const r = this.running.get(chatId)?.get(role);
    if (!r) return;
    switch (event.type) {
      case "notice":
        if (event.webAccountId) r.webAccountId = event.webAccountId;
        break;
      case "text_delta":
        r.text += event.text;
        break;
      case "text":
        r.text = event.text;
        break;
      case "tool_call":
        if (event.diffs?.length) r.pendingFiles.set(event.id, event.diffs.flatMap((d) => d.movePath ? [d.path, d.movePath] : [d.path]));
        break;
      case "tool_result": {
        const files = r.pendingFiles.get(event.id);
        if (files && event.ok) for (const f of files) r.files.add(f);
        r.pendingFiles.delete(event.id);
        break;
      }
      case "file_change":
        if (event.ok) for (const f of event.files) {
          r.files.add(f.path);
          if (f.movePath) r.files.add(f.movePath);
        }
        break;
      case "image_generation":
        if (event.status === "done" && event.attachment) r.files.add(event.attachment.path);
        break;
      case "turn_end":
        r.resolve({ ok: event.ok, interrupted: event.interrupted, error: event.error });
        break;
    }
  }

  // ---------- user instructions
  private newInstruction(chatId: number, text: string, restore = false): Instruction {
    const events = this.chats.store.events(chatId);
    const id = events.findLast((e) => e.event.type === "user")?.id ?? 0;
    const previous = restore ? events.findLast((e) => e.event.type === "dispatch" && e.event.instructionId === id)?.event : undefined;
    return { id, mode: previous?.type === "dispatch" ? previous.mode : undefined, dualInvestigation: previous?.type === "dispatch" ? previous.dualInvestigation : undefined, text, asks: 0, reviews: 0, requests: new Map(), queued: [], pinned: [] };
  }

  private investigationIssue(chatId: number): string | null {
    const inst = this.instructions.get(chatId);
    return inst?.dualInvestigation ? dualInvestigationIssue(inst.id, this.chats.store.listConsults(chatId), this.agents(chatId)) : null;
  }

  /** Always retain clickable outputs the app observed, even when a model omits links in its prose. */
  private publishArtifacts(chatId: number) {
    const inst = this.instructions.get(chatId), chat = this.chats.store.chat(chatId);
    const project = chat && this.chats.store.project(chat.projectId);
    if (!inst || !project) return;
    const paths = this.chats.store.listConsults(chatId).filter((c) => c.instructionId === inst.id && c.status === "done").flatMap((c) => c.filesChanged);
    const already = new Set<string>();
    for (const e of this.chats.store.events(chatId).filter((e) => e.id > inst.id)) {
      if (e.event.type === "image_generation" && e.event.attachment) paths.push(e.event.attachment.path);
      if (e.role === "orch" && e.event.type === "file_change" && e.event.ok) paths.push(...e.event.files.filter((f) => f.kind !== "delete").map((f) => f.movePath ?? f.path));
      if (e.event.type === "artifacts") for (const p of e.event.paths) already.add(p.toLowerCase());
    }
    const outputs = [...new Map(paths.map((p) => { const full = resolvePath(project.folder, p); return [full.toLowerCase(), full]; })).values()].filter((p) => {
      try { return !already.has(p.toLowerCase()) && existsSync(p) && statSync(p).isFile(); } catch { return false; }
    });
    if (outputs.length) this.chats.emit(chatId, "orch", "orch", { type: "artifacts", paths: outputs });
  }

  private checkCompletion(chatId: number, end: Extract<AgentEvent, { type: "turn_end" }>): Extract<AgentEvent, { type: "turn_end" }> | null {
    const inst = this.instructions.get(chatId);
    if (!inst || !end.ok || end.interrupted || this.stopped.has(chatId) || this.planning.has(chatId)) return end;
    const chat = this.chats.store.chat(chatId);
    if (!chat) return end;
    // Immediate input may detach the master's native ask call while app workers continue.
    // Wait for those existing jobs and resume synthesis without spending the repair attempt.
    if (this.assignments.get(chatId)?.size || this.chats.store.listConsults(chatId).some((c) => c.instructionId === inst.id && c.status === "running")) {
      if (!inst.waitingForResults) {
        inst.waitingForResults = true;
        const pending = [...this.workerQueue].filter(([key]) => key.startsWith(`${chatId}:`)).map(([, promise]) => promise);
        void Promise.allSettled(pending).then(async () => {
          inst.waitingForResults = false;
          if (this.stopped.has(chatId) || this.instructions.get(chatId) !== inst || !this.chats.store.chat(chatId)) return;
          try {
            const driver = await this.chats.driver(chatId, "orch");
            if (driver.running || this.stopped.has(chatId) || this.instructions.get(chatId) !== inst) return;
            this.chats.updateChat(chatId, { status: "working" });
            await driver.send({ text: `[앱 작업자 결과 도착 — 기존 지시 계속]\n${this.agentsText(chatId, true)}\n기존 결과를 검토하고 사용자 추가 지시를 반영해 취합하세요. 응답 재수신만을 위한 재배정은 필요 없습니다.${this.takeQueued(chatId)}`, attachments: [], noWrites: this.reviewing.has(chatId) });
          } catch (e) {
            const error = String(e);
            this.chats.emit(chatId, "orch", "orch", { type: "error", message: error });
            this.chats.orchTurnEnded(chatId, { type: "turn_end", ok: false, error });
          }
        });
      }
      return null;
    }
    const issue = this.investigationIssue(chatId) ?? completionIssue(inst.id, inst.mode, this.chats.store.listConsults(chatId), !!this.chats.store.project(chat.projectId)?.settings.reviewGate);
    if (!issue) return end;
    this.chats.emit(chatId, "orch", "orch", { type: "notice", text: `완료 확인: ${issue}` });
    if (inst.repaired) return { ...end, ok: false, error: `미완료: ${issue}` };
    inst.repaired = true;
    // Resume the same instruction once. Do not reset its limits or lose its queued user input.
    setTimeout(() => {
      if (this.stopped.has(chatId) || this.instructions.get(chatId) !== inst || !this.chats.store.chat(chatId)) return;
      void (async () => {
        try {
          const driver = await this.chats.driver(chatId, "orch");
          if (this.stopped.has(chatId) || this.instructions.get(chatId) !== inst) return;
          await driver.send({ text: `[앱 완료 검사 — 보완 1회] ${issue}\n본 작업은 앱 작업자에게 배정해야 합니다. 실제 결과를 검토하고 취합하세요. 더 진행할 수 없으면 미완료 사유를 분명히 보고하세요.${this.takeQueued(chatId)}`, attachments: [], noWrites: this.reviewing.has(chatId) });
        } catch (e) {
          const message = String(e);
          this.chats.emit(chatId, "orch", "orch", { type: "error", message });
          this.chats.orchTurnEnded(chatId, { type: "turn_end", ok: false, error: message });
        }
      })();
    }, 0);
    return null;
  }

  /** Hand a summary to a new provider/session, including Gemini CLI ↔ AI Studio. */
  private handover(chat: Chat): string {
    const project = this.chats.store.project(chat.projectId)!;
    const { agent, model } = chatOrchestrator(chat, project);
    const session = agent === "gemini" && isAIStudioModel(model) ? `${agent}:${model}` : agent;
    const key = `orchAgent:${chat.id}`;
    const prev = this.chats.store.getSetting(key);
    this.chats.store.setSetting(key, session);
    if (!prev || prev === session) return "";
    const agents = this.agents(chat.id);
    const lines: string[] = [];
    for (const e of this.chats.store.events(chat.id)) {
      const ev = e.event;
      if (ev.type === "user" && ev.text) lines.push(`사용자: ${clipText(ev.text, 500)}`);
      else if (ev.type === "text" && e.role === "orch") lines.push(`마스터: ${clipText(ev.text, 500)}`);
      else if (ev.type === "consult_end")
        lines.push(`작업 결과(${ev.status}): ${clipText(ev.summary, 400)}${ev.files.length ? ` · 변경: ${ev.files.join(", ")}` : ""}`);
    }
    const team = agents.filter((a) => a.status === "active").map((a) => `${a.nickname}(${a.job || "역할 미정"})`).join(", ");
    const recent = lines.slice(-16).join("\n").slice(-6000);
    const name = (a: string) => a.startsWith("gemini:aistudio:") ? `제미나이 · AI Studio (${a.slice(16)})` : AGENT_LABEL[a as AgentKind] ?? a;
    this.chats.emit(chat.id, "orch", null, { type: "notice", text: `마스터가 ${name(session)}로 바뀌어 지금까지의 요약을 넘깁니다` });
    return `[AI_ChatterBox] 이 채팅의 마스터가 ${name(prev)}에서 ${name(session)}로 바뀌었습니다.${team ? ` 지금 팀: ${team}.` : ""} 지금까지의 대화 요약:\n${recent}\n\n---\n`;
  }

  private async instruct(chat: Chat, input: AgentInput) {
    const epoch = this.nextEpoch(chat.id);
    this.stopped.delete(chat.id);
    const prefix = this.handover(chat);
    if (prefix) input = { ...input, text: prefix + input.text };
    this.instructions.set(chat.id, this.newInstruction(chat.id, input.text));
    try {
      const driver = await this.chats.driver(chat.id, "orch");
      if (this.stopped.has(chat.id) || this.epochs.get(chat.id) !== epoch) return;
      await driver.send({ ...input, text: input.text + attachmentNote(input.attachments) + (this.planning.has(chat.id) ? "" : "\n\n[앱 협업 규칙] 먼저 route_request로 처리 방식을 기록하세요. 본 작업은 앱 spawn/ask로 배정하고 reason에 담당 선택 이유를 적으세요. CLI 내부 에이전트는 사용하지 마세요."), noWrites: this.planning.has(chat.id) || this.reviewing.has(chat.id) });
    } catch (error) {
      if (!this.stopped.has(chat.id) && this.epochs.get(chat.id) === epoch) throw error;
    }
  }

  /** Start a master turn with prepared text (same bookkeeping as a normal instruction). */
  private async instructWith(chat: Chat, text: string, contextText: string) {
    await this.instruct(chat, { text, attachments: [] });
    const inst = this.instructions.get(chat.id);
    if (inst) inst.text = contextText;
  }

  /**
   * Continue a run the app quit or crashed in the middle of: the master resumes its session and is
   * told to check the folder and finish; workers keep their own sessions (agents table) for later asks.
   */
  async resume(chatId: number) {
    const chat = this.chats.store.chat(chatId);
    if (chat?.status === "paused") return this.resumePaused(chat);
    if (!chat || chat.status !== "interrupted") return;
    const epoch = this.nextEpoch(chatId);
    const last = [...this.chats.store.events(chatId)].reverse().find((e) => e.event.type === "user" && !e.event.queued)?.event as { text: string } | undefined;
    const original = last?.text ?? "";
    // Runtime mode sets are empty after restart; restore the interrupted command's restriction.
    if (/^\/plan(?:\s|$)/.test(original)) this.planning.add(chatId);
    if (/^\/review(?:\s|$)/.test(original)) this.reviewing.add(chatId);
    this.chats.emit(chatId, "orch", null, { type: "notice", text: "중단된 작업을 이어서 진행합니다" });
    this.chats.updateChat(chatId, { status: "working", touch: true });
    this.stopped.delete(chatId);
    this.instructions.set(chatId, this.newInstruction(chatId, original, true));
    const team = this.agents(chatId).filter((a) => a.status === "active").map((a) => a.nickname).join(", ");
    const note =
      "[AI_ChatterBox] 이전 실행이 앱 종료로 중단됐습니다. 작업 폴더의 현재 상태(git status, git diff, 파일 내용)를 확인하고, " +
      `아래 원래 지시의 남은 작업을 이어서 끝낸 뒤 결과를 보고하세요. 이미 끝난 부분은 다시 하지 마세요.${team ? ` 팀(${team})은 그대로 남아 있습니다.` : ""}\n\n원래 지시:\n` +
      (original || "(기록 없음)");
    if (!this.agents(chatId).length && (chat.orchCodexThreadId || chat.orchClaudeSessionId))
      this.chats.emit(chatId, "orch", null, { type: "notice", text: "이전 버전의 CLI 내부 작업자 대화는 앱에 저장되지 않았을 수 있습니다. 새 배정부터 앱 작업자 기록으로 표시합니다." });
    try {
      const driver = await this.chats.driver(chatId, "orch");
      if (this.stopped.has(chatId) || this.epochs.get(chatId) !== epoch) return;
      await driver.send({ text: this.handover(chat) + note, attachments: [], noWrites: this.planning.has(chatId) || this.reviewing.has(chatId) });
    } catch (e) {
      if (this.stopped.has(chatId) || this.epochs.get(chatId) !== epoch) return;
      const message = e instanceof Error ? e.message : String(e);
      this.planning.delete(chatId);
      this.reviewing.delete(chatId);
      this.chats.emit(chatId, "orch", "orch", { type: "error", kind: "process", message });
      this.chats.orchTurnEnded(chatId, { type: "turn_end", ok: false, error: message });
    }
  }

  dismissInterrupted(chatId: number) {
    if (this.chats.store.chat(chatId)?.status === "interrupted") this.chats.updateChat(chatId, { status: "idle" });
  }

  /** The user typed while the team was working: hand it to the master at the next boundary. */
  private async queue(chat: Chat, input: AgentInput) {
    const state = chat.status === "paused" ? this.pauseState(chat.id) : undefined;
    const inst = this.instructions.get(chat.id) ?? (state && this.restoreInstruction(state));
    if (!inst) throw new Error("작업이 진행 중입니다.");
    this.instructions.set(chat.id, inst);
    inst.queued.push(input);
    if (state) {
      state.instruction = { ...inst, requests: [...inst.requests] };
      this.chats.store.setSetting(`pause:${chat.id}`, JSON.stringify(state));
    }
    this.chats.emit(chat.id, "orch", null, { type: "notice", text: state ? "추가 지시를 보관했습니다. 재시작할 때 마스터에게 전달합니다." : "추가 지시를 받았습니다. 다음 단계에서 마스터에게 전달합니다." });
  }

  private async deliverNow(chat: Chat, input: AgentInput) {
    const inst = this.instructions.get(chat.id);
    if (!inst || this.stopped.has(chat.id)) throw new Error("중지되었거나 완료된 지시입니다. 새 지시로 보내 주세요.");
    const driver = this.chats.liveDriver(chat.id, "orch");
    const text = input.text + attachmentNote(input.attachments);
    const prompt = "[사용자 즉시 질문·수정 요청 — 작업 결과를 기다리지 말고 먼저 직접 답변]\n" + input.text + "\n\n질문에 먼저 한국어로 답하고, 수정 요청이면 이해한 내용과 반영 방법을 먼저 말하세요. 기존 작업자는 유지하며 본 작업의 위임·리뷰 요건도 유지합니다.";
    const remember = () => {
      inst.text += "\n\n[사용자 추가 지시]\n" + text;
      inst.pinned.push(text);
      inst.pendingImmediate = true;
    };
    let accepted = false;
    try { accepted = !!(await driver?.steer?.({ ...input, text: prompt })); }
    catch { /* A turn can finish between clicking send and the native receipt. Keep the message queued. */ }
    if (this.stopped.has(chat.id)) {
      this.chats.emit(chat.id, "orch", null, { type: "notice", text: "작업이 중지되어 즉시 전달하지 않았습니다. 이 메시지는 대화에 남아 있습니다." });
    } else if (accepted) {
      remember();
      this.wakeMasterConsults(chat.id);
      this.chats.emit(chat.id, "orch", null, { type: "notice", text: "마스터에게 즉시 전달했습니다. 기존 작업을 유지하면서 질문·수정 요청에 먼저 답변합니다." });
    } else if (driver && !driver.running) {
      // The master can be idle while workers still run; keep the existing instruction and its limits.
      this.chats.updateChat(chat.id, { status: "working", touch: true });
      remember();
      await driver.send({ ...input, text: prompt, noWrites: this.planning.has(chat.id) || this.reviewing.has(chat.id) });
    } else if (driver && this.masterConsultWaiters.get(chat.id)?.size) {
      remember();
      this.wakeMasterConsults(chat.id);
      this.chats.emit(chat.id, "orch", null, { type: "notice", text: "마스터의 협의 대기를 풀고 추가 요청을 전달했습니다. 기존 작업자는 계속 작업합니다." });
    } else {
      await this.queue(chat, input);
      this.chats.emit(chat.id, "orch", null, { type: "notice", text: "현재 CLI가 즉시 전달을 받지 못해 다음 단계 전달로 보관했습니다." });
    }
  }

  /** Extra instructions ride along with the master's next tool result, and stay pinned to later ones. */
  private takeQueued(chatId: number): string {
    const inst = this.instructions.get(chatId);
    if (!inst) return "";
    const fresh = inst.queued.splice(0);
    inst.pinned.push(...fresh.map((x) => x.text + attachmentNote(x.attachments)));
    if (!inst.pinned.length) return "";
    return "\n\n[사용자 추가 지시 — 작업 중에 도착함, 최종 보고까지 반드시 반영]\n" + inst.pinned.map((t) => `- ${t}`).join("\n");
  }

  // ---------- slash commands
  async command(chatId: number, name: string, arg: string) {
    const chat = this.chats.store.chat(chatId);
    if (!chat) throw new Error("채팅이 없습니다.");
    const busy = ["working", "approval", "pausing", "paused"].includes(chat.status) || this.chats.isBusy(chatId);
    const needIdle = () => {
      if (busy) throw new Error("작업이 진행 중입니다. 끝나거나 중지한 뒤 다시 시도하세요.");
    };
    switch (name) {
      case "plan": {
        needIdle();
        if (!arg.trim()) throw new Error("/plan 뒤에 계획할 지시를 적어 주세요.");
        this.planRunning.delete(chatId);
        this.planning.add(chatId);
        const text =
          "[계획 모드] 아래 지시에 대한 계획만 세워라. 작업자를 만들거나 맡기지 말고 파일도 바꾸지 마라. 필요한 만큼 코드를 읽고 조사한 뒤, " +
          "checklist 도구로 단계를 등록하라(각 단계 제목 앞에 담당 예정 [클로드 1호] / [지피티 1호] / [마스터], 몇 명이 필요한지도 계획에 넣어라). 마지막에 계획을 짧게 요약해 답하라. " +
          "사용자가 '실행'을 누르면 그때 이 계획대로 진행한다.\n\n지시: " +
          arg;
        await this.chats.startTurn(chatId, `/plan ${arg}`, [], () => this.instructWith(chat, text, arg));
        return;
      }
      case "plan-run": {
        needIdle();
        this.planning.delete(chatId);
        this.planRunning.add(chatId);
        this.chats.emit(chatId, "orch", null, { type: "plan_state", state: "running" });
        const text =
          "사용자가 계획을 승인했다. 계획대로 실행하라: 필요한 작업자를 spawn 하고, 단계마다 담당 작업자에게 ask로 맡기고(implement는 scope 지정), 단계를 시작·완료할 때마다 checklist를 갱신하고, " +
          "모든 단계를 완료로 표시한 뒤 결과를 보고하라.";
        await this.chats.startTurn(chatId, "계획 실행", [], () => this.instructWith(chat, text, "계획 실행"));
        return;
      }
      case "plan-cancel":
        this.planning.delete(chatId);
        this.planRunning.delete(chatId);
        this.chats.emit(chatId, "orch", null, { type: "plan_state", state: "cancelled" });
        return;
      case "goal": {
        const a = arg.trim();
        if (!a) {
          this.chats.emit(chatId, "orch", null, {
            type: "notice",
            text: chat.goal ? `현재 목표: ${chat.goal.objective} (${goalStatusLabel(chat.goal.status)})` : "설정된 목표가 없습니다. /goal <목표> 로 정하세요.",
          });
          return;
        }
        if (a === "clear" || a === "지우기") {
          this.setGoal(chatId, null);
          this.chats.emit(chatId, "orch", null, { type: "notice", text: "목표를 지웠습니다." });
          return;
        }
        needIdle();
        this.setGoal(chatId, { objective: a, status: "active", progress: "", turns: 1, updatedAt: Date.now() });
        const text =
          `[목표] 이 채팅의 목표: ${a}\n이 목표를 이룰 때까지 일하라. checklist로 단계를 관리하고, 필요한 작업자를 만들어 맡기고, 단계마다 update_goal로 진행을 보고하라. ` +
          "목표를 다 이루면 update_goal(status=complete)로 알리고 결과를 보고하라.";
        await this.chats.startTurn(chatId, `/goal ${a}`, [], () => this.instructWith(chat, text, a));
        return;
      }
      case "review": {
        needIdle();
        this.reviewing.add(chatId);
        const text =
          "현재 작업 폴더의 커밋되지 않은 변경(git status, git diff)을 리뷰해 줘. 변경을 직접 만들지 않은 작업자에게 kind=review로 맡기고(없으면 만들어서), 지적 사항을 심각도와 함께 정리해 보고해." +
          (arg ? ` 추가 요청: ${arg}` : "");
        await this.chats.startTurn(chatId, `/review${arg ? " " + arg : ""}`, [], () => this.instructWith(chat, text, text));
        return;
      }
      case "compact": {
        needIdle();
        const project = this.chats.store.project(chat.projectId)!;
        const { agent } = chatOrchestrator(chat, project);
        if (agent === "codex") {
          const threadId = chat.orchCodexThreadId;
          if (!threadId) throw new Error("아직 압축할 대화가 없습니다.");
          await this.chats.driver(chatId, "orch");
          await this.chats.codex().request("thread/compact/start", { threadId });
          this.chats.emit(chatId, "orch", null, { type: "notice", text: "마스터 대화를 압축했습니다 (Codex)." });
        } else {
          await this.chats.startTurn(chatId, "/compact", [], async () => {
            await (await this.chats.driver(chatId, "orch")).send({ text: "/compact", attachments: [] });
          });
        }
        return;
      }
      case "stop":
        await this.stop(chatId);
        return;
      default:
        throw new Error(`알 수 없는 명령: /${name}`);
    }
  }

  private setGoal(chatId: number, goal: ChatGoal | null) {
    this.chats.updateChat(chatId, { goal });
    this.chats.emit(chatId, "orch", null, { type: "goal_update", goal });
  }

  private updateGoal(chatId: number, status: string, progress: string): string {
    const chat = this.chats.store.chat(chatId);
    if (!chat?.goal) return "이 채팅에는 목표가 없습니다.";
    const st = status === "complete" || status === "blocked" ? status : "active";
    this.setGoal(chatId, { ...chat.goal, status: st, progress: progress || chat.goal.progress, updatedAt: Date.now() });
    return st === "complete" ? "목표 완료로 기록했습니다. 결과를 사용자에게 보고하세요." : "진행 상황을 기록했습니다.";
  }

  /** Plan proposals and goal auto-continuation after the master's turn. */
  private afterMasterTurn(chatId: number, end: Extract<AgentEvent, { type: "turn_end" }>) {
    if (this.planning.has(chatId)) {
      this.planning.delete(chatId);
      if (end.ok) this.chats.emit(chatId, "orch", null, { type: "plan_state", state: "proposed" });
    } else if (this.planRunning.has(chatId)) {
      this.planRunning.delete(chatId);
      this.chats.emit(chatId, "orch", null, { type: "plan_state", state: end.ok ? "done" : "cancelled" });
    }
    const chat = this.chats.store.chat(chatId);
    const goal = chat?.goal;
    if (!chat || !goal || goal.status !== "active" || !end.ok || end.interrupted || this.stopped.has(chatId)) return;
    if (goal.turns >= MAX_GOAL_TURNS) {
      this.setGoal(chatId, { ...goal, status: "paused", updatedAt: Date.now() });
      this.chats.emit(chatId, "orch", null, {
        type: "notice",
        text: `목표를 향해 ${MAX_GOAL_TURNS}번 이어서 진행했지만 끝나지 않아 멈췄습니다. 이어서 하려면 지시를 보내세요.`,
      });
      return;
    }
    setTimeout(() => {
      const c = this.chats.store.chat(chatId);
      if (!c?.goal || c.goal.status !== "active" || this.stopped.has(chatId) || ["working", "pausing", "paused"].includes(c.status) || this.chats.isBusy(chatId)) return;
      this.setGoal(chatId, { ...c.goal, turns: c.goal.turns + 1, updatedAt: Date.now() });
      const text = `[목표 계속] 목표: ${c.goal.objective}\n지금까지: ${c.goal.progress || "(보고 없음)"}\n남은 일을 이어서 하라. 다 이뤘으면 update_goal(status=complete)로 알리고 보고하라.`;
      void this.chats.startTurn(chatId, "목표를 향해 계속 진행", [], () => this.instructWith(c, text, c.goal!.objective));
    }, 300);
  }

  private attachmentsFor(chatId: number, paths: string[]): AttachmentRef[] {
    const out: AttachmentRef[] = [];
    for (const p of paths) {
      if (!existsSync(p)) continue;
      const known = this.chats.store.db.prepare("SELECT id FROM attachments WHERE chat_id = ? AND path = ?").get(chatId, p) as { id: number } | undefined;
      if (known) out.push(this.chats.store.attachment(known.id)!);
      else out.push({ id: 0, name: basename(p), mime: mimeOf(p), size: statSync(p).size, path: p });
    }
    return out;
  }

  // ---------- ask_user
  private askUser(chatId: number, question: string, options: string[]): Promise<string> {
    const id = `ask:${randomUUID()}`;
    this.chats.emit(chatId, "orch", "orch", { type: "ask_user", id, question, options });
    this.chats.updateChat(chatId, { status: "approval" });
    return new Promise((resolve) => this.asks.set(id, { chatId, resolve }));
  }

  answerAsk(chatId: number, askId: string, answer: string) {
    const a = this.asks.get(askId);
    if (!a || a.chatId !== chatId) return;
    this.asks.delete(askId);
    this.chats.emit(chatId, "orch", null, { type: "ask_user_answer", id: askId, answer });
    this.chats.updateChat(chatId, { status: "working" });
    a.resolve(`사용자 답변: ${answer}`);
  }

  // ---------- stop
  async stop(chatId: number, preserve = false) {
    this.nextEpoch(chatId);
    this.stopped.add(chatId);
    for (const controller of this.webChecks.get(chatId) ?? []) controller.abort(new Error("사용자가 계정 조회 대기를 중지했습니다."));
    if (!preserve) this.chats.store.setSetting(`pause:${chatId}`, "");
    this.wakeMasterConsults(chatId);
    for (const [id, a] of [...this.asks]) {
      if (a.chatId !== chatId) continue;
      this.asks.delete(id);
      this.chats.emit(chatId, "orch", null, { type: "ask_user_answer", id, answer: "(중지됨)" });
      a.resolve("사용자가 작업을 중지했습니다. 멈추세요.");
    }
    const inst = this.instructions.get(chatId);
    if (inst && !preserve) inst.queued = [];
    // Wake anything waiting for a scope so it sees the stop.
    const w = this.scopeWaiters.get(chatId) ?? [];
    this.scopeWaiters.set(chatId, []);
    for (const f of w) f();
    await this.chats.stop(chatId);
    if (!preserve && ["pausing", "paused"].includes(this.chats.store.chat(chatId)?.status ?? "")) this.chats.updateChat(chatId, { status: "idle" });
  }

  private pauseState(chatId: number): PauseState | undefined {
    const raw = this.chats.store.getSetting(`pause:${chatId}`);
    return raw ? JSON.parse(raw) as PauseState : undefined;
  }

  private restoreInstruction(state: PauseState): Instruction {
    return { ...state.instruction, requests: new Map(state.instruction.requests), waitingForResults: false, pendingImmediate: false };
  }

  pause(chatId: number): Promise<void> {
    const active = this.pauseFlights.get(chatId);
    if (active) return active;
    const chat = this.chats.store.chat(chatId);
    if (!chat || !["working", "approval"].includes(chat.status)) return Promise.resolve();
    const flight = this.pauseChat(chat).finally(() => this.pauseFlights.delete(chatId));
    this.pauseFlights.set(chatId, flight);
    return flight;
  }

  private async pauseChat(chat: Chat) {
    const inst = this.instructions.get(chat.id) ?? this.newInstruction(chat.id, "", true);
    const state: PauseState = {
      folder: this.chats.store.project(chat.projectId)!.folder,
      instruction: { ...inst, requests: [...inst.requests] },
      planning: this.planning.has(chat.id), reviewing: this.reviewing.has(chat.id),
      assignments: [...(this.assignments.get(chat.id)?.values() ?? [])],
    };
    this.stopped.add(chat.id);
    this.chats.store.setSetting(`pause:${chat.id}`, JSON.stringify(state));
    this.chats.updateChat(chat.id, { status: "pausing", touch: true });
    this.chats.emit(chat.id, "orch", null, { type: "notice", text: "마스터와 실행 중인 모든 작업자에게 일시 중지를 요청했습니다." });
    await Promise.all([this.stop(chat.id, true), this.judge.interrupt(chat.id)]);
    while (this.chats.store.chat(chat.id) && this.chats.isBusy(chat.id)) await new Promise<void>(resolve => setTimeout(resolve, 25));
    await Promise.allSettled([...this.workerQueue].filter(([key]) => key.startsWith(`${chat.id}:`)).map(([, job]) => job));
    const saved = this.pauseState(chat.id);
    if (!this.chats.store.chat(chat.id) || !saved) return;
    this.instructions.set(chat.id, this.restoreInstruction(saved));
    this.chats.updateChat(chat.id, { status: "paused", touch: true });
    this.chats.emit(chat.id, "orch", null, { type: "notice", text: "일시 정지되었습니다. 재시작하면 같은 마스터와 작업자가 남은 작업을 이어갑니다." });
  }

  private async resumePaused(chat: Chat) {
    const state = this.pauseState(chat.id);
    if (!state) throw new Error("보관된 재시작 정보가 없습니다.");
    if (state.folder !== this.chats.store.project(chat.projectId)?.folder) throw new Error("일시 정지 후 작업 폴더가 바뀌었습니다. 원래 폴더로 복원한 뒤 재시작하세요.");
    const epoch = this.nextEpoch(chat.id);
    const inst = this.restoreInstruction(state);
    this.instructions.set(chat.id, inst);
    if (state.planning) this.planning.add(chat.id); else this.planning.delete(chat.id);
    if (state.reviewing) this.reviewing.add(chat.id); else this.reviewing.delete(chat.id);
    this.stopped.delete(chat.id);
    this.chats.updateChat(chat.id, { status: "working", touch: true });
    this.chats.emit(chat.id, "orch", null, { type: "notice", text: "마스터와 일시 정지했던 작업자에게 재시작을 요청합니다." });
    for (const assignment of state.assignments) {
      const target = this.chats.store.agentByKey(chat.id, assignment.target.key);
      if (!target || target.status !== "active") continue;
      const prior = assignment.consultId ? this.chats.store.consult(assignment.consultId) : undefined;
      const message = `[일시 정지한 작업 재시작]\n현재 파일과 이전 진행 상태를 확인하고 남은 부분만 이어가세요. 이미 완료된 변경은 반복하지 마세요.\n\n${assignment.message}${prior?.responseSummary ? `\n\n중지 전 진행 내용:\n${prior.responseSummary}` : ""}`;
      void this.consult(chat.id, assignment.caller, target, assignment.kind, message, assignment.scope, assignment.attach, "일시 정지한 기존 작업을 같은 담당자에게 재전달", prior?.id, assignment.effort, assignment.discussion, true).catch(error => {
        this.chats.emit(chat.id, target.key, target.key, { type: "error", message: `작업 재시작 실패: ${String(error)}` });
      });
    }
    try {
      const driver = await this.chats.driver(chat.id, "orch");
      if (this.stopped.has(chat.id) || this.epochs.get(chat.id) !== epoch) return;
      await driver.send({
        text: `[일시 정지 후 기존 지시 계속]\n${inst.text}\n\n같은 작업자에게 미완료 요청을 재전달했습니다. 이미 끝난 작업은 반복하거나 중복 배정하지 말고 현재 상태를 확인하세요. 기존 배정 결과를 기다려 검토·취합하세요. 만료된 승인·질문은 필요한 경우 다시 요청하세요.${this.takeQueued(chat.id)}`,
        attachments: [], noWrites: state.planning || state.reviewing,
      });
    } catch (error) {
      if (this.stopped.has(chat.id) || this.epochs.get(chat.id) !== epoch) return;
      this.chats.emit(chat.id, "orch", "orch", { type: "error", message: `마스터 재시작 실패: ${String(error)}` });
      this.chats.orchTurnEnded(chat.id, { type: "turn_end", ok: false, error: String(error) });
    }
  }

  forget(chatId: number) {
    for (const controller of this.webChecks.get(chatId) ?? []) controller.abort(new Error("채팅이 종료되었습니다."));
    this.chats.store.setSetting(`pause:${chatId}`, "");
    this.wakeMasterConsults(chatId);
    this.judge.forget(chatId);
    for (const [id, reg] of [...this.bridgeKeys]) {
      if (!id.startsWith(`br-${chatId}-`)) continue;
      this.chats.bridge.unregister(reg.key);
      this.bridgeKeys.delete(id);
    }
    this.instructions.delete(chatId);
    this.masterActions.delete(chatId);
    this.reviewing.delete(chatId);
    this.planning.delete(chatId);
  }
}

function goalStatusLabel(s: string) {
  return s === "complete" ? "완료" : s === "blocked" ? "막힘" : s === "paused" ? "멈춤" : "진행 중";
}

function clipText(s: string, n: number) {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > n ? t.slice(0, n) + "…" : t;
}

function kindPrefix(kind: ConsultKind, from: string, scope: string[]): string {
  switch (kind) {
    case "implement":
      return `[${from}의 구현 요청${scope.length ? ` · 고칠 수 있는 범위: ${scope.join(", ")}` : ""}]\n`;
    case "review":
      return `[${from}의 리뷰 요청 — 파일을 고치지 말고 문제점만 보고하세요]\n`;
    case "writing":
      return `[${from}의 글쓰기 요청 — 문장·캐릭터 대사·문서 본문만 작성하고 파일을 고치거나 코드 분석·기술 리뷰를 하지 마세요]\n`;
    default:
      return `[${from}의 의견 요청 — 파일을 고치지 마세요]\n`;
  }
}

/** The master sees images inline but needs paths to hand files to workers. */
function attachmentNote(files: AttachmentRef[]): string {
  if (!files.length) return "";
  return "\n\n[첨부 파일 경로 — 작업자에게 넘길 때 attach에 사용]\n" + files.map((f) => `- ${f.path}`).join("\n");
}

/** Project-relative path (for scope checks). */
export function relToProject(folder: string, p: string): string | null {
  const abs = isAbsolute(p) ? p : resolvePath(folder, p);
  const rel = relative(folder, abs);
  return rel.startsWith("..") || isAbsolute(rel) ? null : rel;
}
