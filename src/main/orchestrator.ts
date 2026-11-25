// Collaboration engine: one master (마스터, Claude or Codex) and a pool of workers
// (클로드 N호 / 지피티 N호) the master spawns and releases as the work needs. Everyone talks through
// the Bridge MCP server:
//   master:  spawn · ask · release · agents · checklist · update_goal · ask_user
//   workers: ask · agents          (call each other by nickname)
// An "ask" runs one turn on the target worker's own Claude session / Codex thread, streams it into the
// chat under a consult node. Workers can read reports; the master gets receipts and a final brief.
// Parallelism: a worker runs one turn at a time; review/opinion asks run concurrently; implement asks
// carry a scope (path globs) — non-overlapping scopes run concurrently, overlapping ones queue, and
// writes outside the scope are denied. A call that would wait in a cycle, or nest deeper than 3, is refused.
import { createHash, randomUUID } from "node:crypto";
import { existsSync, readdirSync, statSync } from "node:fs";
import { basename, isAbsolute, relative, resolve as resolvePath } from "node:path";
import {
  chatOrchestrator,
  CLI_ACCOUNT_KINDS,
  cliAccountKindForAgent,
  defaultCliAccountId,
  isCliAccountId,
  type CliAccountId,
  type CliAccountKind,
  type ResolvedCliAccount,
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
  type TimelineEvent,
  type WorkerKind,
} from "../shared/types";
import type { ChatManager } from "./chats";
import { bridgeServerConfig, textResult, type ToolDef, type ToolResult } from "./local-bridge";
import { mimeOf } from "./attachments";
import type { AgentInput } from "./drivers/types";
import { ApprovalJudge } from "./judge";
import { inScope, scopesOverlap } from "./scope";
import { isMutatingTool, isReadCommand } from "./execution-policy";
import type { ApprovalInput } from "./approvals";
import { addWait, checkAsk, removeWait, type WaitGraph } from "./team";
import { completionIssue, dualInvestigationIssue } from "./dispatch";
import { isAIStudioModel } from "../shared/aistudio";
import { cliRemaining, CLI_LOW_REMAINING, isAuthError, isQuotaError, PRIORITY_FAILURE_LABEL, type PriorityFailureReason } from "./cli-accounts";
import { planStepBlockers, readyGroupSteps, validatePlanSteps, validateProposedTasks } from "../shared/plan-steps";
import { alignNativeSteps, currentPlanView, droppedSteps, isOpenStep, keepDroppedSteps, openStepsText, pendingProposal, planStepsFor, stepKey } from "../shared/plan-lifecycle";
import { validateReviewResult } from "../shared/review-result";
import { forkContextPrompt } from "./chat-fork";
import { buildResumeContext, instructionToResume, parseInstructionSnapshot, type InstructionSnapshot } from "./resume-context";
import { consultResultText, consultStatusText, masterResultText } from "./consult-context";
import { Council, COUNCIL_TOOLS } from "./council";

const KINDS: ConsultKind[] = ["implement", "review", "opinion", "writing"];
const MAX_DEPTH = 3;
const MAX_GOAL_TURNS = 6;
const CLI_ACCOUNT_INPUT = { type: "string", pattern: "^(claude|gpt|gemini|grok)-([1-9]|10)$", description: "Claude/Codex/Antigravity/Grok CLI 계정 ID. 작업자 계열과 같아야 합니다. 프로젝트·전역 fixed 정책에서는 정책 계정만 허용하며, auto/기본 정책에서는 명시 지정을 적용합니다. priority(계정 우선 할당) 정책에서는 명시 지정을 먼저 쓰고, 그 계정이 한도·인증·무응답으로 실패하면 앱이 우선 순서의 다음 계정으로 이어서 실행합니다. 지정 해제는 clearAccountId=true로 요청하며 accountId와 함께 지정할 수 없습니다. 계정 번호를 작업자 번호로 추정하지 마세요." };
const CLEAR_CLI_ACCOUNT_INPUT = { type: "boolean", description: "true이면 저장된 CLI 계정 지정을 해제하고 프로젝트·전역 정책을 따릅니다. accountId와 동시에 지정할 수 없습니다." };
const CLI_ACCOUNTS_TOOL: ToolDef = {
  name: "cli_accounts",
  description: "Claude/Codex/Antigravity/Grok CLI 계정별 로그인·잔여량·실행 중 작업자와 적용 정책을 조회합니다. 이 조회는 계정을 선택하거나 작업을 자동 재시도하지 않습니다(priority 정책의 순차 전환은 배정 실행 중 앱이 처리). 10분이 지난 잔여량은 미확인입니다. 기본은 캐시 조회이며 refresh=true만 로그인·사용량을 갱신합니다.",
  inputSchema: { type: "object", properties: { kind: { type: "string", enum: ["claude", "gpt", "gemini", "grok"] }, refresh: { type: "boolean" } }, additionalProperties: false },
};
const DISCUSSION_INPUT = {
  type: "object", description: "관련 쟁점을 작업자끼리 직접 토의할 그룹. to는 진행자, peers는 의견을 주고받을 다른 작업자 닉네임입니다. opinion 또는 writing 전용이며 진행자는 각 참여자의 실제 응답을 취합해야 합니다.",
  properties: { topic: { type: "string" }, peers: { type: "array", items: { type: "string" }, minItems: 1, uniqueItems: true } },
  required: ["topic", "peers"], additionalProperties: false,
};

const ROUTE_TOOL: ToolDef = {
  name: "route_request",
  description: "사용자 지시마다 첫 단계로 처리 방식을 기록합니다. direct=간단한 답변·사전 확인만, delegated=본 작업 위임. delegated에는 일을 먼저 나눠 본 결과를 split(single=일 하나, parallel=서로 독립인 일이 둘 이상, sequential=앞 결과가 다음 일의 입력)으로 적으세요. 중요한 버그 수정·오류 분석은 delegated와 dualInvestigation=true로 기록하고 reason에 중요도를 판단한 이유를 적으세요. 팀의 모델·도구·사용량을 반환합니다. 위임은 앱 spawn/ask만 사용하세요.",
  inputSchema: { type: "object", properties: { mode: { type: "string", enum: ["direct", "delegated"] }, reason: { type: "string" }, dualInvestigation: { type: "boolean", description: "중요한 버그·오류를 클로드와 지피티 양쪽이 독립 조사해야 하면 true. 수정 전 두 계열의 opinion 결과가 필요합니다." }, split: { type: "string", enum: ["single", "parallel", "sequential"], description: "delegated일 때 작업 분류. parallel이면 첫 배정은 ask_parallel 한 번이어야 합니다." } }, required: ["mode", "reason"], additionalProperties: false },
};

const EXPRESSION_TOOL: ToolDef = {
  name: "set_expression",
  description: "다음 대사의 감정에 맞는 얼굴 표정을 지정합니다. 본문은 그대로 쓰고 대사 전 한 번만 호출하세요. 사실 판단이나 작업 성공 여부를 바꾸지 않습니다.",
  inputSchema: { type: "object", properties: { expression: { type: "string", enum: [...AGENT_EXPRESSIONS] } }, required: ["expression"], additionalProperties: false },
};

// ---------- tool definitions
const PLAN_TASK_INPUT = { type: "string", description: "승인된 계획을 실행할 때 이 배정이 맡는 계획 작업 id. 앱이 단계 상태와 협의 id를 자동으로 갱신합니다." };
const scopeText = (folder?: string) =>
  `scope: 모든 작업 종류에서 고쳐도 되는 경로 glob 목록. 기준은 작업 폴더${folder ? `(${folder})` : ""}이며 그 안의 상대경로로 적습니다(예: ["src/ui/**", "README.md"]). 하위 저장소의 파일이면 그 폴더 이름부터 적습니다. 기존 파일·폴더와 하나도 맞지 않는 glob은 배정 결과에 경고하니, 새로 만들 경로가 아니면 amend_scope로 고치세요. 범위가 겹치지 않는 변경은 동시에 진행되고, 범위 밖 쓰기는 거부됩니다. `;
const ASK_TOOL = (forMaster: boolean, folder?: string): ToolDef => ({
  name: "ask",
  description:
    "작업자에게 닉네임으로 일을 맡기거나 질문하고 결과를 기다립니다 (예: to=\"클로드 2호\"). 받는 쪽은 이 대화를 보지 못하므로 message에 목표, 관련 파일, 조건, 완료 기준을 모두 적으세요. " +
    "kind: implement=구현·수정(받는 작업자가 파일을 고침, scope로 고칠 범위를 지정), review=기술 리뷰, opinion=의견·분석, writing=문장 다듬기·캐릭터 대사·문서 본문 등 글쓰기. 모든 작업 종류에서 필요한 파일 수정·명령 실행은 승인과 scope를 따릅니다. 사용자가 담당을 명시하면 그 작업자에게 지정한 종류 그대로 맡깁니다. " +
    scopeText(folder) +
    (forMaster ? "ask는 일 하나를 맡기고 결과를 기다립니다. 서로 독립적인 일이 둘 이상이면 ask를 여러 번 부르지 말고 ask_parallel 한 번으로 맡기세요. 관련 쟁점을 묶어 토의하려면 discussion={topic, peers}를 지정해 CLI 진행자에게 맡기세요. 진행자가 참여자에게 직접 ask로 묻고 결과를 취합합니다." :"토의 진행자로 지정되면 참여 작업자에게 직접 ask하고 합의·이견·근거를 취합하세요. 마스터에게는 ask를 쓰지 말고 결과 보고에 질문을 포함하세요."),
  inputSchema: {
    type: "object",
    properties: {
      to: { type: "string", description: "받는 작업자 닉네임 (예: 클로드 1호, 지피티 2호)" },
      message: { type: "string" },
      kind: { type: "string", enum: KINDS },
      reason: { type: "string", description: "이 작업자를 선택한 이유. 마스터 배정 시 필수." },
      effort: { type: "string", description: "작업 난도·비용·속도에 맞춰 모델이 실제 지원하는 추론 수준을 선택합니다. 생략하면 기존 배정 또는 모델 기본값입니다." },
      model: { type: "string", description: "선택 사항. route_request의 availableModels에서 담당 계열의 모델 ID를 선택합니다. 생략하면 프로젝트/채팅 모델을 유지합니다." },
      discussion: DISCUSSION_INPUT,
      ...(forMaster ? { accountId: CLI_ACCOUNT_INPUT, clearAccountId: CLEAR_CLI_ACCOUNT_INPUT } : {}),
      ...(forMaster ? { summary: { type: "boolean", description: "단일 작업의 결과를 바로 확인하거나 취합 결과를 받을 때 true. 협의 상태와 약 400자의 결론, 주요 산출물을 반환합니다. 생략하면 ID와 상태만 반환합니다." }, planTaskId: PLAN_TASK_INPUT, sequentialReason: { type: "string", description: "같은 group에 시작 가능한 계획 작업이 여럿인데 가용 작업자가 부족해 하나씩 맡겨야 할 때 그 이유. 적으면 단일 ask를 허용합니다." } } : {}),
      requiresImage: { type: "boolean", description: "실제 이미지 생성·편집 도구가 필요한 작업이면 true" },
      supersedes: { type: "integer", description: "이 배정으로 보완할 실패한 협의 id" },
      scope: { type: "array", items: { type: "string" } },
      ...(forMaster ? { attach: { type: "array", items: { type: "string" }, description: "함께 보낼 파일 절대경로 (사용자 첨부 이미지 등)" } } : {}),
    },
    required: ["to", "message", "kind", ...(forMaster ? ["reason"] : [])],
  },
});
const ASK_PARALLEL_TOOL = (forMaster: boolean, folder?: string): ToolDef => ({
  name: "ask_parallel",
  description:
    "서로 독립적인 일을 여러 작업자에게 동시에 맡기고 모두 끝날 때까지 기다립니다. " +
    (forMaster ? "마스터가 coordinator를 생략하면 별도 취합 없이 각 담당자의 짧은 결과와 실패 사유를 바로 받습니다(reportsOnly 기본). 결과를 서로 대조·통합해야 할 때만 coordinator를 지정하세요. " : "coordinator를 생략하면 성공한 첫 담당자가 결과를 취합합니다. ") +
    "tasks 항목은 ask와 같습니다(to, message, kind, scope). 구현을 나눠 맡길 때는 scope를 서로 겹치지 않게 주세요. 서로 다른 구현 결과의 리뷰도 한 번에 병렬로 맡길 수 있습니다. 앞 결과가 다음 일의 입력일 때만 차례로 맡기세요. " + scopeText(folder),
  inputSchema: {
    type: "object",
    properties: {
      coordinator: { type: "string", description: "결과 취합을 맡을 tasks 안의 작업자 닉네임. 결과를 대조·통합해야 할 때만 지정합니다." },
      reportsOnly: { type: "boolean", description: "마스터 전용. 별도 취합 없이 각 담당자의 짧은 결과와 실패 사유를 반환합니다. 마스터가 coordinator를 생략하면 기본 true이며 false로 두면 성공한 첫 담당자가 취합합니다. coordinator와 함께 지정할 수 없습니다." },
      tasks: {
        type: "array",
        items: {
          type: "object",
          properties: {
            to: { type: "string" },
            message: { type: "string" },
            kind: { type: "string", enum: KINDS },
            reason: { type: "string" },
            effort: { type: "string" },
            model: { type: "string" },
            requiresImage: { type: "boolean" },
            supersedes: { type: "integer" },
            attach: { type: "array", items: { type: "string" } },
            scope: { type: "array", items: { type: "string" } },
            discussion: DISCUSSION_INPUT,
            accountId: CLI_ACCOUNT_INPUT,
            clearAccountId: CLEAR_CLI_ACCOUNT_INPUT,
            ...(forMaster ? { planTaskId: PLAN_TASK_INPUT } : {}),
          },
          required: ["to", "message", "kind"],
        },
      },
    },
    required: ["tasks"],
  },
});

const SPAWN_TOOL: ToolDef = {
  name: "spawn",
  description:
    "해제된 같은 계열의 작업자를 낮은 번호부터 다시 활성화하며, 없을 때 새로 만듭니다. kind=claude → 클로드 N호(Claude Code), kind=gpt → 지피티 N호(Codex), kind=gemini → 제미나이 N호(Antigravity CLI), kind=grok → Grok N호, kind=deepseek → 딥시크 N호(API). 이전 번호·대화 기록을 유지합니다. job에 맡길 역할을 한 줄로 적으세요. 동시에 필요한 수만 확보하세요.",
  inputSchema: {
    type: "object",
    properties: { kind: { type: "string", enum: ["claude", "gpt", "gemini", "grok", "deepseek"] }, job: { type: "string" }, accountId: CLI_ACCOUNT_INPUT, clearAccountId: CLEAR_CLI_ACCOUNT_INPUT },
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
  description: "동료·마스터에게 보내거나 to=all로 그룹 채팅(사용자가 읽는 메인 대화)에 발언합니다. to=all은 실제 진행·질문·답변·막힘을 쉬운 한국어 1~3문장으로 씁니다. 공개 보고는 사용자가 이미 보므로 마스터가 재보고하지 않습니다. 마스터의 즉시 판단이 필요한 쟁점은 to=마스터로 직접 보내세요. 상세 자료는 협의 ID나 산출물 경로로 공유하고 담당 동료가 직접 조회합니다. 보낸 뒤 본 작업을 계속합니다. 작업 중인 직접 수신자에게 즉시 전달을 시도하며 다음 도구 호출에도 확인합니다. 동료의 답변이 필요하면 ask를 사용하세요.",
  inputSchema: { type: "object", properties: { to: { type: "string" }, message: { type: "string" } }, required: ["to", "message"], additionalProperties: false },
};
const MESSAGES_TOOL: ToolDef = {
  name: "read_messages", description: "나에게 온 새 협업 메시지를 확인합니다. 인터페이스 변경 전과 결과 보고 전에 확인하세요.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
};
const AGENTS_TOOL: ToolDef = {
  name: "agents",
  description: "이 채팅의 팀 목록과 현재 지시의 최근 협의 ID·상태를 조회합니다. 결과 본문은 read_consult로 필요한 협의만 확인하세요. ask 응답을 놓쳤어도 결과를 다시 받기 위해 재배정하지 마세요.",
  inputSchema: { type: "object", properties: {} },
};
const READ_CONSULT_TOOL: ToolDef = {
  name: "read_consult",
  description: "이 채팅에 저장된 협의 결과 원문·전체 파일 목록·구조화 리뷰를 조회합니다. 기본은 짧은 결과 요약이며 detail=true일 때만 원문을 페이지 단위로 반환합니다. 반환된 nextOffset으로 이어 읽으세요. 작업을 재실행하지 않습니다.",
  inputSchema: { type: "object", properties: {
    consultId: { type: "integer" }, detail: { type: "boolean" },
    offset: { type: "integer", minimum: 0 },
    limit: { type: "integer", minimum: 1, maximum: 8000, description: "원문 페이지의 최대 문자 수. 기본 4000." },
  }, required: ["consultId"], additionalProperties: false },
};
const CHECK_AGENT_TOOL: ToolDef = {
  name: "check_agent",
  description: "이미 맡긴 작업도 다시 점검합니다. 마지막 활동·실행 상태·대기 도구·오류·최근 결과를 확인하고 진행 상황 응답을 요청합니다. 기존 작업을 중복 배정하거나 중지하지 않습니다.",
  inputSchema: { type: "object", properties: { to: { type: "string" }, recover: { type: "boolean", description: "마스터만 사용. 무응답 작업의 기존 프로세스 종료를 확인한 뒤 실패로 정리합니다. 저장된 파일은 보존하며 supersedes로 이어 맡길 수 있습니다. priority(계정 우선 할당) 정책 작업자는 앱이 같은 작업을 다음 우선 계정으로 이어서 실행하므로 재배정하지 않습니다." } }, required: ["to"], additionalProperties: false },
};
const CHECKLIST_TOOL: ToolDef = {
  name: "checklist",
  description:
    "작업 체크리스트를 등록·갱신합니다 (화면 상단 카드). 전체 단계 목록을 매번 보내세요. owner에 담당 닉네임을 적으세요. 선행이 있는 단계에는 id를 붙이고 dependsOn에 선행 단계 id를 적으세요. 협의가 시작되면 consultIds에 협의 id를 연결하세요. 앱은 이 정보로 작업을 배정하거나 완료 처리하지 않으며 status는 직접 갱신합니다. status: pending | inProgress | completed | cancelled. 진행하지 않기로 한 단계는 목록에서 빼지 말고 cancelled와 cancelReason(사유)으로 남기세요. cancelled는 완료가 아니며 그 단계를 선행으로 둔 단계는 계속 막힙니다. pending·inProgress 단계가 남으면 앱은 지시를 완료로 처리하지 않습니다.",
  inputSchema: {
    type: "object",
    properties: {
      steps: {
        type: "array",
        items: {
          type: "object",
          properties: {
            title: { type: "string" },
            status: { type: "string", enum: ["pending", "inProgress", "completed", "cancelled"] },
            cancelReason: { type: "string", description: "status=cancelled일 때 진행하지 않는 이유" },
            id: { type: "string", description: "다른 단계가 선행으로 지정할 고유 id" },
            owner: { type: "string", description: "담당 닉네임 (예: 클로드 1호, 마스터)" },
            dependsOn: { type: "array", items: { type: "string" }, description: "먼저 완료되어야 하는 단계 id" },
            consultIds: { type: "array", items: { type: "integer" }, description: "이 단계와 연결된 협의 id" },
          },
          required: ["title", "status"],
        },
      },
    },
    required: ["steps"],
  },
};
const REPORT_REVIEW_TOOL: ToolDef = {
  name: "report_review",
  description: "지금 맡은 review 협의의 구조화 결과를 제출합니다. 협의는 앱이 정하며 자신의 실행 중인 리뷰에만 적용됩니다. 다시 호출하면 최신 결과로 바뀝니다. 실행하지 않은 테스트는 not_run으로, 판단 근거가 부족하면 inconclusive로 적으세요. 파일이나 patch를 적용하지 않습니다.",
  inputSchema: {
    type: "object",
    properties: {
      verdict: { type: "string", enum: ["pass", "changes_requested", "inconclusive"] },
      revision: { type: "string", description: "리뷰한 기준 (커밋 또는 작업 트리 설명)" },
      summary: { type: "string" },
      findings: { type: "array", items: { type: "object", properties: { severity: { type: "string", enum: ["high", "medium", "low"] }, message: { type: "string" }, path: { type: "string" }, line: { type: "integer" } }, required: ["severity", "message"], additionalProperties: false } },
      tests: { type: "array", items: { type: "object", properties: { name: { type: "string" }, status: { type: "string", enum: ["passed", "failed", "not_run"] }, detail: { type: "string" } }, required: ["name", "status"], additionalProperties: false } },
    },
    required: ["verdict", "revision", "summary", "findings", "tests"],
    additionalProperties: false,
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

const PROPOSE_PLAN_TOOL: ToolDef = {
  name: "propose_plan",
  description: "계획 모드 전용. 할 일을 모두 나눈 계획을 사용자 승인용으로 제출합니다. 작업마다 id, title, kind(implement|review|opinion|writing), agentKind(담당 계열), 선택 owner(기존 작업자 닉네임), scope(고칠 경로 glob, 작업 폴더 기준; 파일 변경이 없으면 []), group(병렬 묶음 번호, 1부터; 같은 group은 동시에 시작), dependsOn(앞 group의 선행 작업 id), done(완료 기준), 리뷰면 reviewOf(대상 작업 id)를 적습니다. 같은 group의 구현 scope는 겹치면 안 됩니다. 다시 호출하면 이번 제안을 최신 내용으로 바꿉니다. 제출한 뒤 계획을 짧게 요약하고 턴을 끝내면 사용자가 승인·수정 요청·취소를 고릅니다.",
  inputSchema: {
    type: "object",
    properties: {
      summary: { type: "string", description: "계획 요약과 사용자 답변으로 정한 결정" },
      tasks: {
        type: "array", minItems: 1,
        items: {
          type: "object",
          properties: {
            id: { type: "string" }, title: { type: "string" },
            kind: { type: "string", enum: KINDS },
            agentKind: { type: "string", enum: ["claude", "gpt", "gemini", "grok", "deepseek"] },
            owner: { type: "string", description: "이미 있는 작업자 닉네임(선택). 없으면 실행할 때 같은 계열로 확보합니다." },
            scope: { type: "array", items: { type: "string" } },
            group: { type: "integer", minimum: 1 },
            dependsOn: { type: "array", items: { type: "string" } },
            done: { type: "string", description: "완료 기준" },
            reviewOf: { type: "string" },
          },
          required: ["id", "title", "kind", "agentKind", "scope", "group", "done"],
        },
      },
    },
    required: ["summary", "tasks"],
  },
};
const WAIT_RESULTS_TOOL: ToolDef = {
  name: "wait_results",
  description: "이미 맡긴 협의가 끝날 때까지 기다립니다. sleep이나 agents 반복 조회 대신 사용하세요. consultIds를 생략하면 이번 지시에서 실행 중인 모든 협의를 기다립니다. 사용자 즉시 요청·동료의 직접 메시지·상태 점검이 오거나, 사용자 승인·질문 답을 기다리는 중이거나, 제한 시간(timeoutSec, 기본 300초·최대 1800초)이 지나면 그때까지의 상태와 미완료 목록을 반환하니 처리한 뒤 다시 호출하세요. 새 작업을 배정하지 않습니다.",
  inputSchema: { type: "object", properties: { consultIds: { type: "array", items: { type: "integer" } }, timeoutSec: { type: "integer", minimum: 1, maximum: 1800 } }, additionalProperties: false },
};
const WAIT_DEFAULT_SEC = 300;
const WAIT_MAX_SEC = 1800;
const AMEND_SCOPE_TOOL: ToolDef = {
  name: "amend_scope",
  description: "실행 중인 작업자의 파일 범위(scope)를 정정합니다(예: 기준 폴더를 잘못 적은 경우). 다른 실행 중인 작업이 잡은 범위와 겹치면 거절합니다. 앱이 작업자에게 바뀐 범위를 알립니다. 범위 기준은 작업 폴더입니다.",
  inputSchema: { type: "object", properties: { to: { type: "string", description: "작업 중인 작업자 닉네임" }, scope: { type: "array", items: { type: "string" }, minItems: 1 }, reason: { type: "string" } }, required: ["to", "scope", "reason"], additionalProperties: false },
};

const EXTEND_PLAN_SCOPE_TOOL: ToolDef = {
  name: "extend_plan_scope",
  description: "승인된 계획을 실행하는 중에, 계획의 승인 범위 밖 파일을 고쳐야 할 때 사용자에게 범위 확대 승인을 요청합니다. 앱이 사용자에게 직접 [허용]/[거부]를 묻고, 허용된 범위만 기록해 이후 배정·amend_scope에 허용합니다. 결과가 거부면 범위를 넓히지 말고 계획 범위 안에서 진행하거나 사용자에게 보고하세요.",
  inputSchema: { type: "object", properties: { scope: { type: "array", items: { type: "string" }, minItems: 1, description: "추가로 허용받을 경로 glob(작업 폴더 기준)" }, reason: { type: "string", description: "왜 필요한지 사용자에게 보여 줄 설명" } }, required: ["scope", "reason"], additionalProperties: false },
};

/** Master tools refused while planning: in plan mode the master works alone and read-only. */
const PLANNING_BLOCKED = new Set(["spawn", "ask", "ask_parallel", "release", "update_goal", "council_consult", "amend_scope", "wait_results", "extend_plan_scope"]);

/**
 * Warning for a scope glob that matches no existing path relative to the folder (a new folder or file is
 * still allowed: this never refuses an assignment). Suggests the prefix when the glob exists under exactly
 * one subfolder, as when the folder is the parent of a repository. null when the glob looks right.
 */
export function scopeIssue(folder: string, glob: string): string | null {
  const g = glob.trim().replace(/\\/g, "/");
  if (!g) return "빈 glob입니다.";
  if (isAbsolute(g) || /^[A-Za-z]:\//.test(g)) {
    const rel = relative(folder, g).replace(/\\/g, "/");
    return rel.startsWith("..") || isAbsolute(rel) ? `기준 폴더 = ${folder} 밖의 경로라 쓰기가 거절됩니다.` : `기준 폴더 = ${folder}. 절대경로 대신 상대경로("${rel}")로 적으세요.`;
  }
  const wild = g.search(/[*?[{]/);
  const head = wild < 0 ? g : g.slice(0, wild);
  const base = (wild < 0 ? head : head.slice(0, head.lastIndexOf("/") + 1)).replace(/\/+$/, "");
  const abs = resolvePath(folder, base || ".");
  const rel = relative(folder, abs);
  if (rel.startsWith("..") || isAbsolute(rel)) return `기준 폴더 = ${folder} 밖의 경로라 쓰기가 거절됩니다.`;
  // A plain path may name a new file in an existing folder.
  if (existsSync(abs) || (wild < 0 && existsSync(resolvePath(abs, "..")))) return null;
  let prefix = "";
  try {
    const subs = readdirSync(folder, { withFileTypes: true }).filter(d => d.isDirectory() && existsSync(resolvePath(folder, d.name, base))).map(d => d.name);
    if (subs.length === 1) prefix = subs[0];
  } catch { /* the suggestion is optional */ }
  return `기준 폴더 = ${folder}, 일치하는 기존 경로 없음.${prefix ? ` 하위 저장소라면 "${prefix}/${g}" 형태인지 확인하세요.` : " 새로 만들 경로가 아니라면 하위 폴더 접두사가 빠졌는지 확인하세요."}`;
}

/** Scope warnings of one assignment, one line per glob. */
function scopeWarnings(folder: string | undefined, scope: unknown): string[] {
  if (!folder || !Array.isArray(scope)) return [];
  return scope.map(String).filter(Boolean).flatMap((g) => { const issue = scopeIssue(folder, g); return issue ? [`scope "${g}": ${issue}`] : []; });
}
const SCOPE_WARNING_HELP = "배정은 그대로 진행했습니다. 범위가 틀렸다면 재배정하지 말고 amend_scope(to, scope, reason)로 고치세요.";

interface PlanRevision { planId: number; version: number; steps: PlanStep[] }

/** The proposal still waiting for approval just before a new user message (that message revises it). */
function waitingProposal(before: readonly TimelineEvent[]): PlanRevision | undefined {
  const index = before.findLastIndex((e) => e.event.type === "plan_state");
  const state = before[index]?.event;
  if (state?.type !== "plan_state" || state.state !== "proposed" || state.planId === undefined) return undefined;
  if (before.slice(index + 1).some((e) => e.event.type === "user" && !e.event.queued)) return undefined;
  const steps = planStepsFor(before, state.planId) ?? [];
  return { planId: state.planId, version: state.version ?? 1, steps };
}

function planTaskLine(s: PlanStep): string {
  return `- ${s.id ?? "?"} ${s.title} [${s.kind ?? "?"} · ${s.agentKind ?? "?"}${s.owner ? ` · ${s.owner}` : ""} · scope ${s.scope?.length ? s.scope.join(", ") : "없음"}]` +
    `${s.dependsOn?.length ? ` · 선행 ${s.dependsOn.join(", ")}` : ""}${s.reviewOf ? ` · 리뷰 대상 ${s.reviewOf}` : ""}${s.done ? ` · 완료 기준: ${s.done}` : ""}${s.status !== "pending" ? ` (${s.status})` : ""}`;
}

/** Version recorded with the plan's latest proposal, if any. */
function latestPlanVersion(events: readonly TimelineEvent[], planId: number): number | undefined {
  const e = events.findLast((x) => x.event.type === "plan_state" && x.event.planId === planId && x.event.state === "proposed");
  return e?.event.type === "plan_state" ? e.event.version : undefined;
}

function planByGroup(steps: readonly PlanStep[]): string {
  const groups = [...new Set(steps.map((s) => s.group ?? 0))].sort((a, b) => a - b);
  return groups.map((g) => `${g ? `group ${g}` : "group 미지정"}:\n${steps.filter((s) => (s.group ?? 0) === g).map(planTaskLine).join("\n")}`).join("\n");
}

/** The planning turn's instruction: read-only, questions through ask_user, one propose_plan. */
function planPrompt(request: string, revision?: PlanRevision): string {
  return [
    `[계획 모드] 읽기 전용${revision ? ` · 계획 v${revision.version} 수정` : ""}`,
    "아래 요청의 실행 계획만 세운다. 작업자를 만들거나 맡기지 않고(spawn·ask·ask_parallel 금지), 파일을 바꾸거나 변경 명령을 실행하지 않는다.",
    "1) 필요한 만큼 코드·문서를 직접 읽어 현재 상태를 파악한다(council_explore 사용 가능).",
    "2) 범위·우선순위·방식처럼 사용자만 정할 수 있는 결정은 ask_user로 하나씩 묻는다(선택지는 options로). 사소한 것은 스스로 정한다.",
    "3) 할 일을 빠짐없이 작업으로 나누고, 작업마다 담당 계열(agentKind)·종류(kind)·고칠 범위(scope, 작업 폴더 기준)·병렬 묶음(group)·선행(dependsOn)·완료 기준(done)을 정한다. 서로 독립인 작업은 같은 group에 넣어 동시에 진행되게 하고, 같은 group의 구현 scope는 겹치지 않게 한다. 코드 변경에는 만들지 않은 작업자의 리뷰 작업(kind=review, reviewOf)을 뒤 group에 둔다.",
    "4) propose_plan(summary, tasks)으로 제출하고 사용자에게 두세 문장으로 요약한 뒤 턴을 끝낸다. 사용자가 승인하면 실행 단계에서 배정한다. TodoWrite·update_plan·checklist는 쓰지 않는다.",
    ...(revision ? ["", `[이전 제안 v${revision.version}]`, revision.steps.length ? planByGroup(revision.steps) : "(작업 없음)", `아래 수정 요청을 반영해 계획 v${revision.version + 1}을 propose_plan으로 다시 제출한다.`] : []),
    "",
    revision ? "수정 요청:" : "요청:",
    request,
  ].join("\n");
}

function masterInstructions(project: Project, agent: AgentKind): string {
  const s = project.settings;
  const t = (n: string) => (agent === "claude" ? `mcp__chatterbox_bridge__${n}` : n);
  return [
    "# 역할: AI_ChatterBox 마스터",
    `너는 사용자의 지시를 받아 팀을 꾸리고 일을 나눠 맡기는 마스터다. 작업 폴더: ${project.folder}`,
    `- 좁은 판단에 별도 시각이 꼭 필요하면 ${t("council_consult")}에 질문과 필요한 문맥만 준다. 파일 위치·짧은 근거 탐색은 ${t("council_explore")}의 search/grep/docs를 사용한다. 단순 답변에는 호출하지 않는다. 두 도구는 파일 수정·명령 실행·하위 위임 없이 제한된 결과만 반환한다. 구현, 독립 조사, 코드 리뷰나 완료 검증을 대신하지 않으며 기존 spawn/ask·교차 리뷰 요건을 그대로 지킨다. Gemini 자문은 purpose=writing인 글쓰기만 지정한다.`,
    "- 너는 배정·방침 결정·최종 보고 담당이다. 간단한 질문·짧은 설명·이미 주어진 정보만으로 답할 수 있는 확인은 direct로 기록한 뒤 작업자를 생성하거나 호출하지 않고 직접 답한다. 상세 원인 조사·구현·이미지·문서 제작 등 본 작업은 앱 작업자에게 맡긴다. 결과에 누락·모순이 있으면 담당자에게 보완을 요청하고 통합 결론을 받아 최종 답변한다. 사용자가 명시적으로 직접 수행을 요구한 예외에도 기존 승인·작업 범위 규칙을 지킨다.",
    "- 마스터는 목표·범위·완료 기준을 전달하고 결론을 정리한다. 배정 전에 할 일을 먼저 나눈다: 서로 독립인 일(파일 범위가 다른 구현, 다른 관점의 조사, 서로 다른 구현 결과의 리뷰)은 한 번의 ask_parallel로 동시에 맡기고, 앞 결과가 다음 일의 입력인 일만 차례로 맡긴다. 정말 일 하나뿐일 때만 ask(summary=true)를 쓴다. ask_parallel에서 coordinator를 생략하면 각 결과를 바로 받는다. 여러 근거를 대조하거나 이견을 해결해야 할 때만 coordinator를 지정한다. 상세 검증은 담당자와 비작성자 리뷰어가 수행한다. 근거가 부족하면 담당자에게 좁게 확인하고, 필요한 경우 read_consult(detail=true)로 원문을 조회한다.",
    `- 지시마다 먼저 ${t("route_request")}(mode=direct|delegated, reason=이유)를 호출한다. delegated이면 나눈 결과를 split=single|parallel|sequential로 함께 적는다(parallel이면 첫 배정은 ask_parallel 한 번). 반환되는 실제 사용 가능 도구·모델·사용량으로 후보를 확인한다. 도구 사용 불가/미확인은 가능하다고 가정하지 않는다.`,
    `- 맡긴 결과를 기다릴 때는 sleep·agents 반복 조회 대신 ${t("wait_results")}를 호출한다. 사용자 요청·동료 메시지·상태 점검으로 대기가 먼저 풀리면 그것을 처리한 뒤 다시 ${t("wait_results")}로 기다린다. 실행 중인 작업의 범위를 잘못 줬으면 재배정하지 말고 ${t("amend_scope")}로 정정한다. 승인된 계획을 실행하는 동안의 배정·정정은 계획의 승인 범위 안에서만 가능하며, 넓혀야 하면 ${t("extend_plan_scope")}로 사용자 승인을 받는다.`,
    `- 계획 모드([계획 모드] 지시)에서는 작업자를 만들거나 맡기지 않고 파일도 바꾸지 않는다. 직접 읽기 전용으로 코드를 살피고, 꼭 필요한 결정은 ${t("ask_user")}로 물은 뒤, 할 일 전체를 나눠 ${t("propose_plan")}으로 제출한다. TodoWrite·update_plan 같은 CLI 자체 계획 도구는 쓰지 않는다.`,
    "- 모든 위임은 이 앱의 chatterbox_bridge spawn/ask/ask_parallel만 사용한다. CLI 내부 spawn_agent/Agent/Task/팀 도구나 별도 CLI 프로세스로 작업자를 만들지 않는다. 앱 상단 모델을 기본으로 사용하며 배정마다 availableModels에 있는 담당 계열 모델을 model로 선택할 수 있다. 사용자가 담당 모델을 명시한 요청은 우선한다.",
    "- 작업자·역할·순서·병렬 수·추론 수준은 매 배정의 난도, 실제 도구, 비용, 속도, 사용량에 맞게 선정한다. 선호 역할은 참고이며 특정 업무를 특정 계열에 강제하지 않는다. effort는 route_request의 실제 지원 범위 전체에서 고르고 생략하면 기존 배정/모델 기본값을 쓴다. 동료도 질문마다 별도 effort를 선택할 수 있다. 사용자가 명시한 담당·수동 설정은 우선한다.",
    `- 클로드 선호 작업: ${s.claudeStrengths}\n  주의점: ${s.claudeCautions}`,
    `- 지피티 선호 작업: ${s.gptStrengths}\n  주의점: ${s.gptCautions}`,
    `- Grok 선호 작업: ${s.grokStrengths} 주의점: ${s.grokCautions}`,
    `- DeepSeek 선호 작업: ${s.deepseekStrengths} 주의점: ${s.deepseekCautions}`,
    "- 사용자가 이름·봇·CLI를 명시한 작업은 그 담당에게 우선 배정한다. 글쓰기·코드·이미지의 기본 선호는 명시적 지정을 덮어쓰지 않는다. Gemini는 Antigravity CLI로 실행한다. 다른 봇으로 임의 변경하지 말고 실제 도구 오류와 한도를 보고한다.",
    `- 제미나이 선호 작업: ${s.geminiStrengths}\n  주의점: ${s.geminiCautions}` ,
    "- 글쓰기·코딩·조사·리뷰 모두 실제 역량과 맥락에 맞는 동료를 선택한다. 문서에는 독자·목적·분량·말투·확인된 사실을 전달하고, 기술적 사실과 실제 파일 반영은 검증한다. 실패하면 기존 결과를 보존하고 가용 동료에게 이어 맡긴다.",
    "- Claude/Codex/Antigravity/Grok CLI 계정 정책은 프로젝트 accountPolicy > 전역 cliAccountPolicy > 기본 fixed/*-1 순이다. 프로젝트·전역 fixed 정책에서는 정책 계정이 최우선이며, 저장된 작업자 지정도 이를 덮어쓰지 못한다. 다른 accountId 지정은 거부되므로 정책 변경을 사용자에게 요청한다. auto 또는 기본(default) 정책에서만 명시·저장된 accountId를 우선 적용한다. clearAccountId=true는 저장된 지정을 해제하고 정책을 따르며 release도 지정을 해제한다. 결과의 정책과 출처를 확인한다.",
    "- auto에서는 마스터가 cli_accounts로 로그인·enabled·실행 중 작업자·remainingPercent·checkedAt를 직접 확인한다. 잔여량이 10%를 초과하는 계정 중 실행 중 작업자가 없는 계정을 우선하고 잔여량이 가장 많은 계정을 accountId로 지정한다. 대기 계정이 없으면 잔여량 10% 초과 계정을 여러 작업자가 공유할 수 있다. 미조회·10분 초과·미확인 잔여량은 사용 가능으로 추정하지 않는다. 적합한 계정이 없으면 갱신하거나 사용자에게 알린다.",
    "- fixed·auto에서 앱은 CLI 한도 소진 시 자동 계정 전환이나 작업 재시도를 하지 않는다. fixed는 실패를 보고한다. auto는 마스터가 cli_accounts로 다시 확인하고 실패 협의 id를 supersedes에 넣어 다른 계정으로 재배정한다. 계정 변경은 새 세션과 요약 인계로 처리한다. auto에서 accountId를 생략하면 기존 지정 계정을 유지하고, 지정이 없으면 정책 계정(없으면 *-1)을 사용한다. 앱이 잔여량으로 대신 선택하지 않는다.",
    "- priority(계정 우선 할당)에서는 앱이 사용자가 정한 우선 순서의 첫 사용 가능 계정으로 배정한다(배정 제외·로그아웃 확인·잔여 0% 확인·최근 실패 계정은 건너뛰고 미확인 잔여량은 시도). 한도 소진·인증 실패·무응답으로 실패하면 앱이 같은 협의를 다음 계정의 새 세션과 요약 인계로 자동 이어서 실행하고, 모두 실패하면 실패를 보고한다. 이 경우 마스터는 같은 작업을 재배정하지 않는다. 첫 계정이 회복되면 다음 새 배정부터 다시 첫 계정을 쓰며 진행 중 작업은 바꾸지 않는다. 명시·저장된 accountId는 먼저 사용하고 실패하면 우선 순서로 넘어간다. 협의 결과의 '우선 할당' 줄과 실제 실행 계정을 확인해 보고한다.",
    "- 작업자 번호를 CLI 계정 번호로 추정하지 않는다. spawn/ask/ask_parallel의 accountId로 계정을 명시한다. 실행 계정은 앱 기록에 남으며, 계정 문제가 있거나 사용자가 물었을 때만 확인해 보고한다.",
    "- 기술 업무도 모델별 고정 역할 없이 필요한 구현·분석·검증 능력과 실제 가용성을 비교해 맡긴다. 중요한 오류의 독립 검증이 필요하면 dualInvestigation을 선택한다.",
    "- 위 기준은 기본 선호이며 절대적인 우열이 아니다. 필요한 도구 사용 가능 여부를 먼저 확인하고, 사용자가 지정한 담당·선호 기준·관련 맥락·작업량·사용 한도를 고려한다. 필요 없는 계열을 형식적으로 부르지는 않지만, 독립 작업이 여럿이면 인원을 늘려 병렬로 진행한다. 실패하면 원인을 반영해 재배정하고 가능한 담당자가 없으면 미완료 사유를 알린다.",
    "- 시각 작업도 구분한다. 이미지 생성·편집은 지정이 없을 때 이미지 도구가 있는 Codex에게, 명시적으로 Gemini/Grok 등 다른 작업자를 지정하면 그 작업자에게 requiresImage=true로 배정한다. 제공된 이미지 도구의 실제 결과만 완료로 인정한다. 그 밖의 모션그래픽·애니메이션은 실제 도구와 맥락에 맞는 동료가 제작하고 필요한 이미지 소재도 도구 가용성에 따라 협의한다.",
    `- 중요한 버그 수정·오류 분석이라고 판단하면 ${t("route_request")}(mode=delegated, dualInvestigation=true, reason=중요도 판단 근거)를 기록한다. 예: 데이터 손실·보안·설비 안전·서비스 중단에 영향이 크거나, 반복 장애의 원인이 불확실하고 잘못 고쳤을 때 피해가 큰 경우. 사용자에게 양쪽 조사를 명시적으로 요청받은 경우도 적용한다. 단순 문구·서식 수정이나 일반 질문에 모두 호출하지 않는다.`,
    `- 양쪽 조사: 클로드와 지피티에게 동일한 문제·증상·소스·로그·완료 기준을 주고 ${t("ask_parallel")}(각 kind=opinion)로 독립 조사시킨다. 다른 쪽 결론을 먼저 전달하거나 파일 수정을 맡기지 않는다. 각각 원인 후보·근거(파일/로그)·재현 방법·수정안·불확실성을 기록하게 한다. 두 조사가 끝난 뒤 취합 담당 작업자가 공통점·차이와 충돌하는 근거를 동료와 확인하고 통합 결론을 낸다. 마스터는 그 결론으로 수정 방침을 정해 구현을 배정하며 교차 리뷰 규칙을 유지한다. 한쪽을 실행할 수 없으면 양쪽 조사를 완료했다고 하지 말고 제한과 확인된 결과를 보고한다.`,
    `- 팀: ${t("spawn")}(kind=claude|gpt|gemini|grok|deepseek)로 작업자를 만든다. 기존 동료를 우선 재사용하고 필요한 인원과 병렬 수를 상황에 맞게 선택한다. 설정 인원은 권장 규모이며 초과해도 차단되지 않는다. 0으로 비활성화한 계열은 사용하지 않는다. 다 쓴 동료는 ${t("release")}로 해제한다.`,
    "- 각 작업의 목표·담당·파일 범위·입출력 계약·완료 기준을 정해 배정한다. 독립 파트는 ask_parallel로 맡기고, 결과를 서로 대조해야 하면 coordinator를 지정한다. 작업자들은 필요한 쟁점을 직접 협의한다. 구현과 리뷰처럼 순서가 있는 일은 직전 결과를 다음 담당자에게 넘기되, 한 구현의 리뷰와 그와 무관한 다른 구현은 같은 ask_parallel로 묶어 동시에 진행한다. 남은 이견이나 누락이 있을 때 보완을 맡긴다.",
    "- send_message(to=all)는 사용자가 읽는 메인 대화다. 결정·질문·답변·막힘처럼 실제로 할 말이 있을 때만 쉬운 한국어 1~3문장으로 말한다. 상세 근거·로그는 해당 협의 기록이나 산출물에 남긴다. 마스터 대화에는 결과·남은 문제·링크만 짧게 정리하고 작업자 보고서나 계정 진단을 반복 출력하지 않는다. 상태 확인용 반복 발언이나 형식적인 대사는 만들지 않는다.",
    "- 작업자가 메인 채팅에 직접 보고한 진행·결과는 사용자가 이미 읽었다. 같은 내용을 바꿔 말하거나 요약·확인 응답으로 재보고하지 않는다. 새 결정·방침 변경, 사용자 질문에 대한 답변, 작업자 간 미해결 충돌, 전체 작업의 최종 결론이 있을 때만 발언한다. 새 내용이 없으면 공개 응답 없이 다음 배정·검증을 계속한다. 최종 보고도 이미 공개된 항목을 나열하지 말고 전체 완료 여부·새로 확인한 결론·남은 조치만 한 번 전달한다. 사용자가 다시 설명하거나 요약해 달라고 요청하면 답한다.",
    `- 일 맡기기: ${t("ask")}(to=닉네임, kind, message, scope). 서로 독립적인 일은 반드시 ${t("ask_parallel")}(tasks=[…])로 한 번에 맡겨 동시에 진행한다(하나씩 기다리지 말 것). 파일을 변경할 작업은 종류와 관계없이 scope를 겹치지 않게 나눈다. 읽기·토의는 동시에 가능하며, 리뷰·의견에서 수정할 때도 범위와 승인을 따른다.`,
    `- 관련 쟁점·서로 맞물린 설계·문장과 연출 등 직접 논의가 필요한 항목은 주제별 토의 그룹으로 묶는다. ${t("ask")}(to=클로드/지피티 진행자, kind=opinion|writing, discussion={topic:주제, peers:[참여 닉네임]}, message=목표·공통 자료·쟁점·완료 기준, reason, effort)로 맡긴다. 진행자가 참여자에게 직접 ask로 초안과 근거를 주고받아 합의·이견·남은 확인을 정리하고, 너는 그룹별 결과와 필요한 최종 결정만 취합한다. 사소한 확인까지 매번 중계하지 않는다.`,
    "- 토의 중 필요한 파일 수정·명령 실행도 지정 범위와 승인을 따른다. 주제와 사용자의 지정을 따라 Claude·Codex·Gemini·Grok에서 진행자와 참여자를 정한다. 참여자는 토의 시점에 대기 상태로 두고 다른 병렬 작업·토의 그룹에 중복 배정하지 않는다. 중요한 오류는 먼저 양쪽 독립 조사 결과를 확보한 뒤 토의 그룹에서 대조한다. 토의 결과를 교차 리뷰로 대신하지 않는다. 실제 참여 응답이 없으면 토의 완료로 보고하지 말고 보완하거나 미완료 사유를 알린다.",
    s.reviewGate
      ? "- 너 자신 또는 작업자가 코드를 바꾸면 끝내기 전에, 그 코드를 만들지 않은 작업자에게 리뷰를 맡긴다 (kind=review). 서로 다른 구현 결과의 리뷰는 ask_parallel 한 번으로 동시에 맡긴다. 일반 변경의 리뷰는 다른 클로드 작업자도 가능하다. 중요한 오류·보안·안전 등 다른 계열 관점이 꼭 필요한 경우 지피티로 교차검증한다. 네가 직접 바꾼 파일도 빠짐없이 넘긴다. 지적이 나오면 고치고 다시 리뷰받는다."
      : "- 리뷰는 필요하다고 판단할 때만 맡긴다 (kind=review).",
    "- ask/ask_parallel의 각 배정에 reason(선택 이유)을 넣는다. 이미지 생성·편집은 requiresImage=true, kind=implement로 요청한다. 기본은 Codex이며 사용자가 다른 작업자를 지정하면 그 지정을 우선한다. 배정 내용에는 목표, 제약, 산출물, 완료 기준을 포함한다.",
    "- 작업자는 이 대화를 보지 못한다. message에 목표, 관련 파일 경로, 제약, 완료 기준을 빠짐없이 적는다. 사용자가 첨부한 파일이 필요하면 attach로 경로를 넘긴다.",
    `- 작업 중 사용자의 즉시 추가 지시를 받으면 기존 작업자를 유지한다. CLI가 ask 응답 수신을 중단해도 작업자는 계속 실행될 수 있다. ${t("agents")}로 상태와 저장된 최근 결과를 확인하고, 이미 완료한 작업을 응답 재수신만을 위해 다시 배정하지 않는다.`,
    "- 즉시 추가 질문·수정 요청에는 작업자의 완료를 기다리지 말고 먼저 사용자에게 한국어로 직접 답한다. 이미 아는 내용은 바로 설명하고 수정 요청은 이해한 내용과 반영 방법을 먼저 말한다. 기존 지시의 위임·교차 검증 요건은 그대로 유지하며, 추가 질문에 답하려고 기존 지시를 direct로 변경하지 않는다. 답변하기 전에 작업 배정이나 체크리스트 갱신으로 넘어가지 않는다.",
    `- 여러 단계 작업은 ${t("checklist")}로 현재 작업만의 짧은 계획과 담당(owner에 닉네임)을 등록한다. 새 지시로 새 작업을 시작할 때 이전 작업의 완료·취소 단계들을 이어 붙이지 말고 새로 정리한다. 선행 관계는 id·dependsOn으로, 배정한 협의는 consultIds로 연결하고 작업자 간 취합·검증 단계를 포함한다. 같은 작업의 추가 지시에는 현재 계획을 갱신한다.`,
    `- 채팅에 목표(/goal)가 있으면 그 목표를 향해 일하고, 한 단계를 마칠 때마다 ${t("update_goal")}로 진행을 보고한다. 다 이루면 status=complete.`,
    `- 꼭 필요한 결정만 ${t("ask_user")}로 묻는다.`,
    `- 사용자에게 대사를 쓰기 전에 ${t("set_expression")}(expression=감정)으로 표정을 지정한다. 감정: ${AGENT_EXPRESSIONS.join(", ")}. 기술적 내용과 말투를 억지로 바꾸지 않는다.`,
    "- 지시·협의의 시간·배정·리뷰 횟수에는 강제 한도를 두지 않는다. 설정 숫자는 계획 참고값이다. 같은 요청 반복, 순환 대기, 충돌을 피하고 새로운 근거가 없으면 질문을 바꾸거나 사용자에게 필요한 결정을 알린다. 사용자가 중지를 요청하면 즉시 멈춘다.",
    "- 마지막에는 항상 한국어로 전체 결론, 산출물 링크, 검증 요약, 남은 문제를 짧게 보고한다. 담당별 보고서를 반복하지 않는다. 돌아오지 않았거나 실패한 결과를 완료했다고 말하지 않는다. 배정·분석만 끝났고 구현·시험·리뷰가 남았다면 지금 이어서 수행하고 checklist를 갱신한다. '결과가 오면 리뷰하겠다' 같은 다음 행동의 예고로 턴을 끝내지 않는다. 생성 이미지 파일 경로도 최종 답변에 포함한다.",
    "- 사용자에게 결과물을 제공할 때마다 반드시 해당 파일별로 클릭할 수 있는 Markdown 링크 [파일명](<절대경로>)를 함께 쓴다. 이미지도 같은 링크와 미리보기를 함께 제공한다. :codex-file-citation 같은 내부 앱 전용 표기나 링크 없는 완료 문장으로 대체하지 않는다. 수정한 기존 PDF·문서·ZIP도 빠뜨리지 않고 각각 연결한다.",
  ].join("\n");
}

function workerInstructions(a: ChatAgent): string {
  return [
    `# 역할: AI_ChatterBox ${a.nickname} (${WORKER_KIND_LABEL[a.kind]} 작업자)`,
    `너는 마스터가 이끄는 팀의 작업자 "${a.nickname}"이다.${a.job ? ` 맡은 역할: ${a.job}` : ""}`,
    "- 너의 모델은 앱이 지정한다. 네이티브 spawn_agent/Agent/Task 또는 별도 CLI로 하위 작업자를 생성하지 않는다. 추가 인력이 필요하면 마스터에게 send_message로 요청한다. 기존 팀과는 앱 ask/ask_parallel/send_message/read_messages로 협업한다.",
    "- 구현 지시(implement): 지정된 범위(scope) 안의 파일만 고친다. 사용자에게 지정받은 종류의 작업을 수행한다. 승인·범위·도구 한계는 지킨다.",
    "- 계획·리뷰(review)·의견(opinion)·글쓰기(writing)에서도 사용자 지시에 필요한 수정·명령 실행이 가능하다. 지정된 파일 범위와 승인 절차, 사용자가 명시한 수정 금지를 지킨다.",
    "- 팀은 그룹 채팅으로 협의한다. send_message(to=all)는 사용자가 읽는 메인 대화다. 실제로 바뀐 진행, 동료에게 할 질문·답변·반론, 막힌 점이 생겼을 때만 쉬운 한국어 1~3문장으로 말한다. 원본 로그·코드·긴 검증표는 도구 기록이나 허용된 산출물 파일에 남기고 최종 보고에 복사하지 않는다. 결과는 앱이 전달하므로 같은 보고를 그룹에 다시 올리지 않는다. 할 말이 없으면 주기적인 상태 발언을 하지 않는다. 직접 질문은 동료에게 ask한다. 메시지를 read_messages로 확인한다. 질문마다 난도에 맞는 effort를 선택할 수 있다. 작업 중인 동료에게는 send_message, 상태 확인은 check_agent를 사용한다. 자신의 잠근 파일 범위는 다시 위임하지 않는다.",
    "- 메인 채팅에 직접 올린 보고를 마스터에게 전달·재보고해 달라고 요청하지 않는다. 마스터의 즉시 판단이 필요한 장애·범위 변경·질문은 send_message(to=마스터)로 직접 보낸다. 공개 진행 보고만으로 마스터의 응답을 기다리지 않는다.",
    "- writing은 글쓰기 목적의 배정이다. 필요한 사실 확인과 파일 반영은 지정 범위와 사용자 승인을 따르며 요청한 독자·말투·길이를 지킨다.",
    "- 다른 작업자에게 확인할 것이 있으면 ask(to=닉네임)로 직접 묻는다. 팀 목록은 agents. 마스터에게는 ask 대신 send_message(to=마스터)로 결정이 필요한 질문을 직접 보낸다.",
    "- 토의 그룹의 진행자로 지정되면 공통 주제와 너의 초안·근거·질문을 각 참여자에게 앱 ask로 직접 보내고, 실제 의견을 받아 대조·보완한 뒤 합의, 이견, 근거, 남은 결정을 한 번에 보고한다. 참여자로 질문을 받으면 쟁점에 답하고 반론·확인 질문을 이번 응답에 담는다. 너의 답을 기다리는 진행자에게 다시 ask하여 순환 대기를 만들지 않는다. 그룹 밖 쟁점이나 사용자 결정만 마스터에게 최종 보고한다.",
    "- 좁은 파일·근거 탐색에는 council_explore(search/grep/docs), 제공된 문맥만의 단발성 의견에는 council_consult를 사용할 수 있다. 마스터를 중계하지 않아도 된다. 검색은 제한된 읽기 전용 결과이며 전체 검증·독립 리뷰로 보고하지 않는다. Gemini 자문은 purpose=writing인 문장·대사·문서 작성에만 사용한다.",
    "- 최종 보고는 핵심 6개 항목 이내, 가급적 1000자 이내로 쓴다: 결론, 바뀐 파일·산출물 경로, 검증 결과, 미실행 검사·남은 문제, 마스터 결정이 필요한 사항. 실패·불확실성·중요한 위험은 먼저 쓴다. 원문이 필요한 동료는 read_consult로 확인할 수 있다. 글쓰기 전문이 산출물이거나 사용자가 상세 보고를 명시한 경우에는 요청한 내용을 보존하되 결론을 앞에 둔다.",
    `- 대사 전에 set_expression 도구로 감정을 지정한다 (${AGENT_EXPRESSIONS.join(", ")}). Claude에서는 mcp__chatterbox_bridge__set_expression. 기술적 내용과 말투는 그대로 유지한다.`,
  ].join("\n");
}

// ---------- state
interface Instruction {
  id: number;
  mode?: "direct" | "delegated";
  dualInvestigation?: boolean;
  repaired?: boolean;
  repairProgress?: string[];
  waitingForResults?: boolean;
  recoveryAttempts?: number;
  recoveryAfter?: number;
  recoveryNote?: string;
  /** The user's instruction text (context for the approval judge). */
  text: string;
  asks: number;
  reviews: number;
  requests: Map<string, number>;
  /** Extra instructions the user sent while the team was working. */
  queued: { text: string; attachments: AttachmentRef[] }[];
  /** Extra instructions retained for pause/resume; sent only once per active run. */
  pinned: string[];
  pinnedSent?: number;
  /** A user follow-up needs a visible master reply before further team management. */
  pendingImmediate?: boolean;
  /** route_request split: parallel requires the first assignment to be one ask_parallel. */
  split?: "single" | "parallel" | "sequential";
}

interface Discussion { topic: string; peers: ChatAgent[] }
interface PlanTaskRef { planId: number; taskId: string }
/**
 * The plan the user approved: its task definitions (the upper bound), each task's current range after an
 * amend_scope (inherited by retries), and the write ranges the user later allowed with extend_plan_scope.
 */
interface ApprovedPlan { planId: number; version?: number; tasks: PlanStep[]; effective?: Record<string, string[]>; extended?: string[] }

/** True when `glob` lies inside one of `allowed` (exact, or under an allowed `dir/**`). */
export function globWithin(glob: string, allowed: readonly string[]): boolean {
  const norm = (s: string) => s.trim().replace(/\\/g, "/").replace(/^\.\//, "").toLowerCase();
  const g = norm(glob);
  // A parent step could leave any allowed folder: never inside.
  if (g.split("/").includes("..")) return false;
  const wild = g.search(/[*?[{]/);
  // The literal text before the first wildcard, kept as is: "src*" must not pass for "src/**".
  const head = wild < 0 ? g.replace(/\/+$/, "") : g.slice(0, wild);
  return allowed.some((raw) => {
    const a = norm(raw);
    if (a === g || a === "**") return true;
    if (!a.endsWith("/**") || /[*?[{]/.test(a.slice(0, -3))) return false;
    const dir = a.slice(0, -3);
    // Inside only once the literal part has entered the folder (past its separator); a plain path may
    // also name the folder itself.
    return head.startsWith(dir + "/") || (wild < 0 && head === dir);
  });
}
/** A held write range; `command` marks the short lock of one unscoped command (released when it ends). */
interface ScopeLock { consultId: number; scope: string[]; command?: boolean; toolId?: string }
interface PausedAssignment {
  caller: Role; target: ChatAgent; kind: ConsultKind; message: string; scope: string[];
  attach: string[]; reason: string; effort?: string; model?: string; discussion?: Discussion; consultId?: number;
  planTask?: PlanTaskRef;
}
interface PauseState {
  folder: string;
  instruction: Omit<Instruction, "requests"> & { requests: [string, number][] };
  planning: boolean; reviewing: boolean; assignments: PausedAssignment[];
  /** Plan id of an approved /plan being carried out. */
  planRun?: number;
  /** A planning turn's version and whether it already submitted propose_plan. */
  planVersion?: number;
  planSubmitted?: boolean;
}
interface Running {
  lastEventAt: number;
  lastProbeAt?: number;
  tools?: Set<string>;
  lastError?: string;
  recovering?: boolean;
  recoveryError?: string;
  cliAccountId?: CliAccountId;
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
  /** The approved plan task this assignment carries out. */
  planTask?: PlanTaskRef;
  resolve: (r: { ok: boolean; interrupted?: boolean; error?: string }) => void;
  /** priority: failed attempts so far, the account switch in progress and the last switch shown to the team. */
  attempts?: PriorityAttempt[];
  switching?: boolean;
  /** Runs under a priority policy: every close before a switch must confirm the exit. */
  priority?: boolean;
  exhausted?: boolean;
  failover?: string;
}
interface PriorityAttempt { accountId: CliAccountId; reason: PriorityFailureReason; error: string }

export class Orchestrator {
  private messageFlights = new Set<string>();
  private recoveryTimer?: ReturnType<typeof setInterval>;
  private recoveryFlights = new Set<number>();
  private bridgeKeys = new Map<string, { key: string; url: string }>();
  private instructions = new Map<number, Instruction>();
  /** Running consults per chat, by target worker. */
  private running = new Map<number, Map<Role, Running>>();
  /** Who waits on whom (caller → targets), for the cycle / depth guard. */
  private waits = new Map<number, WaitGraph>();
  /** One turn at a time per worker. */
  private workerQueue = new Map<string, Promise<unknown>>();
  /** Only the master's tool wait is released; the consultation itself keeps running. */
  private masterConsultWaiters = new Map<number, Set<(note?: string) => void>>();
  /** Implement scopes currently held, per chat. */
  private scopeLocks = new Map<number, ScopeLock[]>();
  private scopeWaiters = new Map<number, (() => void)[]>();
  private asks = new Map<string, { chatId: number; resolve: (a: string) => void; keepStatus?: boolean }>();
  /** The app's [진행/수정/취소] question for a submitted plan, and a choice made while the turn still ran. */
  private planConfirm = new Map<number, string>();
  private planDecision = new Map<number, "run" | "cancel">();
  /** Chats whose messages, sent after the plan was submitted, revise that plan when the turn ends. */
  private reviseAfterTurn = new Set<number>();
  /** Those messages themselves, kept out of inst.queued until the submitting turn ends. */
  private revisionHold = new Map<number, AgentInput[]>();
  private stopped = new Set<number>();
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
  /** Planning turns that submitted propose_plan, and the plan version each planning turn works on. */
  private planSubmitted = new Set<number>();
  private planVersions = new Map<number, number>();
  private reviewing = new Set<number>();
  /** Master native tool calls which may still be changing the workspace. */
  private masterActions = new Map<number, Set<string>>();
  /** chatId -> id of the approved plan being carried out (the /plan instruction's id). */
  private planRunning = new Map<number, number>();
  private parallelBatches = new Map<number, Set<Promise<ToolResult>>>();
  /** Chats whose current turn already recorded its plan as incomplete (the completion guard). */
  private planIncomplete = new Set<number>();
  readonly judge: ApprovalJudge;
  readonly council: Council;

  constructor(private chats: ChatManager) {
    chats.beforeMasterEnd = (chatId, event) => this.checkCompletion(chatId, event);
    // Native plan tools (Claude TodoWrite, Codex plan updates) follow the same rules as the checklist
    // tool. A whole list cannot be refused, so steps that must stay are kept instead of dropped.
    chats.attributePlan = (chatId, event) => {
      const { planId, instructionId } = this.planOwner(chatId);
      if (planId === undefined) return event;
      const previous = planStepsFor(chats.store.events(chatId), planId) ?? [];
      // A native todo list must not rewrite a plan already submitted with propose_plan.
      if (this.planning.has(chatId) && this.planSubmitted.has(chatId))
        return { ...event, steps: previous.map((s) => ({ ...s })), explanation: event.explanation, planId, instructionId };
      // Title-only steps take the identity of the one same-titled step already recorded (never a guess),
      // then the same keep and cancellation rules as the checklist tool apply.
      const merged = keepDroppedSteps(previous, alignNativeSteps(previous, event.steps));
      try {
        return { ...event, steps: this.lockApproved(chatId, validatePlanSteps(merged, previous)), planId, instructionId };
      } catch (e) {
        // Never store an unchecked list over a recorded one: that would bypass the kept cancellations.
        if (previous.length) {
          chats.emit(chatId, "orch", null, { type: "notice", text: `계획 도구의 목록을 반영하지 못해 이전 체크리스트를 유지합니다: ${e instanceof Error ? e.message : String(e)} checklist 도구로 전체 목록을 다시 보내세요.` });
          return { ...event, steps: previous.map((s) => ({ ...s })), planId, instructionId };
        }
        return { ...event, planId, instructionId }; // Nothing recorded yet to protect: kept as reported, never lost.
      }
    };
    this.judge = new ApprovalJudge(chats, (chatId, role) => {
      const r = role ? this.running.get(chatId)?.get(role) : undefined;
      return {
        instruction: this.instructions.get(chatId)?.text,
        consult: r ? { who: roleName(r.target, chats.store.listAgents(chatId)), kind: r.kind, message: r.message, scope: r.scope } : undefined,
      };
    });
    chats.judge = (chatId, request, input) => this.judge.decide(chatId, request, input);
    this.council = new Council(chats);
    chats.writeScope = (chatId, role) => this.writeScope(chatId, role);
    chats.approvalGuard = (chatId, input) => this.guardApproval(chatId, input);
    chats.instructionsFor = (chat, project, role, agent) => {
      if (role === "orch") return masterInstructions(project, agent);
      const a = chats.store.agentByKey(chat.id, role);
      return a ? workerInstructions(a) : undefined;
    };
    chats.toolsFor = (chat, role) => ({ chatterbox_bridge: this.bridgeFor(chat.id, role) });
    chats.bridgeToolNames = (chatId, role) => this.bridgeToolNames(chatId, role);
    chats.approvalDenied = (chatId, role, toolId) => {
      const r = toolId ? this.running.get(chatId)?.get(role) : undefined;
      if (r) this.releaseCommandLock(chatId, r.consultId, toolId);
    };
    chats.onDriverEvent = (chatId, role, event) => this.observe(chatId, role, event);
    chats.sendHandler = (chat, input) => this.instruct(chat, input);
    chats.busySend = (chat, input, delivery) => chat.status !== "paused" && delivery === "now" ? this.deliverNow(chat, input) : this.queue(chat, input);
  }

  startRecovery() {
    if (this.recoveryTimer) return;
    this.recoveryTimer = setInterval(() => void this.sweepWorkerRecovery().catch(() => undefined), 15_000);
    this.recoveryTimer.unref();
  }

  stopRecovery() {
    clearInterval(this.recoveryTimer);
    this.recoveryTimer = undefined;
  }

  get recovering() { return this.recoveryFlights.size > 0; }

  /** An app notice about a worker (not the worker's words) that also reaches a waiting or idle master. */
  private alertMaster(chatId: number, role: Role, note: string) {
    this.chats.emit(chatId, "orch", role, { type: "room_message", from: role, text: `[앱 상태 점검] ${note}`, kind: "system" });
    this.wakeMasterConsults(chatId, note);
    const master = this.chats.liveDriver(chatId, "orch");
    if (master?.running) void master.steer?.({ text: `[앱 상태 점검]\n${note}`, attachments: [] }).catch(() => undefined);
    else if (master) {
      this.chats.updateChat(chatId, { status: "working" });
      void master.send({ text: `[앱 상태 점검]\n${note}`, attachments: [] }).catch(() => undefined);
    }
  }

  /**
   * priority switch: archive and close the failed account's process. Returns why its exit could not be
   * confirmed; the live handle then stays in place so check_agent(recover=true) can still clean it up.
   */
  private async closeForSwitch(chatId: number, role: Role): Promise<string | undefined> {
    const old = this.chats.liveDriver(chatId, role);
    try {
      if (old) {
        if (!old.closeStrict) throw new Error("이 작업자 종류는 프로세스 종료 확인을 지원하지 않습니다.");
        // Each driver bounds its own checks; this outer deadline only guards against one that never answers.
        const closed = await this.withinDeadline(old.closeStrict(), this.switchCloseMs);
        if (closed !== true) throw new Error(closed);
        if (old.running) throw new Error("이전 프로세스가 아직 실행 중입니다.");
      }
    } catch (error) {
      // The handle stays so a later recover can retry the same confirmed close.
      return error instanceof Error ? error.message : String(error);
    }
    // Exit confirmed. Archiving the closed session and dropping the handle are best effort within a
    // deadline: a silent archive must never hold the switch (or block recover) indefinitely.
    const archived = await this.withinDeadline(this.chats.archiveWorker(chatId, role), this.switchCleanupMs);
    // disposeRole removes the handle at once; only its (already closed) driver cleanup is awaited.
    const released = await this.withinDeadline(this.chats.disposeRole(chatId, role), this.switchCleanupMs);
    if (archived !== true || released !== true)
      this.chats.emit(chatId, "orch", "orch", { type: "notice", text: `이전 계정 실행 종료는 확인했으나 세션 ${archived !== true ? "보관" : "정리"}을 완료하지 못했습니다(${archived !== true ? archived : released}). 계정 전환은 계속합니다.` });
    return undefined;
  }

  /** Deadline for the best-effort archive/cleanup after a confirmed close (tests may shorten it). */
  switchCleanupMs = 8000;
  /** Outer deadline for a driver's confirmed close (its own checks are shorter). */
  switchCloseMs = 20_000;

  /** true when the promise settled successfully in time; otherwise why not (never throws). */
  private async withinDeadline(promise: Promise<unknown>, ms: number): Promise<true | string> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        promise.then(() => true as const),
        new Promise<string>(resolve => { timer = setTimeout(() => resolve(`${Math.round(ms / 1000)}초 시간 초과`), ms); }),
      ]);
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    } finally { clearTimeout(timer); }
  }

  /**
   * Ends a worker's run before its write scope is released or another account continues the work.
   * Priority assignments (manual recover, sweep and switch alike) use the confirmed close above and
   * keep the handle and scope on failure; other policies keep their existing recover/dispose steps.
   * Throws when the end is not confirmed.
   */
  private async endWorkerRun(chatId: number, role: Role, running: Running, manual: boolean): Promise<void> {
    if (running.priority) {
      const error = await this.closeForSwitch(chatId, role);
      if (error) throw new Error(`이전 실행 종료를 확인하지 못했습니다: ${error}`);
      return;
    }
    const driver = this.chats.liveDriver(chatId, role);
    if (manual) {
      if (!driver) throw new Error("기존 작업자 실행 핸들을 확인하지 못했습니다.");
      await (driver.recover ? driver.recover() : driver.dispose());
      if (driver.running) throw new Error("기존 작업자 실행 종료를 확인하지 못했습니다.");
      if (!driver.recover) await this.chats.disposeRole(chatId, role, true);
      return;
    }
    // Dispose the failed session before releasing its write scope or assigning a replacement.
    if (driver?.running) await (driver.recover ? driver.recover() : driver.dispose());
    if (driver?.running) throw new Error("작업자 프로세스가 아직 실행 중입니다.");
    if (!driver?.recover) await this.chats.disposeRole(chatId, role);
  }

  /** Silence prompts a check, not termination: a long tool may still own its write scope. */
  async sweepWorkerRecovery(now = Date.now()) {
    for (const [chatId, inst] of this.instructions) {
      const chat = this.chats.store.chat(chatId);
      if (!chat || this.stopped.has(chatId) || ["paused", "pausing", "approval"].includes(chat.status) || this.recoveryFlights.has(chatId)) continue;
      this.recoveryFlights.add(chatId);
      try {
        for (const [role, running] of this.running.get(chatId) ?? []) {
          const driver = this.chats.liveDriver(chatId, role);
          if (!running.lastError && now - running.lastEventAt >= 300_000 && now - (running.lastProbeAt ?? 0) >= 300_000) {
            running.lastProbeAt = now;
            if (driver && !driver.running) {
              running.lastError = "작업자 실행이 끝났지만 종료 결과가 도착하지 않았습니다.";
            } else {
              const note = `${this.name(chatId, role)}의 활동이 ${Math.floor((now - running.lastEventAt) / 60_000)}분간 없습니다. 긴 도구 실행·동료 대기일 수 있으며 실패로 단정하지 않습니다. 마스터는 check_agent(to="${this.name(chatId, role)}")로 확인하고, 실제 무응답이면 recover=true로 기존 실행 정리 후 supersedes로 이어 맡기세요. 이미 배정했다는 이유로 확인을 생략하지 마세요.`;
              this.alertMaster(chatId, role, note);
            }
          }
          if (!running.lastError || running.recovering || now - running.lastEventAt < 60_000) continue;
          running.recovering = true;
          running.recoveryError = running.lastError;
          try {
            await this.endWorkerRun(chatId, role, running, false);
            running.recovering = false;
            if (this.instructions.get(chatId) !== inst || this.stopped.has(chatId)) {
              running.resolve({ ok: false, interrupted: true });
              continue;
            }
            running.resolve({ ok: false, error: running.recoveryError });
            this.chats.emit(chatId, this.chats.route(chatId, role), role, { type: "turn_end", ok: false, error: running.recoveryError });
          } catch (error) {
            running.recovering = false;
            running.recoveryError = undefined;
            running.lastEventAt = now;
            this.chats.emit(chatId, "orch", "orch", { type: "notice", text: `오류 작업자 정리를 완료하지 못했습니다: ${String(error)}. 다른 작업자에게 같은 파일을 재배정하지 않습니다.` });
          }
        }
        // Let settled consults persist their final status and release the worker queue.
        await Promise.resolve();
        if (this.instructions.get(chatId) !== inst || this.stopped.has(chatId) || (inst.recoveryAfter ?? 0) > now) continue;
        const all = this.chats.store.listConsults(chatId).filter(c => c.instructionId === inst.id);
        const failed = all.filter(c => c.status === "error" && !all.some(next => next.supersedes === c.id && next.status !== "stopped"));
        if (!failed.length) continue;
        const attempts = inst.recoveryAttempts ?? 0;
        if (attempts >= 3) {
          if (inst.recoveryAfter !== Infinity) {
            inst.recoveryAfter = Infinity;
            this.chats.emit(chatId, "orch", "orch", { type: "notice", text: "작업자 오류 복구를 세 차례 요청했지만 해결되지 않았습니다. 로그인·한도·실행 환경을 확인해 주세요. 기존 결과와 실패 기록은 보존했습니다." });
            if (!this.chats.isBusy(chatId)) this.chats.updateChat(chatId, { status: "error", unread: true });
          }
          continue;
        }
        const note = `[앱 작업자 오류 점검 ${attempts + 1}/3 — 기존 지시 계속]\n${failed.map(c => `협의 ${c.id} · ${this.name(chatId, c.toRole)}: ${clipText(c.responseSummary ?? "응답 종료 실패", 1200)}\n원래 요청: ${clipText(c.request, 1200)}`).join("\n\n")}\n원인을 확인하고 가능한 오류를 해결하세요. 기존 변경과 결과를 먼저 확인하고, ask의 supersedes에 실패 협의 id를 넣어 같은 작업자를 재시도하거나 가용한 다른 작업자에게 재배정하세요. 로그인·한도·사용자 승인이 필요하면 ask_user로 알리고 기다리세요. 성공하지 않은 일을 완료로 보고하지 마세요. 승인 정책과 기존 작업 범위·배정 한도는 그대로 적용됩니다.`;
        const master = await this.chats.driver(chatId, "orch");
        if (this.instructions.get(chatId) !== inst || this.stopped.has(chatId) || ["paused", "pausing", "approval"].includes(this.chats.store.chat(chatId)?.status ?? "")) continue;
        let accepted = false;
        if (master.running) {
          try { accepted = !!(await master.steer?.({ text: note, attachments: [] })); } catch { /* retry after the native turn settles */ }
          inst.recoveryNote = accepted ? undefined : note;
          if (!accepted && this.masterConsultWaiters.get(chatId)?.size) {
            this.wakeMasterConsults(chatId, note);
            accepted = true;
          }
        } else {
          this.chats.updateChat(chatId, { status: "working", touch: true });
          await master.send({ text: note + this.takeQueued(chatId), attachments: [], noWrites: false });
          accepted = true;
        }
        inst.recoveryAfter = now + 60_000;
        if (accepted) {
          inst.recoveryAttempts = attempts + 1;
          this.chats.emit(chatId, "orch", "orch", { type: "notice", text: `마스터에게 오류 작업 ${failed.length}건의 점검·복구를 요청했습니다 (${attempts + 1}/3).` });
        }
      } catch (error) {
        inst.recoveryAfter = now + 60_000;
        this.chats.emit(chatId, "orch", "orch", { type: "notice", text: `마스터 오류 점검 전달 실패: ${String(error)}. 다음 점검에서 다시 확인합니다.` });
      } finally { this.recoveryFlights.delete(chatId); }
    }
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
      reg = this.chats.bridge.register(
        {
          tools: this.bridgeTools(chatId, role),
          call: (name, args) => this.call(chatId, role, name, args),
        },
        id,
      );
      this.bridgeKeys.set(id, reg);
    }
    return bridgeServerConfig(this.chats.bridgeScript, reg.url);
  }

  private bridgeTools(chatId: number, role: Role): ToolDef[] {
    const chat = this.chats.store.chat(chatId);
    const folder = chat ? this.chats.store.project(chat.projectId)?.folder : undefined;
    return role === "orch"
      ? [ROUTE_TOOL, ...COUNCIL_TOOLS, CLI_ACCOUNTS_TOOL, SPAWN_TOOL, ASK_TOOL(true, folder), ASK_PARALLEL_TOOL(true, folder), WAIT_RESULTS_TOOL, AMEND_SCOPE_TOOL, EXTEND_PLAN_SCOPE_TOOL, MESSAGE_TOOL, MESSAGES_TOOL, RELEASE_TOOL, AGENTS_TOOL, READ_CONSULT_TOOL, CHECK_AGENT_TOOL, CHECKLIST_TOOL, PROPOSE_PLAN_TOOL, GOAL_TOOL, ASK_USER_TOOL, EXPRESSION_TOOL]
      : [...COUNCIL_TOOLS, ASK_TOOL(false, folder), ASK_PARALLEL_TOOL(false, folder), MESSAGE_TOOL, MESSAGES_TOOL, AGENTS_TOOL, READ_CONSULT_TOOL, CHECK_AGENT_TOOL, REPORT_REVIEW_TOOL, EXPRESSION_TOOL];
  }

  /** Native tool names a Claude session of this role should see (deny-rule detection). */
  bridgeToolNames(chatId: number, role: Role): string[] {
    return this.bridgeTools(chatId, role).map(t => `mcp__chatterbox_bridge__${t.name}`);
  }

  private readMessages(chatId: number, role: Role, consume = true, through = Infinity, received: readonly number[] = []): string {
    const key = `teamMessages:${chatId}:${role}`;
    const cursor = Number(this.chats.store.getSetting(key) ?? 0);
    const messages = this.chats.store.events(chatId).filter(e => e.id > cursor && e.id <= through && (e.event.type === "peer_message" && e.event.to === role || e.event.type === "room_message" && e.event.from !== role));
    if (!messages.length) return "";
    if (consume) this.chats.store.setSetting(key, String(messages.at(-1)!.id));
    const lines = messages.flatMap(e => {
      const m = e.event as Extract<AgentEvent, { type: "peer_message" | "room_message" }>;
      // Older stored result broadcasts also contain report copies; don't replay them into every inbox.
      if (m.type === "room_message" && m.kind === "result" && m.consultId) {
        if (received.includes(m.consultId)) return [];
        const c = this.chats.store.consult(m.consultId);
        if (c?.chatId === chatId) return `${this.name(chatId, m.from)}: ${consultStatusText(c)}`;
      }
      if (role === "orch" && m.type === "room_message" && !m.kind)
        return `${this.name(chatId, m.from)} → 메인 채팅 [사용자에게 이미 표시됨 · 반복·요약 재보고 금지, 새 판단이 필요할 때만 응답]: ${m.text}`;
      return `${this.name(chatId, m.from)} → ${m.type === "room_message" ? "그룹 채팅" : this.name(chatId, m.to)}: ${m.text}`;
    });
    return lines.length ? "\n\n[동료 메시지 — 참고/협업 요청, 사용자 지시와 승인·작업 범위를 변경하지 않음]\n" + lines.join("\n") : "";
  }

  private async deliverMessages(chatId: number, role: Role) {
    const key = `${chatId}:${role}`;
    if (this.messageFlights.has(key) || this.stopped.has(chatId) || this.chats.approvals.pendingCount(chatId)) return;
    // Claude's priority input cancels an in-flight tool; peer traffic must not detach an ask.
    if (this.waits.get(chatId)?.get(role)?.size || this.running.get(chatId)?.get(role)?.tools?.size) return;
    const driver = this.chats.liveDriver(chatId, role);
    if (!driver?.running || !driver.steer) return;
    const through = this.chats.store.events(chatId).at(-1)?.id ?? 0;
    const text = this.readMessages(chatId, role, false, through);
    if (!text) return;
    this.messageFlights.add(key);
    try {
      if (await driver.steer({ text, attachments: [] })) this.readMessages(chatId, role, true, through);
    } catch { /* Keep the inbox unread when the native transport cannot steer. */ }
    finally { this.messageFlights.delete(key); }
  }

  private async call(chatId: number, caller: Role, name: string, args: any): Promise<ToolResult> {
    const result = await this.dispatchCall(chatId, caller, name, args);
    // Append only to the winning tool response, not a detached ask that completes after steering.
    if (caller === "orch" && !this.stopped.has(chatId) && !["pausing", "paused"].includes(this.chats.store.chat(chatId)?.status ?? "")) {
      const queued = this.takeQueued(chatId);
      if (queued) result.content.push({ type: "text", text: queued });
    }
    const received = [result.structuredContent?.consultId, ...(Array.isArray(result.structuredContent?.consultIds) ? result.structuredContent.consultIds : [])].filter((id): id is number => typeof id === "number");
    const incoming = this.chats.store.chat(chatId) ? this.readMessages(chatId, caller, true, Infinity, received) : "";
    if (incoming) result.content.push({ type: "text", text: incoming });
    return result;
  }

  private async dispatchCall(chatId: number, caller: Role, name: string, args: any): Promise<ToolResult> {
    if (!this.chats.store.chat(chatId)) return textResult("채팅이 삭제되었습니다.", true);
    if ((this.stopped.has(chatId) || ["pausing", "paused"].includes(this.chats.store.chat(chatId)!.status)) && name !== "agents") return textResult("사용자가 작업을 중지했습니다. 재시작 전까지 기다리세요.", true);
    const master = caller === "orch";
    if (master && this.instructions.get(chatId)?.pendingImmediate && ["council_consult", "council_explore", "spawn", "ask", "ask_parallel", "release", "checklist", "update_goal", "ask_user"].includes(name))
      return textResult("사용자의 즉시 추가 질문·수정 요청에 먼저 직접 답변하세요. 이미 아는 내용은 바로 설명하고, 수정 요청은 이해한 내용과 반영 방법을 사용자에게 먼저 말한 뒤 기존 작업을 계속하세요. 기존 작업자는 그대로 실행 중입니다.", true);
    if (master && this.planning.has(chatId) && PLANNING_BLOCKED.has(name))
      return textResult(`지금은 계획 모드라 ${name}을(를) 쓸 수 없습니다. 작업자를 쓰지 말고 직접 읽기 전용으로 살핀 뒤, 꼭 필요한 결정은 ask_user로 묻고, 할 일 전체를 propose_plan으로 제출하세요. 배정은 사용자가 승인한 뒤 실행 단계에서 합니다.`, true);
    try {
      switch (name) {
        case "council_consult":
        case "council_explore": {
          if (master && !this.instructions.has(chatId)) return textResult("진행 중인 사용자 지시가 없습니다.", true);
          if (!master && !this.running.get(chatId)?.has(caller)) return textResult("현재 배정받은 작업이 없습니다.", true);
          const epoch = this.epochs.get(chatId);
          const result = await this.council.run(chatId, name, args);
          if (this.stopped.has(chatId) || this.epochs.get(chatId) !== epoch) return textResult("자문·탐색이 중지되었습니다. 이전 답변은 반영하지 않습니다.", true);
          return textResult(JSON.stringify(result));
        }
        case "read_messages": return textResult(this.readMessages(chatId, caller) || "새 협업 메시지가 없습니다.");
        case "read_consult": {
          if (!Number.isSafeInteger(args.consultId)) return textResult("consultId는 정수여야 합니다.", true);
          const c = this.chats.store.consult(args.consultId);
          if (!c || c.chatId !== chatId) return textResult("이 채팅의 협의를 찾을 수 없습니다.", true);
          if (args.detail !== undefined && typeof args.detail !== "boolean") return textResult("detail은 boolean이어야 합니다.", true);
          const offset = args.offset ?? 0, limit = args.limit ?? 4000;
          if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 8000) return textResult("offset은 0 이상 정수, limit은 1~8000 정수여야 합니다.", true);
          if (!args.detail) return textResult(master ? masterResultText(c) : consultResultText(c));
          const report = JSON.stringify({ responseSummary: c.responseSummary, filesChanged: c.filesChanged, review: c.review ?? null }, null, 2);
          return textResult(JSON.stringify({ consultId: c.id, status: c.status, offset, totalChars: report.length, nextOffset: offset + limit < report.length ? offset + limit : null, text: report.slice(offset, offset + limit) }));
        }
        case "check_agent": {
          if (args.recover !== undefined && typeof args.recover !== "boolean") return textResult("recover는 boolean이어야 합니다.", true);
          const to = String(args.to ?? "").trim();
          const target = this.agents(chatId).find(a => a.nickname === to || a.key === to);
          if (!target || target.status !== "active") return textResult("점검할 활성 동료를 지정하세요.", true);
          const running = this.running.get(chatId)?.get(target.key);
          const driver = this.chats.liveDriver(chatId, target.key);
          const latest = this.chats.store.listConsults(chatId).findLast(c => c.toRole === target.key);
          if (args.recover) {
            if (!master || !running || running.recovering) return textResult("마스터만 실행 중인 작업을 복구할 수 있습니다.", true);
            if (running.switching) return textResult("앱이 우선 할당 계정 전환을 진행 중입니다. 잠시 후 check_agent로 다시 확인하세요.", true);
            if (this.chats.approvals.pendingCount(chatId)) return textResult("사용자 승인 대기 중입니다. 승인 응답을 먼저 확인하세요.", true);
            running.recovering = true;
            running.recoveryError = "마스터가 무응답 작업의 실행을 정리했습니다. 기존 산출물을 확인하고 이어서 진행하세요.";
            try {
              await this.endWorkerRun(chatId, target.key, running, true);
              running.recovering = false;
              running.resolve({ ok: false, error: running.recoveryError });
              if (running.switching) return textResult(`기존 실행 종료를 확인했습니다. 계정 우선 할당 정책에 따라 앱이 협의 ${running.consultId}를 다음 계정으로 이어서 실행합니다(${running.failover}). 재배정하지 말고 결과를 기다리세요.`);
              return textResult(`기존 실행 종료를 확인했습니다. 협의 ${running.consultId} 정리 후 supersedes로 이어 맡기세요. 저장된 결과는 보존했습니다.`);
            } catch (error) {
              running.recovering = false;
              running.recoveryError = undefined;
              return textResult(`기존 실행 정리 실패: ${String(error)}. 같은 파일을 다른 작업자에게 재배정하지 마세요.`, true);
            }
          }
          if (running) {
            this.chats.emit(chatId, this.chats.route(chatId, target.key), caller, { type: "peer_message", from: caller, to: target.key, text: "현재 진행 상황·남은 작업·막힌 이유를 알려주세요. 기존 작업을 중복 시작하지 마세요." });
            void this.deliverMessages(chatId, target.key);
          }
          return textResult(JSON.stringify({ nickname: target.nickname, state: running ? driver?.running ? "running" : "missing_terminal_result" : "idle", quietSeconds: running ? Math.floor((Date.now() - running.lastEventAt) / 1000) : null, pendingTools: running?.tools?.size ?? 0, error: running?.lastError ?? null, latest: latest ? { id: latest.id, status: latest.status } : null }));
        }
        case "send_message": {
          const to = String(args.to ?? "").trim();
          const text = String(args.message ?? "").trim();
          if (["all", "everyone", "팀", "전체"].includes(to)) {
            if (!text || text.length > 16000 || caller !== "orch" && !this.running.get(chatId)?.has(caller)) return textResult("현재 배정과 1~16000자의 메시지가 필요합니다.", true);
            const previous = this.chats.store.events(chatId).findLast(e => e.event.type === "room_message" && e.event.from === caller)?.event;
            if (previous?.type === "room_message" && previous.text === text) return textResult("같은 발언이 이미 그룹 채팅에 있습니다. 새 근거나 질문을 추가하세요.", true);
            this.chats.emit(chatId, "orch", caller, { type: "room_message", from: caller, text });
            // Public reports already reach the user. Don't interrupt the master just to relay them.
            for (const role of this.agents(chatId).filter(a => a.status === "active").map(a => a.key)) if (role !== caller) void this.deliverMessages(chatId, role);
            return textResult("메인 채팅에 표시했습니다. 마스터의 재보고는 필요 없습니다. 즉시 판단이 필요하면 마스터에게 직접 send_message를 보내고, 답변이 필요한 동료에게는 ask로 질문하세요.");
          }
          const target = ["orch", "master", "마스터"].includes(to) ? "orch" : this.agents(chatId).find(a => (a.nickname === to || a.key === to) && a.status === "active")?.key;
          if (!target || target === caller || !text || text.length > 16000) return textResult("활성 동료/마스터와 1~16000자의 메시지를 지정하세요. 자신에게는 보낼 수 없습니다.", true);
          if (caller !== "orch" && !this.running.get(chatId)?.has(caller)) return textResult("현재 배정받은 작업이 없습니다.", true);
          this.chats.emit(chatId, this.chats.route(chatId, target), caller, { type: "peer_message", from: caller, to: target, text });
          void this.deliverMessages(chatId, target);
          if (target === "orch") this.wakeMasterConsults(chatId, `${this.name(chatId, caller)}의 새 메시지: ${text}`);
          return textResult(`${this.name(chatId, target)}에게 메시지를 저장하고 즉시 전달을 시도했습니다. 다음 앱 도구 호출에도 확인합니다. 답을 기다리지 않고 맡은 작업을 계속하세요.`);
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
          if (args.split !== undefined && !["single", "parallel", "sequential"].includes(args.split)) return textResult("split은 single, parallel, sequential 중 하나여야 합니다.", true);
          if (args.mode === "delegated" && args.split !== undefined) inst.split = args.split;
          inst.mode = args.mode;
          inst.dualInvestigation = dualInvestigation;
          this.saveInstruction(chatId);
          this.chats.emit(chatId, "orch", "orch", { type: "dispatch", instructionId: inst.id, mode: args.mode, reason: String(args.reason).trim(), dualInvestigation });
          const capabilities = await this.chats.teamCapabilities(this.chats.store.chat(chatId)!);
          if (this.instructions.get(chatId) !== inst || this.stopped.has(chatId) || ["pausing", "paused"].includes(this.chats.store.chat(chatId)?.status ?? "")) return textResult("작업이 중지되거나 새 지시로 변경되었습니다.", true);
          const cli = this.cliAccountsInfo(chatId);
          for (const kind of CLI_ACCOUNT_KINDS) {
            const accounts = cli.accounts.filter(a => a.kind === kind);
            const policy = cli.policies[kind];
            if (accounts.length > 1 || policy.source !== "default") Object.assign(capabilities[kind], { cliAccounts: accounts, accountPolicy: policy });
          }
          return textResult(JSON.stringify({ capabilities, team: this.agentsText(chatId), dualInvestigation, note: "사용 가능 도구·사용량은 현재 확인값이며 인증/한도 오류는 실행 시 보고됩니다. 이미지 미확인은 사용 가능으로 간주하지 마세요." }));
        }
        case "set_expression":
          if (!isAgentExpression(args.expression)) return textResult("지원하지 않는 표정입니다.", true);
          this.chats.emit(chatId, this.chats.route(chatId, caller), caller, { type: "expression", expression: args.expression });
          return textResult("표정을 반영했습니다.");
        case "ask": {
          if (master) {
            const gate = this.singleAskIssue(chatId, args);
            if (gate) return textResult(gate, true);
          }
          const task = this.askTool(chatId, caller, args);
          return await (master ? this.waitForMasterConsult(chatId, task) : task);
        }
        case "ask_parallel": {
          const tasks: any[] = Array.isArray(args.tasks) ? args.tasks : [];
          if (!tasks.length) return textResult("tasks가 비었습니다.", true);
          if (args.coordinator !== undefined && (typeof args.coordinator !== "string" || !tasks.some(t => t.to === args.coordinator))) return textResult("coordinator는 이번 tasks에 배정한 작업자 닉네임이어야 합니다.", true);
          if (args.reportsOnly !== undefined && (!master || typeof args.reportsOnly !== "boolean")) return textResult("reportsOnly는 마스터가 지정하는 boolean 옵션입니다.", true);
          if (args.reportsOnly && args.coordinator !== undefined) return textResult("reportsOnly=true와 coordinator는 함께 지정할 수 없습니다.", true);
          // Check every plan task before starting any, so one bad task does not leave half a batch running.
          const issues = tasks.flatMap((t, i) => {
            const target = this.agents(chatId).find((a) => a.nickname === String(t?.to ?? "").trim());
            const issue = this.assignmentIssue(chatId, caller, this.withPlanDefaults(chatId, caller, t), target);
            return issue ? [`${i + 1}. ${String(t?.to ?? "")}: ${issue}`] : [];
          });
          if (issues.length) return textResult(`배정을 시작하지 않았습니다.\n${issues.join("\n")}`, true);
          const planIds = tasks.map(t => t?.planTaskId).filter((id): id is string => typeof id === "string");
          if (new Set(planIds).size !== planIds.length) return textResult("같은 planTaskId를 한 번에 두 번 배정할 수 없습니다.", true);
          // The master gets each result directly unless it asked for a synthesis (coordinator or reportsOnly=false).
          if (master && args.coordinator === undefined && args.reportsOnly === undefined) args = { ...args, reportsOnly: true };
          const batches = this.parallelBatches.get(chatId) ?? new Set<Promise<ToolResult>>();
          this.parallelBatches.set(chatId, batches);
          const result = this.parallelAsks(chatId, caller, tasks, args.coordinator, args.reportsOnly === true).finally(() => {
            batches.delete(result);
            if (!batches.size && this.parallelBatches.get(chatId) === batches) this.parallelBatches.delete(chatId);
          });
          batches.add(result);
          return await (master ? this.waitForMasterConsult(chatId, result) : result);
        }
        case "propose_plan":
          if (!master) break;
          return this.proposePlan(chatId, args);
        case "wait_results":
          if (!master) break;
          return await this.waitResults(chatId, args.consultIds, args.timeoutSec);
        case "amend_scope":
          if (!master) break;
          return this.amendScope(chatId, String(args.to ?? ""), args.scope, String(args.reason ?? ""));
        case "extend_plan_scope":
          if (!master) break;
          return await this.extendPlanScope(chatId, args.scope, String(args.reason ?? ""));
        case "cli_accounts": {
          if (!master) return textResult("CLI 계정 조회·선택은 마스터가 직접 합니다.", true);
          if (args.kind !== undefined && !(CLI_ACCOUNT_KINDS as readonly unknown[]).includes(args.kind)) return textResult("kind는 claude, gpt, grok 중 하나여야 합니다.", true);
          if (args.refresh !== undefined && typeof args.refresh !== "boolean") return textResult("refresh는 boolean이어야 합니다.", true);
          const epoch = this.epochs.get(chatId);
          if (args.refresh === true) {
            if (args.kind) await Promise.all(this.chats.listCliAccounts(args.kind).map(a => this.chats.refreshCliAccount(a.accountId)));
            else await this.chats.refreshCliAccount();
          }
          if (this.stopped.has(chatId) || this.epochs.get(chatId) !== epoch || !this.chats.store.chat(chatId)) return textResult("계정 조회 중 작업이 중지되거나 채팅이 종료되었습니다.", true);
          return textResult(JSON.stringify({ ...this.cliAccountsInfo(chatId, args.kind), minimumRemainingPercent: CLI_LOW_REMAINING, selection: "master", note: "fixed·auto는 자동 선택·전환·작업 재시도 없음. priority는 앱이 우선 순서대로 배정하고 실패 시 다음 계정으로 이어서 실행합니다(policies의 order·priorityState 참고). remainingPercent=null은 미조회·오류·10분 초과입니다. auto에서는 로그인·enabled·실행 중 작업자를 확인하고 잔여량 10% 초과인 대기 계정을 우선 지정하고, 대기 계정이 없으면 같은 조건의 계정을 여러 작업자가 공유할 수 있습니다. refresh=true만 실측을 갱신합니다." }));
        }
        case "report_review": {
          if (master) break;
          // The bridge is bound to the caller's role, so the consult can only be the caller's own.
          const running = this.running.get(chatId)?.get(caller);
          if (!running || running.kind !== "review") return textResult("현재 실행 중인 자신의 review 협의에만 결과를 제출할 수 있습니다.", true);
          const review = validateReviewResult(args);
          const saved = this.chats.store.setConsultReview(running.consultId, review);
          if (!saved) return textResult("이미 끝난 리뷰 협의의 결과는 바꿀 수 없습니다.", true);
          this.chats.sink.consult(saved);
          this.chats.emit(chatId, this.chats.route(chatId, caller), caller, { type: "review_result", consultId: running.consultId, review });
          return textResult(`협의 ${running.consultId}의 리뷰 결과(${review.verdict})를 저장했습니다. 파일이나 patch는 적용하지 않았습니다.`);
        }
        case "agents":
          return textResult(this.agentsText(chatId, true));
        case "spawn":
          if (!master) break;
          if (!["claude", "gpt", "gemini", "grok", "deepseek"].includes(args.kind)) return textResult("지원하지 않는 작업자 종류입니다.", true);
          return this.spawn(chatId, args.kind, String(args.job ?? ""), args.accountId, args.clearAccountId);
        case "release":
          if (!master) break;
          return await this.release(chatId, String(args.nickname ?? ""));
        case "checklist":
          if (!master) break;
          if (this.planning.has(chatId) && this.planSubmitted.has(chatId)) return textResult("이미 propose_plan으로 제출한 계획이 있습니다. 바꾸려면 propose_plan을 다시 호출하세요.", true);
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

  private async parallelAsks(chatId: number, caller: Role, tasks: any[], coordinator?: string, reportsOnly = false): Promise<ToolResult> {
    const inst = this.instructions.get(chatId), epoch = this.epochs.get(chatId);
    const results = await Promise.all(tasks.map(t => this.askTool(chatId, caller, reportsOnly ? { ...t, summary: true } : t)
      .catch(error => textResult(error instanceof Error ? error.message : String(error), true))));
    const reports = results.map((r, i) => `## ${i + 1}. ${String(tasks[i]?.to ?? "")}\n${r.content.map(c => c.text).join("\n")}`).join("\n\n");
    if (caller !== "orch" || (tasks.length === 1 && !reportsOnly)) return textResult(reports, results.every(r => r.isError));
    const records = results.map(r => {
      const id = r.structuredContent?.consultId;
      return typeof id === "number" ? this.chats.store.consult(id) : undefined;
    });
    const receipts = records.map((c, i) => c ? `${tasks[i].to}: ${consultStatusText(c)}` : `${tasks[i].to}: 배정 실패 · ${clipText(results[i].content.map(x => x.text).join("\n"), 500)}`).join("\n");
    if (this.stopped.has(chatId) || this.epochs.get(chatId) !== epoch || this.instructions.get(chatId) !== inst || !this.chats.store.chat(chatId)) return textResult(`작업이 중지·변경되어 결과 취합을 시작하지 않았습니다.\n${receipts}`, true);
    const consultIds = records.flatMap(c => c ? [c.id] : []);
    if (reportsOnly) return { ...textResult(reports, results.some(r => r.isError)), structuredContent: { consultIds } };
    const selected = coordinator ? tasks.findIndex(t => t.to === coordinator) : results.findIndex((r, i) => !r.isError && records[i]);
    if (selected < 0 || !records.some(Boolean)) return textResult(`결과 취합 미완료: 성공한 담당자가 없습니다.\n${receipts}`, true);
    const task = tasks[selected];
    const combined = await this.askTool(chatId, caller, {
      to: task.to, kind: "opinion", summary: true, reason: "작업자들이 수행한 결과의 상호 확인·취합", effort: task.effort, model: task.model,
      message: `[작업자 결과 취합]\n${receipts}\n\n각 협의를 read_consult로 확인하고 필요한 상세만 detail=true로 읽으세요. 누락·충돌은 해당 동료에게 직접 ask/send_message로 확인하세요. 기존 작업을 반복하지 말고, 완료·미완료, 실제 검증과 미실행 검사, 산출물 경로, 합의·이견, 마스터가 바꿔야 할 방침만 통합 보고하세요. 실패한 배정과 미제출 리뷰를 숨기거나 통과로 바꾸지 마세요. 자기 구현에 대한 취합은 독립 리뷰가 아닙니다. 소스·로그·개별 보고를 복사하지 말고 최종 보고는 400자 이내로 마무리하세요. 파일 변경은 맡기지 않았습니다.`,
      scope: [],
    });
    const failed = records.flatMap((c, i) => results[i].isError ? [c ? `협의 ${c.id}: ${c.status}` : `${tasks[i].to}: 배정 실패`] : []);
    return { ...textResult(`[작업자 통합 보고 · 취합 ${task.to}]\n${combined.content.map(c => c.text).join("\n")}\n배정 ${tasks.length}건 · 실패 ${failed.length}건${failed.length ? ` (${failed.join(", ")})` : ""}`, !!combined.isError || failed.length > 0), structuredContent: { consultIds: [...consultIds, combined.structuredContent?.consultId].filter(id => typeof id === "number") } };
  }

  private async waitForMasterConsult(chatId: number, result: Promise<ToolResult>): Promise<ToolResult> {
    const waiters = this.masterConsultWaiters.get(chatId) ?? new Set<(note?: string) => void>();
    this.masterConsultWaiters.set(chatId, waiters);
    let wake!: (note?: string) => void;
    const followup = new Promise<ToolResult>((resolve) => {
      wake = (note) => resolve(textResult(this.stopped.has(chatId)
        ? "사용자가 작업을 중지했습니다. 멈추세요."
        : (note ? `[그룹 채팅·상태 점검으로 대기 해제]\n${note}\n기존 작업자는 계속 실행 중입니다. check_agent와 read_messages로 확인하고 기존 작업을 중복 배정하지 마세요.` : "사용자의 즉시 추가 요청을 처리하도록 협의 결과 대기만 해제했습니다. 기존 작업자는 중지하지 않았으며 결과는 저장됩니다. 먼저 사용자 질문에 직접 답하고, 수정 요청에는 반영 방법을 먼저 말하세요. 완료한 작업을 중복 배정하지 말고 이후 agents로 결과를 확인하세요.")));
      waiters.add(wake);
    });
    try { return await Promise.race([result, followup]); }
    finally {
      waiters.delete(wake);
      if (!waiters.size && this.masterConsultWaiters.get(chatId) === waiters) this.masterConsultWaiters.delete(chatId);
    }
  }

  private wakeMasterConsults(chatId: number, note?: string) {
    for (const wake of this.masterConsultWaiters.get(chatId) ?? []) wake(note);
  }

  // ---------- team
  private agentsText(chatId: number, includeResults = false): string {
    const list = this.agents(chatId);
    if (!list.length) return "아직 작업자가 없습니다. spawn으로 만드세요.";
    const busy = this.running.get(chatId);
    const instructionId = this.instructions.get(chatId)?.id;
    const consults = includeResults && instructionId !== undefined ? this.chats.store.listConsults(chatId).filter((c) => c.instructionId === instructionId) : [];
    return list
      .map((a) => {
        const r = busy?.get(a.key);
        const state = a.status === "released" ? "해제됨" : r ? `작업 중 (${CONSULT_KIND_LABEL[r.kind]}${r.scope.length ? ` · ${r.scope.join(", ")}` : ""}) · 마지막 활동 ${Math.floor((Date.now() - r.lastEventAt) / 1000)}초 전 · 도구 ${r.tools?.size ?? 0}개${r.lastError ? ` · 오류=${r.lastError}` : ""} · check_agent로 언제든 재점검 가능` : "대기";
        const latest = consults.findLast((c) => c.toRole === a.key);
        const result = latest ? `\n  최근 ${consultStatusText(latest)}` : "";
        const cli = this.chats.roleAccount(chatId, a.key);
        const cliInfo = this.cliAccountText(chatId, cli, r?.cliAccountId, true);
        const failover = r?.attempts?.length ? ` · 우선 할당: ${r.attempts.map(x => `${x.accountId} 실패(${PRIORITY_FAILURE_LABEL[x.reason]})`).join(" → ")}${r.failover ? ` → ${r.failover}` : ""}` : "";
        return `- ${a.nickname} (${WORKER_KIND_LABEL[a.kind]}) · ${a.job || "역할 미정"} · ${state}${cliInfo ? ` · ${cliInfo}${failover} · 최근 세션 계정=${a.sessionAccountId ?? "없음"}` : ""}${result}`;
      })
      .join("\n");
  }

  private cliAccountsInfo(chatId: number, kind?: CliAccountKind) {
    const project = this.chats.store.project(this.chats.store.chat(chatId)!.projectId)!;
    const policies = Object.fromEntries((kind ? [kind] : CLI_ACCOUNT_KINDS).map(k => {
      const policy = this.chats.resolveAccountPolicy(k, project.settings);
      // priority: the order and why each account would be passed over right now.
      return [k, policy.mode === "priority" ? { ...policy, priorityState: this.chats.priorityCandidates(policy.order ?? []).map(c => ({ accountId: c.accountId, skip: c.skip ?? null })) } : policy];
    })) as Record<CliAccountKind, ResolvedCliAccount>;
    const accounts = this.chats.listCliAccounts(kind).map(a => ({
      accountId: a.accountId, kind: a.kind, label: a.label, enabled: a.enabled, isDefault: a.isDefault,
      authStatus: a.authStatus, authCheckedAt: a.auth?.checkedAt ?? null,
      remainingPercent: cliRemaining(a) ?? null, checkedAt: a.usage?.checkedAt ?? null,
      runningWorkers: a.runningWorkers,
      workers: [...this.running].flatMap(([id, roles]) => [...roles].filter(([, r]) => r.cliAccountId === a.accountId)
        .map(([role, r]) => ({ chatId: id, nickname: this.name(id, role), role, consultId: r.consultId,
          assignedAccountId: this.chats.roleAccount(id, role)?.accountId ?? null, executedAccountId: r.cliAccountId }))),
    }));
    return { accounts, policies };
  }

  private cliAccountText(chatId: number, selected: ResolvedCliAccount | null, executed?: CliAccountId, pending = false, configuredPolicy?: ResolvedCliAccount): string {
    if (!selected) return "";
    if (selected.source === "default" && this.chats.listCliAccounts(selected.kind).length === 1 && (!executed || executed === defaultCliAccountId(selected.kind))) return "";
    const settings = this.chats.store.project(this.chats.store.chat(chatId)!.projectId)!.settings;
    const policy = configuredPolicy ?? this.chats.resolveAccountPolicy(selected.kind, settings);
    const quota = this.chats.getCliAccount(executed ?? selected.accountId);
    const remaining = cliRemaining(quota);
    return `지정 계정=${selected.accountId} · ${pending ? "현재 실행 계정" : "실제 실행 계정"}=${executed ?? (pending ? "없음" : "연결 전 실패/중지")} · 모드=${selected.mode} · 출처=${selected.source} · 정책 출처=${policy.source} · 정책 계정=${policy.accountId} · 잔여=${remaining === undefined ? "미확인" : `${remaining}%`} · 사용량 조회=${quota?.usage?.checkedAt ?? "미조회"}${selected.mode === "auto" ? " · auto 자동 선택 없음: cli_accounts 확인 후 accountId 지정" : ""}${selected.mode === "priority" ? ` · 우선 순서=${(selected.order ?? []).join(">")}${selected.note ? ` · ${selected.note}` : ""}${selected.unavailable ? ` · 사용 가능 계정 없음: ${selected.unavailable}` : ""}` : ""}`;
  }

  private selectedCliAccount(chatId: number, kind: CliAccountKind, value: unknown, clear?: unknown): CliAccountId | null | undefined {
    if (clear !== undefined && typeof clear !== "boolean") throw new Error("clearAccountId는 boolean이어야 합니다.");
    if (value !== undefined && clear !== undefined) throw new Error("accountId와 clearAccountId는 동시에 지정할 수 없습니다.");
    if (clear === true || value === null) return null;
    if (value === undefined) return undefined;
    const settings = this.chats.store.project(this.chats.store.chat(chatId)!.projectId)!.settings;
    const policy = this.chats.resolveAccountPolicy(kind, settings);
    if (isCliAccountId(value) && value.startsWith(`${kind}-`) && policy.mode === "fixed" && policy.source !== "default" && value !== policy.accountId)
      throw new Error(`사용자가 fixed로 지정한 계열입니다. 정책 변경을 사용자에게 요청하세요. (${kind}: ${policy.source} 정책 계정=${policy.accountId})`);
    return this.chats.assertCliAccount(value, kind).accountId;
  }

  private spawn(chatId: number, kind: WorkerKind, job: string, requestedCliAccount?: unknown, clearCliAccount?: unknown): ToolResult {
    const chat = this.chats.store.chat(chatId)!;
    const project = this.chats.store.project(chat.projectId)!;
    if (this.planning.has(chatId)) return textResult("지금은 계획 모드입니다. 작업자를 만들지 말고 계획만 세우세요.", true);
    const cliKind = cliAccountKindForAgent(WORKER_AGENT[kind]);
    if ((requestedCliAccount !== undefined || clearCliAccount !== undefined) && !cliKind) return textResult("accountId는 Claude/Codex/Antigravity/Grok CLI 작업자에게만 지정할 수 있습니다.", true);
    const cliAccount = cliKind ? this.selectedCliAccount(chatId, cliKind, requestedCliAccount, clearCliAccount) : undefined;
    if (!this.chats.cliInfo().find((c) => c.agent === WORKER_AGENT[kind])?.path)
      return textResult(`${WORKER_KIND_LABEL[kind]} CLI가 설치되지 않았습니다. 사용 가능한 작업자를 선택하거나 미완료 사유를 보고하세요.`, true);
    const max = kind === "claude" ? project.settings.maxClaudeWorkers : kind === "gpt" ? project.settings.maxGptWorkers : kind === "grok" ? project.settings.maxGrokWorkers : kind === "deepseek" ? project.settings.maxDeepseekWorkers : project.settings.maxGeminiWorkers;
    if (max === 0) return textResult(`${WORKER_KIND_LABEL[kind]}는 사용자가 비활성화했습니다.`, true);
    const a = this.chats.store.createAgent(chatId, kind, job);
    if (cliAccount !== undefined) this.chats.setWorkerAccount(chatId, a.key, cliAccount);
    const cliInfo = this.cliAccountText(chatId, this.chats.roleAccount(chatId, a.key), undefined, true);
    this.chats.agentsChanged(chatId);
    this.chats.emit(chatId, "orch", "orch", { type: "notice", text: `${a.nickname} 합류${job ? ` · ${job}` : ""}` });
    return textResult(`${a.nickname}이(가) 준비되었습니다. ask(to="${a.nickname}")로 일을 맡기세요. 이전 기록이 있으면 유지됩니다.${cliInfo ? `\n[CLI ${cliInfo}]` : ""}`);
  }

  private folderOf(chatId: number): string | undefined {
    const chat = this.chats.store.chat(chatId);
    return chat ? this.chats.store.project(chat.projectId)?.folder : undefined;
  }

  /** Write ranges the user approved for the running plan: its tasks' scopes and any extension the user allowed. */
  private planScopeUnion(chatId: number): string[] | undefined {
    const plan = this.approvedPlan(chatId);
    if (!plan) return undefined;
    return [...new Set([...plan.tasks.flatMap((t) => t.scope ?? []), ...(plan.extended ?? [])])];
  }

  /** Globs of `scope` outside what the running plan allows (`limit` narrows it to one task's range). */
  private outsidePlan(chatId: number, scope: readonly string[], limit?: readonly string[]): string[] {
    const plan = this.approvedPlan(chatId);
    if (!plan) return [];
    const allowed = [...(limit ?? this.planScopeUnion(chatId) ?? []), ...(plan.extended ?? [])];
    return scope.filter((g) => !globWithin(g, allowed));
  }

  /** Why a file change falls outside the running plan's approved ranges, or null (no plan / inside). */
  private writesOutsidePlan(chatId: number, input: ApprovalInput): string | null {
    const cap = this.planScopeUnion(chatId);
    const folder = this.folderOf(chatId);
    if (!cap || !folder) return null;
    const paths = [...(input.paths ?? []), ...(input.diffs?.flatMap((d) => d.movePath ? [d.path, d.movePath] : [d.path]) ?? [])];
    const outside = paths.map((p) => relative(folder, resolvePath(folder, p)).replace(/\\/g, "/")).filter((rel) => rel.startsWith("..") || isAbsolute(rel) || !inScope(rel, cap)); // a real path: glob matching, not glob containment
    if (!outside.length) return null;
    return `승인된 계획의 범위(${cap.join(", ") || "파일 수정 없음"}) 밖의 파일 변경입니다: ${[...new Set(outside)].join(", ")}. 범위를 넓혀야 하면 마스터가 extend_plan_scope로 사용자 승인을 받아야 합니다.`;
  }

  private saveApprovedPlan(chatId: number, plan: ApprovedPlan) {
    this.chats.store.setSetting(`approvedPlan:${chatId}`, JSON.stringify(plan));
  }

  /** The task definitions fixed when the user approved the plan now running (persisted for recovery). */
  private approvedPlan(chatId: number): ApprovedPlan | undefined {
    const planId = this.planRunning.get(chatId);
    if (planId === undefined) return undefined;
    try {
      const saved = JSON.parse(this.chats.store.getSetting(`approvedPlan:${chatId}`) ?? "null");
      if (saved?.planId === planId && Array.isArray(saved.tasks)) return saved;
    } catch { /* fall back to the plan as recorded */ }
    return undefined;
  }

  /**
   * Keeps the approved structure of the running plan: a checklist or native list may change a task's status
   * (and add supplement steps), not its kind, family, owner, scope, group, dependencies or criterion.
   */
  private lockApproved(chatId: number, steps: PlanStep[]): PlanStep[] {
    const approved = this.approvedPlan(chatId);
    if (!approved) return steps;
    const byId = new Map(approved.tasks.filter((t) => t.id && t.kind).map((t) => [t.id!, t]));
    return steps.map((s) => {
      const a = s.id ? byId.get(s.id) : undefined;
      if (!a) return s;
      const fixed: PlanStep = { ...s, title: a.title };
      for (const key of ["kind", "agentKind", "scope", "group", "done", "reviewOf", "dependsOn"] as const) {
        if (a[key] === undefined) delete fixed[key];
        else (fixed as any)[key] = Array.isArray(a[key]) ? [...(a[key] as string[])] : a[key];
      }
      if (a.owner) fixed.owner = a.owner;
      return fixed;
    });
  }

  /** Restores a planning turn's version and submission after a pause or restart. */
  private restorePlanTurn(chatId: number, version?: number, submitted?: boolean) {
    if (version !== undefined) this.planVersions.set(chatId, version); else this.planVersions.delete(chatId);
    if (submitted) this.planSubmitted.add(chatId); else this.planSubmitted.delete(chatId);
  }

  /**
   * After a pause or restart, matches the running plan's in-progress steps to their stored assignments:
   * a finished consult completes its step; a step whose work ended or never started goes back to pending.
   * Steps in `resuming` are being continued by a resumed assignment and stay as they are.
   */
  private reconcilePlanSteps(chatId: number, resuming: ReadonlySet<string> = new Set()) {
    const planId = this.planRunning.get(chatId);
    if (planId === undefined) return;
    const steps = planStepsFor(this.chats.store.events(chatId), planId);
    if (!steps?.some((s) => s.status === "inProgress")) return;
    const consults = this.chats.store.listConsults(chatId);
    const linked = (taskId: string) => consults.filter((c) => c.id && this.chats.store.consultAssignment(c.id)?.planTask?.taskId === taskId && this.chats.store.consultAssignment(c.id)?.planTask?.planId === planId);
    let changed = false;
    const next = steps.map((s) => {
      if (s.status !== "inProgress" || !s.id || resuming.has(s.id)) return s;
      const last = linked(s.id).at(-1);
      const status: PlanStep["status"] = last?.status === "done" ? "completed" : "pending";
      changed = true;
      return { ...s, status, ...(last ? { consultIds: [...new Set([...(s.consultIds ?? []), last.id])] } : {}) };
    });
    if (changed) this.chats.emit(chatId, "orch", "orch", { type: "plan_update", steps: next, planId, instructionId: this.instructions.get(chatId)?.id });
  }

  /** A plan task's approved kind and scope fill an assignment that leaves them out. */
  private withPlanDefaults(chatId: number, caller: Role, args: any): any {
    if (caller !== "orch" || typeof args?.planTaskId !== "string") return args;
    const plan = this.approvedPlan(chatId);
    const task = plan?.tasks.find(t => t.id === args.planTaskId);
    if (!task) return args;
    // The task's current range (narrowed by amend_scope) carries over to a retry.
    const scope = plan!.effective?.[task.id!] ?? task.scope;
    return { ...args, ...(args.kind === undefined && task.kind ? { kind: task.kind } : {}), ...(args.scope === undefined && scope ? { scope: [...scope] } : {}) };
  }

  /** Plan-task problems that refuse an assignment before anything starts (scope problems only warn). */
  private assignmentIssue(chatId: number, caller: Role, args: any, target?: ChatAgent): string | null {
    const issues: string[] = [];
    if (args?.planTaskId !== undefined) {
      const planId = this.planRunning.get(chatId);
      if (caller !== "orch" || typeof args.planTaskId !== "string") issues.push("planTaskId는 마스터가 계획 작업 id 문자열로 지정합니다.");
      else if (planId === undefined) issues.push("승인된 계획을 실행 중일 때만 planTaskId를 지정할 수 있습니다.");
      else {
        const steps = planStepsFor(this.chats.store.events(chatId), planId) ?? [];
        const step = steps.find(s => s.id === args.planTaskId);
        const approved = this.approvedPlan(chatId)?.tasks.find(t => t.id === args.planTaskId);
        if (!step) issues.push(`계획에 없는 작업 id입니다: ${args.planTaskId}`);
        else if (step.status !== "pending") issues.push(`계획 작업 ${step.id}은(는) 이미 ${step.status === "inProgress" ? "진행 중" : step.status === "completed" ? "완료" : "취소"}입니다. 다시 맡기려면 checklist로 pending으로 되돌리세요.`);
        else {
          const blockers = planStepBlockers(step, steps);
          if (blockers.length) issues.push(`계획 작업 ${step.id}의 선행 ${blockers.map(b => b.id).join(", ")}이(가) 끝나지 않았습니다.`);
          const open = steps.filter(s => isOpenStep(s) && s.group !== undefined).map(s => s.group!);
          if (step.group !== undefined && open.length && Math.min(...open) < step.group)
            issues.push(`계획 작업 ${step.id}은(는) group ${step.group}입니다. 앞 group ${Math.min(...open)}의 작업이 끝나거나 취소된 뒤 맡기세요.`);
        }
        // The approved definition is fixed: an assignment for it must match what the user approved.
        if (approved) {
          const kind = KINDS.includes(args.kind) ? args.kind : "implement";
          if (approved.kind && kind !== approved.kind) issues.push(`계획 작업 ${approved.id}의 승인된 종류는 ${approved.kind}입니다(요청: ${kind}).`);
          if (target && approved.agentKind && target.kind !== approved.agentKind) issues.push(`계획 작업 ${approved.id}의 승인된 담당 계열은 ${WORKER_KIND_LABEL[approved.agentKind]}입니다(요청: ${target.nickname}).`);
          if (target && approved.owner && target.nickname !== approved.owner) issues.push(`계획 작업 ${approved.id}의 승인된 담당은 ${approved.owner}입니다(요청: ${target.nickname}).`);
          // A narrower range (e.g. after amend_scope) is fine; anything beyond the approved one is not.
          const scope: string[] = Array.isArray(args.scope) ? [...new Set<string>(args.scope.map(String).filter(Boolean))] : [];
          const outside = this.outsidePlan(chatId, scope, approved.scope ?? []);
          if (outside.length) issues.push(`계획 작업 ${approved.id}의 승인된 범위(${(approved.scope ?? []).join(", ") || "파일 변경 없음"}) 밖입니다: ${outside.join(", ")}. scope를 생략하면 현재 범위로 맡깁니다. 넓혀야 하면 extend_plan_scope로 사용자 승인을 받으세요.`);
        }
      }
    } else if (Array.isArray(args?.scope)) {
      // Supplement work (fixes, retries, checks), by the master or one worker asking another, stays inside
      // what the user approved for the plan.
      const outside = this.outsidePlan(chatId, args.scope.map(String).filter(Boolean));
      if (outside.length) issues.push(`승인된 계획의 범위 밖입니다: ${outside.join(", ")}. 계획 범위(${(this.planScopeUnion(chatId) ?? []).join(", ") || "파일 수정 없음"}) 안에서 맡기거나, extend_plan_scope(scope, reason)로 사용자 승인을 받은 뒤 다시 배정하세요.`);
    }
    return issues.length ? issues.join("\n") : null;
  }

  /** Assignments outside the approved plan are supplements (fixes, retries, checks): allowed, with a reminder. */
  private planSupplementNote(chatId: number, args: any): string {
    if (typeof args?.planTaskId === "string" || this.planRunning.get(chatId) === undefined) return "";
    const ready = readyGroupSteps(planStepsFor(this.chats.store.events(chatId), this.planRunning.get(chatId)!) ?? []);
    return ready.length ? `[계획 보완 작업으로 맡겼습니다] 승인된 계획에 아직 시작 가능한 작업(${ready.map(s => s.id).join(", ")})이 남았습니다. 계획 작업은 planTaskId를 지정해 맡기세요.` : "";
  }

  /** Narrow gate for a single master ask that should have been one ask_parallel. */
  private singleAskIssue(chatId: number, args: any): string | null {
    const inst = this.instructions.get(chatId);
    if (inst?.mode === "delegated" && inst.split === "parallel" && !this.chats.store.listConsults(chatId).some(c => c.instructionId === inst.id))
      return "route_request에서 split=parallel로 기록했습니다. 첫 배정은 서로 독립인 작업들을 ask_parallel(tasks=[{to, kind, message, scope, reason}, …]) 한 번으로 맡기세요. 실제로 맡길 일이 하나뿐이면 route_request(mode=delegated, split=single, reason)로 다시 기록한 뒤 ask를 쓰세요.";
    const planId = this.planRunning.get(chatId);
    // Too few workers for the whole group: an explicit reason lets the group run one task at a time.
    const sequential = typeof args?.sequentialReason === "string" && args.sequentialReason.trim();
    if (planId !== undefined && typeof args?.planTaskId === "string" && !sequential) {
      const ready = readyGroupSteps(planStepsFor(this.chats.store.events(chatId), planId) ?? []);
      if (ready.length >= 2 && ready.some(s => s.id === args.planTaskId))
        return `계획 group ${ready[0].group}에서 지금 시작할 수 있는 작업이 ${ready.length}개입니다(${ready.map(s => s.id).join(", ")}). ask를 하나씩 부르지 말고 ask_parallel(tasks=[{to, kind, message, scope, reason, planTaskId}, …]) 한 번으로 함께 맡기세요. 가용 작업자가 부족해 하나씩 처리해야 하면 ask에 sequentialReason(이유)을 적으세요.`;
    }
    if (sequential && planId !== undefined) this.chats.emit(chatId, "orch", "orch", { type: "notice", text: `계획 작업 ${String(args.planTaskId ?? "")}을(를) 순차로 맡깁니다: ${sequential}` });
    return null;
  }

  /** Changes one step of the approved plan being carried out (app bookkeeping for planTaskId). */
  private updatePlanStep(chatId: number, ref: PlanTaskRef, change: (step: PlanStep) => PlanStep) {
    const { planId, taskId } = ref;
    const steps = planStepsFor(this.chats.store.events(chatId), planId);
    if (!steps?.some(s => s.id === taskId && s.status !== "cancelled")) return;
    const next = steps.map(s => s.id === taskId ? change({ ...s }) : s);
    this.chats.emit(chatId, "orch", "orch", { type: "plan_update", steps: next, planId, instructionId: this.instructions.get(chatId)?.id });
  }

  private proposePlan(chatId: number, args: any): ToolResult {
    const inst = this.instructions.get(chatId);
    if (!this.planning.has(chatId) || !inst) return textResult("propose_plan은 계획 모드에서만 씁니다. 지금은 checklist로 진행 단계를 관리하세요.", true);
    const summary = String(args?.summary ?? "").trim();
    if (!summary) return textResult("summary에 계획 요약을 적으세요.", true);
    let steps: PlanStep[];
    try { steps = validateProposedTasks(args?.tasks); } catch (e) { return textResult(`계획을 받지 않았습니다: ${e instanceof Error ? e.message : String(e)}`, true); }
    const folder = this.folderOf(chatId);
    const project = this.chats.store.project(this.chats.store.chat(chatId)!.projectId)!;
    const problems: string[] = [];
    const warnings = steps.flatMap((s) => scopeWarnings(folder, s.scope).map((w) => `${s.id} ${w}`));
    for (const s of steps) {
      const kind = s.agentKind!;
      const max = kind === "claude" ? project.settings.maxClaudeWorkers : kind === "gpt" ? project.settings.maxGptWorkers : kind === "grok" ? project.settings.maxGrokWorkers : kind === "deepseek" ? project.settings.maxDeepseekWorkers : project.settings.maxGeminiWorkers;
      if (max === 0) problems.push(`${s.id}: ${WORKER_KIND_LABEL[kind]}는 사용자가 비활성화했습니다.`);
      if (s.owner) {
        const owner = this.agents(chatId).find(a => a.nickname === s.owner);
        if (!owner || owner.status !== "active") problems.push(`${s.id}: owner ${s.owner}은(는) ${owner ? "해제된" : "없는"} 작업자입니다. 실행 때 확보할 작업자라면 owner를 비우고 agentKind만 적으세요.`);
        else if (owner.kind !== kind) problems.push(`${s.id}: owner ${s.owner}은(는) ${WORKER_KIND_LABEL[owner.kind]} 작업자라 agentKind=${kind}와 다릅니다.`);
      }
    }
    // One worker runs one turn at a time: the same owner twice in a group would not run in parallel.
    for (const s of steps) {
      const twin = steps.find((t) => t !== s && t.owner && t.owner === s.owner && t.group === s.group);
      if (twin && steps.indexOf(twin) > steps.indexOf(s)) problems.push(`${s.id}와 ${twin.id}는 같은 group ${s.group}에 같은 owner ${s.owner}입니다. 담당을 나누거나 group을 나누세요.`);
    }
    for (let i = 0; i < steps.length; i++) for (let j = i + 1; j < steps.length; j++) {
      const a = steps[i], b = steps[j];
      if (a.group === b.group && a.scope?.length && b.scope?.length && scopesOverlap(a.scope, b.scope))
        problems.push(`${a.id}와 ${b.id}는 같은 group ${a.group}인데 scope가 겹칩니다. 범위를 나누거나 group을 나누세요.`);
    }
    if (problems.length) return textResult(`계획을 받지 않았습니다. 고쳐서 다시 제출하세요.\n${problems.join("\n")}`, true);
    this.chats.emit(chatId, "orch", "orch", { type: "plan_update", steps, explanation: summary, planId: inst.id, instructionId: inst.id });
    this.planSubmitted.add(chatId);
    // A finished plan ends plan mode, and the app itself asks the user how to go on.
    if (this.chats.store.chat(chatId)?.planMode) this.chats.updateChat(chatId, { planMode: false });
    const version = this.planVersions.get(chatId) ?? 1;
    // A revision request is already waiting for this turn's end: no new approval card meanwhile.
    if (!this.revisionHold.get(chatId)?.length) this.askPlanConfirm(chatId, version, steps.length);
    const groups = [...new Set(steps.map(s => s.group))].length;
    return textResult(`계획 v${version}(작업 ${steps.length}개 · group ${groups}개)을 제출했습니다. 앱이 사용자에게 [진행/수정/취소]를 물었습니다. 사용자에게 계획을 두세 문장으로 요약하고 턴을 끝내세요. 진행을 고르면 앱이 바로 group별 실행을 시작합니다.` +
      (warnings.length ? `\n[범위 경고]\n${warnings.join("\n")}\n새로 만들 경로가 아니면 scope를 고쳐 propose_plan을 다시 제출하세요.` : ""));
  }

  private async waitResults(chatId: number, ids: unknown, timeout?: unknown): Promise<ToolResult> {
    const inst = this.instructions.get(chatId);
    if (!inst) return textResult("진행 중인 사용자 지시가 없습니다.", true);
    if (ids !== undefined && (!Array.isArray(ids) || ids.some(id => !Number.isSafeInteger(id)))) return textResult("consultIds는 협의 id(정수) 목록이어야 합니다.", true);
    if (timeout !== undefined && (!Number.isSafeInteger(timeout) || (timeout as number) < 1)) return textResult("timeoutSec은 1 이상의 정수(초)여야 합니다.", true);
    const limitSec = Math.min((timeout as number | undefined) ?? WAIT_DEFAULT_SEC, WAIT_MAX_SEC);
    const limitMs = limitSec * 1000 * this.waitTimeScale;
    const wanted = ids as number[] | undefined;
    const targets = () => this.chats.store.listConsults(chatId).filter(c => wanted ? wanted.includes(c.id) && c.chatId === chatId : c.instructionId === inst.id);
    if (wanted && targets().length !== new Set(wanted).size) return textResult("이 채팅에 없는 협의 id가 있습니다.", true);
    // Waiting cannot help while the user owes an approval or an answer: say so at once.
    const userWait = () => {
      const approvals = this.chats.approvals.pendingCount(chatId);
      const questions = [...this.asks.values()].filter(a => a.chatId === chatId && !a.keepStatus).length;
      return approvals || questions ? `[사용자 응답 대기] ${[approvals && `승인 요청 ${approvals}건`, questions && `질문 ${questions}건`].filter(Boolean).join(", ")}이(가) 사용자의 답을 기다립니다. 결과를 계속 기다리지 말고 사용자에게 필요한 응답을 알리세요.` : "";
    };
    const report = (head = "") => {
      const list = targets();
      const running = list.filter(c => c.status === "running");
      return textResult([head, list.length ? list.map(c => consultStatusText(c)).join("\n") : "이번 지시에 맡긴 협의가 없습니다.", running.length && head ? `아직 실행 중: ${running.map(c => c.id).join(", ")}` : ""].filter(Boolean).join("\n"));
    };
    if (!targets().some(c => c.status === "running")) return report();
    if (userWait()) return report(userWait());
    const epoch = this.epochs.get(chatId);
    const deadline = Date.now() + limitMs;
    let woken = false;
    const settled = (async () => {
      for (;;) {
        if (woken || this.stopped.has(chatId) || this.epochs.get(chatId) !== epoch || !targets().some(c => c.status === "running")) return report();
        const waiting = userWait();
        if (waiting) return report(waiting);
        if (Date.now() >= deadline) return report(`[대기 제한 ${limitSec}초 경과] 일부 협의가 아직 끝나지 않았습니다. check_agent로 확인하거나 다시 wait_results로 기다리세요.`);
        await new Promise(resolve => setTimeout(resolve, this.waitPollMs));
      }
    })();
    try { return await this.waitForMasterConsult(chatId, settled); }
    finally { woken = true; }
  }

  /** How often wait_results rechecks stored consult status, and a scale for its time limit (tests shorten both). */
  waitPollMs = 1000;
  waitTimeScale = 1;

  private amendScope(chatId: number, to: string, raw: unknown, reason: string): ToolResult {
    const target = this.agents(chatId).find(a => (a.nickname === to.trim() || a.key === to.trim()) && a.status === "active");
    const running = target && this.running.get(chatId)?.get(target.key);
    if (!target || !running) return textResult("범위를 정정할 실행 중인 작업자를 지정하세요.", true);
    if (!reason.trim()) return textResult("reason에 정정 이유를 적으세요.", true);
    if (!Array.isArray(raw) || !raw.length || raw.some(g => typeof g !== "string" || !g.trim())) return textResult("scope는 경로 glob 문자열 목록이어야 합니다.", true);
    const scope = [...new Set((raw as string[]).map(g => g.trim()))];
    const warnings = scopeWarnings(this.folderOf(chatId), scope);
    // Under an approved plan a correction stays inside the task's approved range (or the plan's for a supplement).
    const plan = this.approvedPlan(chatId);
    if (plan) {
      const task = running.planTask && plan.tasks.find((t) => t.id === running.planTask!.taskId);
      const outside = this.outsidePlan(chatId, scope, task ? task.scope ?? [] : undefined);
      if (outside.length) return textResult(`승인된 ${task ? `계획 작업 ${task.id}의` : "계획의"} 범위 밖이라 바꾸지 않았습니다: ${outside.join(", ")}. 넓혀야 하면 extend_plan_scope(scope, reason)로 사용자 승인을 받은 뒤 다시 정정하세요.`, true);
    }
    const held = this.scopeLocks.get(chatId) ?? [];
    const conflict = held.find(h => !h.command && h.consultId !== running.consultId && scopesOverlap(h.scope, scope));
    if (conflict) return textResult(`협의 ${conflict.consultId}가 잡은 범위(${conflict.scope.join(", ") || "작업 폴더 전체"})와 겹쳐 바꾸지 않았습니다.`, true);
    const previous = running.scope;
    running.scope = scope;
    const lock = held.find(h => h.consultId === running.consultId && !h.command);
    if (lock) lock.scope = scope;
    // The stored assignment and the pause/resume copy carry the same range, so a resume keeps the correction.
    const saved = this.chats.store.setConsultScope(running.consultId, scope);
    if (saved) this.chats.sink.consult(saved);
    for (const a of this.assignments.get(chatId)?.values() ?? []) if (a.consultId === running.consultId) a.scope = [...scope];
    // A plan task keeps its corrected range for retries (supersedes), below the approved upper bound.
    if (plan && running.planTask) this.saveApprovedPlan(chatId, { ...plan, effective: { ...(plan.effective ?? {}), [running.planTask.taskId]: [...scope] } });
    // Writers waiting on the old range may fit now.
    const waiters = this.scopeWaiters.get(chatId) ?? [];
    this.scopeWaiters.set(chatId, []);
    for (const wake of waiters) wake();
    const text = `[범위 정정] 협의 ${running.consultId}에서 고칠 수 있는 범위가 ${scope.join(", ")}(으)로 바뀌었습니다(이전: ${previous.join(", ") || "지정 없음"}). 사유: ${reason.trim()}`;
    this.chats.emit(chatId, this.chats.route(chatId, target.key), "orch", { type: "peer_message", from: "orch", to: target.key, text });
    void this.deliverMessages(chatId, target.key);
    this.chats.emit(chatId, "orch", "orch", { type: "notice", text: `${target.nickname} 작업 범위 정정: ${scope.join(", ")}` });
    return textResult(`${target.nickname}의 협의 ${running.consultId} 범위를 바꾸고 알렸습니다. 이미 거절된 편집은 작업자가 다시 시도해야 합니다.${warnings.length ? `\n[범위 경고]\n${warnings.join("\n")}` : ""}`);
  }

  /**
   * The only way past the approved plan's write ranges: the app itself asks the user (not the master's
   * wording) and records just the ranges the user allowed.
   */
  private async extendPlanScope(chatId: number, raw: unknown, reason: string): Promise<ToolResult> {
    const plan = this.approvedPlan(chatId);
    if (!plan) return textResult("승인된 계획을 실행 중일 때만 범위 확대를 요청할 수 있습니다. 일반 실행에는 계획 범위 제한이 없습니다.", true);
    if (!reason.trim()) return textResult("reason에 확대가 필요한 이유를 적으세요.", true);
    if (!Array.isArray(raw) || !raw.length || raw.some((g) => typeof g !== "string" || !g.trim())) return textResult("scope는 경로 glob 문자열 목록이어야 합니다.", true);
    const wanted = [...new Set((raw as string[]).map((g) => g.trim()))];
    const outside = this.outsidePlan(chatId, wanted);
    if (!outside.length) return textResult("요청한 범위는 이미 승인된 계획 범위 안입니다. 그대로 맡기세요.");
    const answer = await this.askUser(chatId, `[계획 범위 확대 요청] 승인된 계획 밖의 파일을 고치려 합니다.\n추가 범위: ${outside.join(", ")}\n이유: ${reason.trim()}\n허용하면 이 범위의 수정이 이번 계획 실행 동안 허용됩니다.`, ["허용", "거부"]);
    if (answer.trim() !== "사용자 답변: 허용") return textResult(`사용자가 범위 확대를 허용하지 않았습니다(${answer}). 승인된 계획 범위 안에서 진행하거나 사용자에게 보고하세요.`);
    const current = this.approvedPlan(chatId);
    if (!current || current.planId !== plan.planId) return textResult("그사이 계획 실행이 끝나 범위를 기록하지 않았습니다.", true);
    this.saveApprovedPlan(chatId, { ...current, extended: [...new Set([...(current.extended ?? []), ...outside])] });
    this.chats.emit(chatId, "orch", null, { type: "notice", text: `사용자가 계획 범위 확대를 허용했습니다: ${outside.join(", ")}` });
    return textResult(`사용자가 허용했습니다. 이제 ${outside.join(", ")} 범위로 배정하거나 amend_scope로 정정할 수 있습니다.`);
  }

  /** Plan mode toggle (stored on the chat): the next idle send plans instead of running. */
  setPlanMode(chatId: number, on: boolean) {
    const chat = this.chats.store.chat(chatId);
    if (!chat) throw new Error("채팅이 없습니다.");
    if (!!chat.planMode !== on) this.chats.updateChat(chatId, { planMode: on });
  }

  private async release(chatId: number, nickname: string): Promise<ToolResult> {
    const a = this.agents(chatId).find((x) => x.nickname === nickname.trim());
    if (!a) return textResult(`그런 작업자가 없습니다: ${nickname}`, true);
    if (a.status === "released") return textResult(`${a.nickname}은(는) 이미 해제되었습니다.`);
    if (this.running.get(chatId)?.has(a.key)) return textResult(`${a.nickname}은(는) 아직 작업 중이라 해제할 수 없습니다.`, true);
    await this.chats.disposeRole(chatId, a.key);
    if (cliAccountKindForAgent(WORKER_AGENT[a.kind])) this.chats.setWorkerAccount(chatId, a.key, null);
    this.chats.store.updateAgent(a.id, { status: "released" });
    this.chats.agentsChanged(chatId);
    this.chats.emit(chatId, "orch", "orch", { type: "notice", text: `${a.nickname} 해제` });
    return textResult(`${a.nickname}을(를) 해제했습니다.`);
  }

  /** The plan a new checklist belongs to: the approved /plan while it runs, otherwise this instruction. */
  private planOwner(chatId: number): { planId?: number; instructionId?: number } {
    const instructionId = this.instructions.get(chatId)?.id;
    return { planId: this.planRunning.get(chatId) ?? instructionId, instructionId };
  }

  private checklist(chatId: number, raw: unknown): ToolResult {
    const { planId, instructionId } = this.planOwner(chatId);
    const previous = planId === undefined ? [] : planStepsFor(this.chats.store.events(chatId), planId) ?? [];
    const kept: string[] = [];
    const steps = this.lockApproved(chatId, validatePlanSteps(raw, previous, kept));
    if (!steps.length) return textResult("steps가 비었습니다.", true);
    const consults = new Map(this.chats.store.listConsults(chatId).map((c) => [c.id, c]));
    const unknown = steps.flatMap((s) => s.consultIds ?? []).filter((id) => !consults.has(id));
    if (unknown.length) return textResult(`이 채팅에 없는 협의 id입니다: ${[...new Set(unknown)].join(", ")}`, true);
    if (planId !== undefined) {
      const dropped = droppedSteps(previous, steps);
      if (dropped.length) return textResult(`끝나지 않았거나 취소된 단계를 목록에서 뺄 수 없습니다: ${dropped.map(stepKey).join(", ")}. 끝냈으면 completed로, 진행하지 않을 단계는 status=cancelled와 cancelReason으로 남기고, 취소된 단계도 목록에 그대로 두세요.`, true);
    }
    this.chats.emit(chatId, "orch", "orch", { type: "plan_update", steps, planId, instructionId });
    const cancelled = steps.filter((s) => s.status === "cancelled").length;
    const head = `체크리스트를 갱신했습니다 (${steps.filter((s) => s.status === "completed").length}/${steps.length} 완료${cancelled ? ` · 취소 ${cancelled}` : ""}).` + (kept.length ? `\n${kept.join("\n")}` : "");
    if (!steps.some((s) => s.dependsOn?.length || s.consultIds?.length)) return textResult(head);
    const label = (s: PlanStep) => s.id ? `${s.id}(${s.title})` : s.title;
    const open = steps.filter(isOpenStep);
    const waiting = open.filter((s) => planStepBlockers(s, steps).length);
    const ready = open.filter((s) => s.status === "pending" && !planStepBlockers(s, steps).length);
    const early = waiting.filter((s) => s.status === "inProgress");
    const failed = steps.flatMap((s) => (s.consultIds ?? []).map((id) => ({ s, c: consults.get(id)! }))).filter(({ c }) => ["error", "limited", "stopped"].includes(c.status));
    return textResult([
      head,
      `시작 가능: ${ready.map(label).join(", ") || "없음"}`,
      `선행 대기: ${waiting.map((s) => `${label(s)} ← ${planStepBlockers(s, steps).map(label).join(", ")}`).join(" / ") || "없음"}`,
      ...(early.length ? [`주의: 선행이 끝나지 않았는데 진행 중으로 표시됨: ${early.map(label).join(", ")}`] : []),
      ...(failed.length ? [`연결 협의 미완료: ${failed.map(({ s, c }) => `협의 ${c.id}(${c.status}) · ${label(s)}`).join(" / ")}`] : []),
      "완료 상태는 앱이 바꾸지 않습니다. 실제 결과를 확인하고 status를 갱신하세요.",
    ].join("\n"));
  }

  // ---------- ask (consult)
  private graph(chatId: number): WaitGraph {
    let g = this.waits.get(chatId);
    if (!g) this.waits.set(chatId, (g = new Map()));
    return g;
  }

  private async askTool(chatId: number, caller: Role, args: any): Promise<ToolResult> {
    args = this.withPlanDefaults(chatId, caller, args);
    if (args.summary !== undefined && (caller !== "orch" || typeof args.summary !== "boolean")) return textResult("summary는 마스터가 지정하는 boolean 옵션입니다.", true);
    const to = String(args.to ?? "").trim();
    const kind: ConsultKind = KINDS.includes(args.kind) ? args.kind : "implement";
    let message = String(args.message ?? "");
    const scope: string[] = Array.isArray(args.scope) ? args.scope.map(String).filter(Boolean) : [];
    const attach: string[] = Array.isArray(args.attach) ? args.attach.map(String) : [];
    const callerName = this.name(chatId, caller);
    const reason = String(args.reason ?? "").trim();
    if (caller === "orch" && !reason) return textResult("작업자를 선택한 이유(reason)를 적으세요.", true);
    if (args.effort !== undefined && (typeof args.effort !== "string" || !args.effort.trim())) return textResult("effort는 모델이 지원하는 추론 수준을 지정하세요.", true);

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
      if (caller !== "orch" && !this.running.get(chatId)?.has(caller)) return textResult("현재 배정받은 작업이 없습니다.", true);
      if (!["opinion", "writing"].includes(kind))
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
      message = `[토의 그룹: ${discussion.topic}]\n진행자: ${target.nickname}\n참여자: ${names.join(", ")}\n각 참여자에게 앱 ask(kind=${kind})로 너의 초안·근거·질문을 직접 보내고 실제 답을 받아 대조하라. 필요하면 후속 질문으로 보완하고 합의·이견·근거·남은 결정을 취합하라. 참여 응답 없이 토의 완료라고 하지 마라. 수정이 필요하면 지정 범위와 승인 절차를 지켜라.\n\n${message}`;
    }
    const parent = this.running.get(chatId)?.get(caller);
    if (parent?.discussion) {
      message = `[토의 주제: ${parent.discussion.topic}]\n${callerName}이(가) 토의를 진행하며 너의 의견을 기다린다. 이번 응답에 반론·근거·확인 질문을 담고 진행자에게 다시 ask하지 마라.\n\n${message}`;
    }
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
    let cliAccount: CliAccountId | null | undefined;
    if (args.accountId !== undefined || args.clearAccountId !== undefined) {
      if (caller !== "orch") return textResult("CLI 계정 지정은 마스터만 할 수 있습니다. 마스터에게 변경을 요청하세요.", true);
      const cliKind = cliAccountKindForAgent(WORKER_AGENT[target.kind]);
      if (!cliKind) return textResult("accountId는 Claude/Codex/Antigravity/Grok CLI 작업자에게만 지정할 수 있습니다.", true);
      cliAccount = this.selectedCliAccount(chatId, cliKind, args.accountId, args.clearAccountId);
      if (cliAccount !== undefined && ([...(this.assignments.get(chatId)?.values() ?? [])].some(a => a.target.key === target.key) || this.chats.liveDriver(chatId, target.key)?.running))
        return textResult("해당 작업자는 실행/대기 중입니다. 완료 후 CLI 계정을 지정하세요.", true);
    }
    const inherited = args.effort ?? (caller === "orch" ? undefined : this.chats.store.consult(this.running.get(chatId)?.get(caller)?.consultId ?? -1)?.effort || undefined);
    if (args.model !== undefined && (typeof args.model !== "string" || !args.model.trim())) return textResult("model은 실제 모델 ID를 지정하세요.", true);
    // Checked last and marked in the same synchronous step, so parallel tasks cannot claim one plan step twice.
    const assignment = this.assignmentIssue(chatId, caller, args, target);
    if (assignment) return textResult(assignment, true);
    const planId = this.planRunning.get(chatId);
    const planTask: PlanTaskRef | undefined = caller === "orch" && typeof args.planTaskId === "string" && planId !== undefined ? { planId, taskId: args.planTaskId } : undefined;
    // Claimed at once (the consult links itself once it starts); a refused start gives the step back.
    if (planTask) this.updatePlanStep(chatId, planTask, (s) => ({ ...s, status: "inProgress", owner: s.owner ?? target.nickname }));
    const supplement = caller === "orch" ? this.planSupplementNote(chatId, args) : "";
    // A scope that matches nothing only warns: new folders and files are normal assignments.
    const warnings = scopeWarnings(this.folderOf(chatId), scope);
    const warning = warnings.length ? `[범위 경고 · ${target.nickname}]\n${warnings.join("\n")}\n${SCOPE_WARNING_HELP}` : "";
    if (warning) this.chats.emit(chatId, "orch", "orch", { type: "notice", text: warning });
    const response = await this.consult(chatId, caller, target, kind, message, scope, attach, reason || (parent?.discussion ? `토의 ${parent.discussion.topic} · ${callerName} → ${target.nickname}` : ""), supersedes, inherited, discussion, false, cliAccount, args.model, planTask);
    if (parent?.discussion && !response.isError) parent.discussionReplies!.add(target.key);
    const id = response.structuredContent?.consultId;
    if (planTask && typeof id !== "number") this.updatePlanStep(chatId, planTask, (s) => (s.status === "inProgress" ? { ...s, status: "pending" } : s));
    const notes = [warning, supplement].filter(Boolean).join("\n");
    const record = caller === "orch" && typeof id === "number" ? this.chats.store.consult(id) : undefined;
    if (record) return { ...response, content: [{ type: "text", text: (args.summary ? masterResultText(record) : consultStatusText(record)) + (response.isError ? `\n원인: ${response.structuredContent?.error ?? "결과를 확인하지 못했습니다."}` : "") + (notes ? `\n${notes}` : "") }] };
    return notes ? { ...response, content: [...response.content, { type: "text", text: notes }] } : response;
  }

  private limitCheck(chatId: number, project: Project, target: Role, kind: ConsultKind, message: string, accountId?: CliAccountId): string | null {
    const inst = this.instructions.get(chatId);
    if (!inst) return null;
    if (this.stopped.has(chatId)) return "사용자가 작업을 중지했습니다. 더 이상 맡기지 말고 멈추세요.";
    if (this.planning.has(chatId)) return "지금은 계획 모드입니다. 작업자에게 맡기지 말고 계획(체크리스트)만 세워 보고하세요.";
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
  /**
   * Ends an unscoped command's short lock when that tool call reports back (done, failed or denied). Without
   * a tool id it ends all of the assignment's command locks (its turn or assignment ended).
   */
  private releaseCommandLock(chatId: number, consultId: number, toolId?: string) {
    const held = this.scopeLocks.get(chatId) ?? [];
    const ends = (h: ScopeLock) => h.consultId === consultId && !!h.command && (toolId === undefined || h.toolId === toolId);
    if (!held.some(ends)) return;
    this.scopeLocks.set(chatId, held.filter((h) => !ends(h)));
    const w = this.scopeWaiters.get(chatId) ?? [];
    this.scopeWaiters.set(chatId, []);
    for (const f of w) f();
  }
  private releaseScope(chatId: number, consultId: number) {
    this.scopeLocks.set(chatId, (this.scopeLocks.get(chatId) ?? []).filter((h) => h.consultId !== consultId));
    const w = this.scopeWaiters.get(chatId) ?? [];
    this.scopeWaiters.set(chatId, []);
    for (const f of w) f();
  }

  private async consult(chatId: number, caller: Role, target: ChatAgent, kind: ConsultKind, message: string, scope: string[], attach: string[], reason: string, supersedes?: number, requestedEffort?: string, discussion?: Discussion, resuming = false, accountChange?: CliAccountId | null, assignmentModel?: string, planTask?: PlanTaskRef): Promise<ToolResult> {
    const epoch = this.epochs.get(chatId);
    const chat = this.chats.store.chat(chatId)!;
    const project = this.chats.store.project(chat.projectId)!;
    const callerName = this.name(chatId, caller);
    const cliKind = cliAccountKindForAgent(WORKER_AGENT[target.kind]);
    let cliPolicy = cliKind ? this.chats.resolveAccountPolicy(cliKind, project.settings) : undefined;
    let cliSelection = accountChange !== undefined && cliPolicy
      ? cliPolicy.mode === "fixed" && cliPolicy.source !== "default" ? cliPolicy
        : cliPolicy.mode === "priority" && accountChange === null ? this.chats.nextPriorityAccount(cliPolicy) ?? { ...cliPolicy, unavailable: this.chats.priorityUnavailable(cliPolicy.order ?? []) }
        : this.chats.resolveAccountPolicy(cliKind!, project.settings, accountChange ?? undefined)
      : this.chats.roleAccount(chatId, target.key);
    if (cliSelection?.unavailable) return textResult(`우선 할당 목록에 지금 사용할 수 있는 ${cliSelection.kind} 계정이 없어 맡기지 않았습니다: ${cliSelection.unavailable}. cli_accounts(refresh=true)로 갱신하거나 사용자에게 계정 상태 확인을 요청하세요.`, true);
    if (cliSelection) this.chats.assertCliAccount(cliSelection.accountId, cliSelection.kind);
    const limited = resuming ? (this.stopped.has(chatId) || this.planning.has(chatId) ? "작업이 중지되었거나 계획 모드입니다." : null) : this.limitCheck(chatId, project, target.key, kind, message, cliSelection?.accountId);
    if (limited) {
      this.chats.emit(chatId, this.chats.route(chatId, caller), caller, { type: "notice", text: `${target.nickname}에게 맡기기 거절 · ${limited.split(".")[0]}` });
      return textResult(limited, true);
    }
    if (accountChange !== undefined) {
      this.chats.setWorkerAccount(chatId, target.key, accountChange);
      target.cliAccountId = accountChange ?? undefined;
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
    const assignment: PausedAssignment = { caller, target, kind, message, scope, attach, reason, effort: requestedEffort, model: assignmentModel, discussion, ...(planTask ? { planTask } : {}) };
    const assignments = this.assignments.get(chatId) ?? new Map();
    assignments.set(assignmentKey, assignment);
    this.assignments.set(chatId, assignments);
    try {
      await prev; // the target finishes its current turn first
      if (assignmentModel) {
        const cfg = this.chats.roleConfig(chat, project, target.key);
        const models = await this.chats.models(cfg.agent, this.chats.roleAccount(chatId, target.key)?.accountId);
        if (!models.some(m => m.id === assignmentModel && !m.deprecated)) return textResult("선택한 작업자 계열과 계정에서 모델을 확인하지 못했습니다.", true);
      }
      const reasoning = await this.chats.assignmentEffort(chatId, target.key, requestedEffort, assignmentModel);
      // Web models have no effective effort; retain the master's valid intent for resume.
      assignment.effort = reasoning.effort || reasoning.requestedEffort;
      if (this.stopped.has(chatId) || this.epochs.get(chatId) !== epoch) return textResult("사용자가 작업을 중지했습니다.", true);
      const attachments = this.attachmentsFor(chatId, attach);
      const consult = this.chats.store.createConsult(chatId, caller, target.key, kind, message, scope, inst?.id, reason, supersedes, reasoning, {
        attach,
        ...(assignmentModel ? { model: assignmentModel } : {}),
        ...(cliSelection?.accountId ? { accountId: cliSelection.accountId } : {}),
        ...(discussion ? { discussion: { topic: discussion.topic, peers: discussion.peers.map((p) => p.nickname) } } : {}),
        ...(planTask ? { planTask } : {}),
      });
      assignment.consultId = consult.id;
      // The plan step is linked when the assignment is created, so a crash or pause never orphans it.
      if (planTask) this.updatePlanStep(chatId, planTask, (s) => ({ ...s, status: "inProgress", owner: s.owner ?? target.nickname, consultIds: [...new Set([...(s.consultIds ?? []), consult.id])] }));
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

      const result = await new Promise<{ ok: boolean; interrupted?: boolean; error?: string; text: string; files: string[]; cliAccountId?: CliAccountId; attempts?: PriorityAttempt[]; exhausted?: boolean }>((resolve) => {
        let settled = false;
        const r: Running = {
          lastEventAt: Date.now(),
          tools: new Set(),
          consultId: consult.id,
          caller,
          target: target.key,
          kind,
          message,
          scope,
          text: "",
          files: new Set(),
          pendingFiles: new Map(),
          ...(planTask ? { planTask } : {}),
          discussion,
          discussionReplies: discussion ? new Set() : undefined,
          resolve: (end) => {
            if (settled || r.recovering || r.switching) return;
            const unresponsive = !!r.recoveryError && !this.stopped.has(chatId);
            if (unresponsive) end = { ok: false, error: r.recoveryError };
            // priority: limit / sign-in / no-response failures continue on the next account of the order.
            if (!end.ok && !end.interrupted && failover(end.error, unresponsive)) return;
            settled = true;
            const missing = discussion?.peers.filter(p => !r.discussionReplies!.has(p.key));
            const issue = end.ok && missing?.length ? `토의 미완료: ${missing.map(p => p.nickname).join(", ")}의 실제 참여 응답이 없습니다. 보완하거나 미완료 사유를 보고하세요.`
              : end.ok && message.includes("[이미지 결과 필수]") && ![...r.files].some(path => /\.(png|jpe?g|webp)$/i.test(path) && existsSync(resolvePath(project.folder, path))) ? "이미지 생성 미완료: 실제 이미지 파일이나 첨부 결과를 확인하지 못했습니다." : "";
            resolve({ ...end, ...(issue ? { ok: false, error: issue } : {}), text: issue ? `${issue}\n${r.text}` : r.text, files: [...r.files], cliAccountId: r.cliAccountId, attempts: r.attempts, exhausted: r.exhausted });
          },
        };
        const m = this.running.get(chatId) ?? new Map<Role, Running>();
        m.set(target.key, r);
        this.running.set(chatId, m);
        this.chats.agentsChanged(chatId);
        if (this.stopped.has(chatId) || this.epochs.get(chatId) !== epoch) return r.resolve({ ok: false, interrupted: true });
        // The account of the current attempt; only a priority policy ever moves to another one.
        let attempt: ResolvedCliAccount | null | undefined;
        let handover = "";
        const run = async (next?: ResolvedCliAccount) => {
          try {
            if (next) attempt = next;
            else {
              cliSelection = this.chats.roleAccount(chatId, target.key);
              cliPolicy = cliSelection ? this.chats.resolveAccountPolicy(cliSelection.kind, this.chats.store.project(chat.projectId)!.settings) : undefined;
              attempt = cliSelection;
              if (attempt?.unavailable) throw new Error(`우선 할당 목록에 지금 사용할 수 있는 계정이 없습니다: ${attempt.unavailable}`);
            }
            // The assignment keeps this account to the end; a recovered first account waits for the next one.
            if (attempt?.mode === "priority") {
              r.priority = true;
              this.chats.pinRoleAccount(chatId, target.key, attempt);
            }
            if (attempt) this.chats.assertCliAccount(attempt.accountId, attempt.kind);
            const driver = await this.chats.driver(chatId, target.key, reasoning.effort, assignmentModel);
            r.cliAccountId = this.chats.runningAccount(chatId, target.key);
            if (this.stopped.has(chatId) || this.epochs.get(chatId) !== epoch || settled) return r.resolve({ ok: false, interrupted: true });
            await driver.send({
              text: kindPrefix(kind, callerName, scope) + message + handover + `\n\n[현재 팀과 최근 결과]\n${this.agentsText(chatId, true)}` + this.readMessages(chatId, target.key),
              requiresImage: message.includes("[이미지 결과 필수]"),
              attachments,
              noWrites: false,
            });
          } catch (e) {
            r.resolve({ ok: false, error: e instanceof Error ? e.message : String(e) });
          }
        };
        const failover = (error: string | undefined, unresponsive: boolean): boolean => {
          if (attempt?.mode !== "priority" || this.chats.quitting || this.stopped.has(chatId) || this.epochs.get(chatId) !== epoch) return false;
          const reason: PriorityFailureReason | undefined = unresponsive ? "unresponsive" : isQuotaError(error) ? "quota" : isAuthError(error) ? "auth" : undefined;
          if (!reason) return false;
          const failed = r.cliAccountId ?? attempt.accountId;
          this.chats.markPriorityFailure(failed, reason);
          // A switch held back earlier and then cleaned up (recover) keeps its first recorded cause.
          if (r.attempts?.at(-1)?.accountId !== failed)
            r.attempts = [...(r.attempts ?? []), { accountId: failed, reason, error: clipText(error ?? PRIORITY_FAILURE_LABEL[reason], 300) }];
          const next = this.chats.nextPriorityAccount({ ...attempt, note: undefined }, r.attempts!.map(a => a.accountId));
          if (!next) { r.exhausted = true; return false; }
          r.switching = true;
          r.failover = `${next.accountId}로 전환 중`;
          const label = PRIORITY_FAILURE_LABEL[r.attempts!.at(-1)!.reason];
          this.chats.emit(chatId, this.chats.route(chatId, target.key), target.key, { type: "notice", text: `우선 할당: ${failed} 실패(${label}) → ${next.accountId}로 전환합니다${next.note ? ` (${next.note})` : ""}. 이전 계정의 실행 종료를 확인한 뒤 새 세션으로 같은 작업을 이어서 실행합니다.` });
          void (async () => {
            // The failed account's process must be confirmed closed before the next account starts;
            // otherwise the switch is held: the scope stays locked and the master is told to clean up.
            let closeError: string | undefined;
            try { closeError = await this.closeForSwitch(chatId, target.key); }
            catch (error) { closeError = error instanceof Error ? error.message : String(error); }
            finally { r.switching = false; } // never left set: recover must stay possible
            if (closeError) {
              r.failover = "전환 보류(이전 계정 실행 종료 미확인)";
              r.lastError = `우선 할당 전환 실패: 이전 계정 ${failed}의 실행 종료를 확인하지 못해 다음 계정 ${next.accountId}로 전환하지 않았습니다(${clipText(closeError, 200)}). 작업 범위 잠금은 유지됩니다.`;
              r.lastEventAt = Date.now();
              this.chats.agentsChanged(chatId);
              this.alertMaster(chatId, target.key, `${target.nickname}: ${r.lastError} 마스터는 check_agent(to="${target.nickname}", recover=true)로 이전 실행을 정리하세요. 정리가 확인되면 앱이 우선 순서의 다음 계정으로 이어서 실행합니다.`);
              return;
            }
            const draft = r.text.trim();
            const files = [...r.files];
            r.failover = `${next.accountId}로 전환`;
            Object.assign(r, { text: "", lastError: undefined, recoveryError: undefined, tools: new Set(), cliAccountId: undefined, lastEventAt: Date.now(), lastProbeAt: undefined });
            r.pendingFiles.clear();
            handover = `\n\n[앱 우선 할당 전환] 이전 계정 ${failed}에서 ${label}(으)로 실패해 계정 ${next.accountId}로 같은 작업을 이어서 실행합니다. 이미 끝난 부분은 반복하지 말고 파일 상태를 먼저 확인하세요.`
              + `\n이전 시도에서 변경된 파일: ${files.length ? files.join(", ") : "없음"}`
              + (draft ? `\n이전 시도의 중간 응답(일부):\n${clipText(draft, 2000)}` : "");
            this.chats.setRoute(chatId, target.key, node);
            this.chats.agentsChanged(chatId);
            if (this.stopped.has(chatId) || this.epochs.get(chatId) !== epoch) return r.resolve({ ok: false, interrupted: true });
            await run(next);
          })();
          return true;
        };
        void run();
      });

      // Quitting: leave it running so the next launch records that the app exit cut it off.
      if (this.chats.quitting) return textResult("앱 종료로 중단되었습니다.", true);
      this.chats.setRoute(chatId, target.key, undefined);
      this.releaseScope(chatId, consult.id);
      this.chats.agentsChanged(chatId);
      // A stored report is a result of a review; it never outranks a failed or stopped run below.
      const report = kind === "review" ? this.chats.store.consult(consult.id)?.review : undefined;
      const hasResult = !!result.text.trim() || result.files.length > 0 || !!report;
      const status = this.stopped.has(chatId) ? "stopped" : result.ok && hasResult ? "done" : result.interrupted ? "stopped" : "error";
      const cliInfo = this.cliAccountText(chatId, cliSelection, result.cliAccountId, false, cliPolicy);
      const accountInfo = cliInfo ? `[CLI ${cliInfo}]
` : "";
      const quotaFailure = !result.ok && ["claude", "gpt", "grok"].includes(target.kind) && isQuotaError(result.error);
      const priorityRun = result.attempts?.length || cliSelection?.mode === "priority";
      const quotaNotice = !quotaFailure ? ""
        : priorityRun ? "[CLI 한도 소진 — 우선 할당 목록에 이어서 실행할 계정이 남지 않아 실패를 보고합니다. cli_accounts로 상태를 확인하고 사용자에게 알리세요.]\n"
        : "[CLI 한도 소진 — 자동 계정 전환·재시도 없음. fixed는 실패를 보고하고, auto는 마스터가 cli_accounts 조회 후 다른 계정에 supersedes로 재배정하세요.]\n";
      const attempts = result.attempts ?? [];
      const failoverInfo = !attempts.length ? ""
        : result.exhausted
          ? `[우선 할당: 시도한 계정 모두 실패 — ${attempts.map(a => `${a.accountId}(${PRIORITY_FAILURE_LABEL[a.reason]}: ${a.error})`).join(", ")}${cliSelection?.order ? ` · 남은 계정: ${this.chats.priorityUnavailable(cliSelection.order, attempts.map(a => a.accountId)) || "없음"}` : ""}]\n`
          : `[우선 할당: ${attempts.map(a => `${a.accountId} 실패(${PRIORITY_FAILURE_LABEL[a.reason]})`).join(" → ")} → ${result.cliAccountId ?? "연결 전 실패/중지"}로 전환 · 실제 실행 계정=${result.cliAccountId ?? "연결 전 실패/중지"}]\n`;
      const summary = accountInfo + failoverInfo + quotaNotice +[!result.ok ? result.error : undefined, result.text.trim()].filter(Boolean).join("\n")
        + (!result.text.trim() && !result.error ? (status === "done" && report ? `구조화 리뷰 제출(${report.verdict}): ${report.summary}` : result.files.length ? `산출물 ${result.files.length}개를 생성·수정했습니다.` : "작업자의 응답과 산출물이 없습니다.") : "");
      const finished = this.chats.store.finishConsult(consult.id, status, summary, result.files);
      this.chats.sink.consult(finished);
      // A paused assignment resumes into the same step; any other end decides it.
      if (planTask && !["pausing", "paused"].includes(this.chats.store.chat(chatId)?.status ?? ""))
        this.updatePlanStep(chatId, planTask, (s) => ({ ...s, status: status === "done" ? "completed" : "pending" }));
      this.chats.emit(chatId, this.chats.route(chatId, caller), caller, { type: "consult_end", consultId: consult.id, status, summary, files: result.files });
      // The team (including a master who did not assign this) still receives the result; kind keeps it out of the main chat view.
      this.chats.emit(chatId, "orch", target.key, { type: "room_message", from: target.key, text: consultStatusText(finished), kind: "result", consultId: consult.id, status });
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
      const effortLabel = reasoning.effort || "CLI 기본";
      return { ...textResult(`${head} · 추론 ${effortLabel}\n${consultResultText(finished)}`, status !== "done"), structuredContent: { consultId: consult.id, ...(status !== "done" ? { error: (quotaFailure ? "CLI 한도 소진 · " : "") + clipText(result.error ?? (status === "stopped" ? "사용자가 중지했습니다." : "작업자의 응답과 산출물이 없습니다."), 160) } : {}) } };
    } finally {
      if (cliKind) this.chats.pinRoleAccount(chatId, target.key, undefined);
      assignments.delete(assignmentKey);
      removeWait(this.graph(chatId), caller, target.key);
      done();
    }
  }

  /** Every active assignment may request mutations within its scope. */
  private guardApproval(chatId: number, input: ApprovalInput): string | null {
    if (this.stopped.has(chatId) || ["pausing", "paused"].includes(this.chats.store.chat(chatId)?.status ?? "")) return "작업이 중지되었습니다.";
    const fileWrite = !!input.writes || !!input.diffs?.length;
    const mutation = fileWrite || (!!input.command && !isReadCommand(input.command));
    if (!mutation) return null;
    if (this.stopped.has(chatId)) return "작업이 중지되었습니다.";
    if (input.role === "orch" && this.planning.has(chatId))
      return "계획 모드에서는 파일을 바꾸거나 변경 명령을 실행할 수 없습니다. 읽기 전용으로 살피고 propose_plan으로 계획을 제출하세요.";
    // While an approved plan runs, every file change (the master's own edits included) stays inside the
    // plan's approved ranges; a worker is held to both this and its own scope (writeScope).
    if (fileWrite) {
      const outside = this.writesOutsidePlan(chatId, input);
      if (outside) return outside;
    }
    const investigation = this.investigationIssue(chatId);
    if (investigation) {
      if (input.role === "orch") return investigation;
      // The master's instruction is meaningless to the worker being blocked: say what was classified and what is allowed.
      const what = input.command ? `명령 \`${input.command.slice(0, 200)}\`` : "파일 변경";
      return `양쪽 독립 조사 중에는 읽기 전용 명령만 실행할 수 있어 앱이 자동 거절했습니다. ${what}이(가) 변경으로 분류되었습니다. ` +
        "git status/diff/log/show/ls-files/rev-parse, Get-Content·Get-ChildItem·Get-Item·Select-String·rg 등 단일 읽기 명령이나 Select-Object·Sort-Object 등으로 이어진 읽기 파이프를 사용하세요.";
    }
    if (input.role === "orch") {
      if (this.scopeLocks.get(chatId)?.some((h) => !h.command)) return "작업자가 파일을 변경 중입니다. 작업이 끝난 뒤 마스터의 직접 변경을 다시 요청하세요.";
    } else {
      const r = this.running.get(chatId)?.get(input.role);
      if (!r) return "작업을 맡은 동안에만 파일 수정이나 변경 명령을 실행할 수 있습니다.";
      const held = this.scopeLocks.get(chatId) ?? [];
      const writer = (h: ScopeLock) => !h.command;
      // A command (not a file edit) from an assignment without a scope cannot be tied to files. It takes a
      // short command lock instead of a whole-folder lock: it waits for writers and holds writers off while
      // it runs, never blocks other such commands, and ends with the command (releaseCommandLock).
      if (!fileWrite && r.kind !== "implement" && !r.scope.length && !held.some((h) => h.consultId === r.consultId && writer(h))) {
        if (this.masterActions.get(chatId)?.size || held.some((h) => writer(h) && h.consultId !== r.consultId)) return "다른 작업이 같은 범위를 변경 중입니다. 해당 작업이 끝난 뒤 다시 요청하세요.";
        // One lock per approved tool call: only that call's result (or the end of the turn/assignment) ends it.
        if (!held.some((h) => h.consultId === r.consultId && h.command && h.toolId === input.toolId)) {
          held.push({ consultId: r.consultId, scope: [], command: true, ...(input.toolId ? { toolId: input.toolId } : {}) });
          this.scopeLocks.set(chatId, held);
        }
        return null;
      }
      if (!held.some((h) => h.consultId === r.consultId && writer(h))) {
        if (this.masterActions.get(chatId)?.size || held.some((h) => h.consultId !== r.consultId && scopesOverlap(h.scope, r.scope)))
          return "다른 작업이 같은 범위를 변경 중입니다. 해당 작업이 끝난 뒤 다시 요청하세요.";
        held.push({ consultId: r.consultId, scope: r.scope });
        this.scopeLocks.set(chatId, held);
      }
    }
    return null;
  }

  private writeScope(chatId: number, role: Role): { globs: string[] | null; why: string } | null {
    if (!isWorkerKey(role)) return null;
    const r = this.running.get(chatId)?.get(role);
    if (!r) return null;
    if (r.scope.length) return { globs: r.scope, why: `맡은 범위(${r.scope.join(", ")}) 밖` };
    // Under an approved plan an empty scope is not "unchecked": an approved task without one changes no
    // files, and a supplement assignment stays inside what the user approved for the plan.
    if (r.planTask) return { globs: [], why: `승인된 계획 작업 ${r.planTask.taskId}은(는) 파일 수정이 없는 작업입니다` };
    const allowed = this.planScopeUnion(chatId);
    if (allowed) return { globs: allowed, why: `승인된 계획의 범위(${allowed.join(", ") || "파일 수정 없음"}) 밖 — 확대하려면 마스터가 extend_plan_scope로 사용자 승인을 받아야 합니다` };
    return null;
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
      this.saveInstruction(chatId); // The plan and review restrictions end with the turn.
      this.continueQueued(chatId, event);
      return;
    }
    const r = this.running.get(chatId)?.get(role);
    if (!r) return;
    r.lastEventAt = Date.now();
    if (["text", "text_delta", "tool_call", "tool_result", "file_change"].includes(event.type)) r.lastError = undefined;
    switch (event.type) {
      case "error":
        r.lastError = event.message;
        break;
      case "notice":
        if (event.cliAccountId) r.cliAccountId = event.cliAccountId;
        break;
      case "text_delta":
        r.text += event.text;
        break;
      case "text":
        r.text = event.text;
        break;
      case "tool_call":
        (r.tools ??= new Set()).add(event.id);
        if (event.diffs?.length) r.pendingFiles.set(event.id, event.diffs.flatMap((d) => d.movePath ? [d.path, d.movePath] : [d.path]));
        break;
      case "tool_result": {
        r.tools?.delete(event.id);
        this.releaseCommandLock(chatId, r.consultId, event.id);
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
        // A tool whose result never arrived ends with the worker's turn.
        this.releaseCommandLock(chatId, r.consultId);
        r.resolve({ ok: event.ok, interrupted: event.interrupted, error: event.error ?? (!event.ok ? r.lastError : undefined) });
        break;
    }
  }

  /** Continue with a queued instruction or a held plan revision once the current turn ends. */
  private continueQueued(chatId: number, end: Extract<AgentEvent, { type: "turn_end" }>) {
    // Extra instructions that arrived after the master's last ask become the next turn.
    const inst = this.instructions.get(chatId);
    // Revision requests held since the plan was submitted run only now, as a revision turn (never
    // consumed by a tool response of the turn that submitted it).
    let held = this.revisionHold.get(chatId) ?? [];
    this.revisionHold.delete(chatId);
    // Only a turn that recorded its proposal hands the held requests on. After an error (or a stop) there
    // is no proposal to revise, and they must never start an ordinary, writing turn: they stay in the
    // conversation and the user sends them again.
    if (held.length && (!end.ok || end.interrupted || this.stopped.has(chatId))) {
      this.reviseAfterTurn.delete(chatId);
      if (!end.interrupted && !this.stopped.has(chatId))
        this.chats.emit(chatId, "orch", null, { type: "notice", text: "계획 턴이 오류로 끝나 보관한 계획 수정 요청을 자동으로 보내지 않았습니다. 내용을 확인한 뒤 다시 보내 주세요." });
      held = [];
    }
    if (inst && (held.length || inst.queued.length) && !end.interrupted && !this.stopped.has(chatId)) {
      const q = [...held, ...inst.queued.splice(0)];
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
  }

  // ---------- user instructions
  private newInstruction(chatId: number, text: string, restore = false): Instruction {
    const events = this.chats.store.events(chatId);
    let id = events.findLast((e) => e.event.type === "user" && !(restore && e.event.queued))?.id ?? 0;
    if (restore) {
      // A follow-up that became its own turn owns the id its route_request recorded.
      const dispatched = events.findLast((e) => e.event.type === "dispatch")?.event;
      if (dispatched?.type === "dispatch" && dispatched.instructionId >= id) id = dispatched.instructionId;
    }
    const previous = restore ? events.findLast((e) => e.event.type === "dispatch" && e.event.instructionId === id)?.event : undefined;
    return { id, mode: previous?.type === "dispatch" ? previous.mode : undefined, dualInvestigation: previous?.type === "dispatch" ? previous.dualInvestigation : undefined, text, asks: 0, reviews: 0, requests: new Map(), queued: [], pinned: [] };
  }

  /** Keeps the running instruction exact across a crash; call whenever its text, mode or restrictions change. */
  private saveInstruction(chatId: number) {
    const inst = this.instructions.get(chatId);
    if (!inst) return;
    const snapshot: InstructionSnapshot = {
      id: inst.id, text: inst.text, mode: inst.mode, dualInvestigation: inst.dualInvestigation, planning: this.planning.has(chatId), reviewing: this.reviewing.has(chatId), planRun: this.planRunning.get(chatId),
      ...(this.planVersions.has(chatId) ? { planVersion: this.planVersions.get(chatId) } : {}), ...(this.planSubmitted.has(chatId) ? { planSubmitted: true } : {}), ...(inst.split ? { split: inst.split } : {}),
    };
    this.chats.store.setSetting(`runInstruction:${chatId}:current`, JSON.stringify(snapshot));
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
    const consults = this.chats.store.listConsults(chatId);
    const work = consults.filter(c => c.instructionId === inst.id);
    // Immediate input may detach the master's native ask call while app workers continue.
    // Wait for those existing jobs and resume synthesis without spending the repair attempt.
    if (this.parallelBatches.get(chatId)?.size || this.assignments.get(chatId)?.size || work.some(c => c.status === "running")) {
      if (!inst.waitingForResults) {
        inst.waitingForResults = true;
        const pending: Promise<unknown>[] = [...this.workerQueue].filter(([key]) => key.startsWith(`${chatId}:`)).map(([, promise]) => promise);
        pending.push(...(this.parallelBatches.get(chatId) ?? []));
        void Promise.allSettled(pending).then(async () => {
          inst.waitingForResults = false;
          if (this.stopped.has(chatId) || this.instructions.get(chatId) !== inst || !this.chats.store.chat(chatId)) return;
          try {
            const driver = await this.chats.driver(chatId, "orch");
            if (driver.running || this.stopped.has(chatId) || this.instructions.get(chatId) !== inst) return;
            this.chats.updateChat(chatId, { status: "working" });
            await driver.send({ text: `[앱 작업자 결과 도착 — 기존 지시 계속]\n${this.agentsText(chatId, true)}\nread_consult로 취합 결과나 필요한 개별 협의의 짧은 결론을 확인하세요. 이견을 대조해야 할 때 취합을 맡기세요. 완료 작업을 재배정하지 말고, 추가 지시에 따른 방침 결정 또는 완료 결과를 보고하세요.${this.takeQueued(chatId)}`, attachments: [], noWrites: false });
          } catch (e) {
            const error = String(e);
            this.chats.emit(chatId, "orch", "orch", { type: "error", message: error });
            this.chats.orchTurnEnded(chatId, { type: "turn_end", ok: false, error });
          }
        });
      }
      return null;
    }
    // The checklist of this instruction (or of the approved plan it carries out) must not end with open steps.
    const planId = this.planRunning.get(chatId) ?? inst.id;
    const steps = planStepsFor(this.chats.store.events(chatId), planId);
    const open = steps?.filter(isOpenStep) ?? [];
    const planIssue = open.length ? `체크리스트에 끝나지 않은 단계 ${open.length}개: ${openStepsText(steps!)}. 실제로 끝냈으면 completed로, 진행하지 않을 단계는 cancelled와 cancelReason으로 갱신하세요.`
      : work.some(c => c.kind === "implement") && !steps?.length ? "구현 작업의 완료 기준과 검증·리뷰 등 남은 단계를 checklist에 기록하세요. 작업자가 변경 파일 없이 끝났어도 남은 작업을 생략하지 마세요." : undefined;
    const issue = this.investigationIssue(chatId) ?? completionIssue(inst.id, inst.mode, consults, !!this.chats.store.project(chat.projectId)?.settings.reviewGate) ?? planIssue;
    if (!issue) return end;
    // New results renew continuation; repeated prose or checklist status toggles do not.
    const progress = new Set(inst.repairProgress ?? []);
    const current = [
      ...work.filter(c => c.status === "done" && c.responseSummary?.trim()).map(c => `consult:${c.id}`),
      ...(steps ?? []).filter(s => !isOpenStep(s)).map(s => `plan:${planId}:${stepKey(s)}`),
    ];
    if (inst.repairProgress && current.some(key => !progress.has(key))) inst.repaired = false;
    inst.repairProgress = [...new Set([...progress, ...current])];
    this.chats.emit(chatId, "orch", "orch", { type: "notice", text: `완료 확인: ${issue}` });
    if (inst.repaired) {
      // No new result after the repair: report the blocker instead of looping.
      if (open.length) {
        this.planIncomplete.add(chatId);
        this.chats.emit(chatId, "orch", null, { type: "plan_state", state: "incomplete", planId, reason: `끝나지 않은 단계 ${open.length}개: ${openStepsText(steps!)}` });
      }
      return { ...end, ok: false, error: `미완료: ${issue}` };
    }
    inst.repaired = true;
    // Continue the same instruction; another repair needs new results or completed steps.
    setTimeout(() => {
      if (this.stopped.has(chatId) || this.instructions.get(chatId) !== inst || !this.chats.store.chat(chatId)) return;
      void (async () => {
        try {
          const driver = await this.chats.driver(chatId, "orch");
          if (this.stopped.has(chatId) || this.instructions.get(chatId) !== inst) return;
          await driver.send({ text: `[앱 완료 검사 — 미진행 시 보완 1회] ${issue}\n본 작업은 앱 작업자에게 배정해야 합니다. 기존 결과를 확인하고 남은 구현·검증·리뷰를 지금 이어서 수행하세요. 새 결과나 완료 단계가 있으면 계속 진행할 수 있습니다. 앞으로 하겠다는 예고만 남기고 종료하지 마세요. 더 진행할 수 없으면 미완료 사유를 분명히 보고하세요.${this.takeQueued(chatId)}`, attachments: [], noWrites: false });
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

  private async instruct(chat: Chat, input: AgentInput, continuePlan = false) {
    const epoch = this.nextEpoch(chat.id);
    this.stopped.delete(chat.id);
    const prefix = this.handover(chat);
    if (prefix) input = { ...input, text: prefix + input.text };
    this.instructions.set(chat.id, this.newInstruction(chat.id, input.text));
    let heldRevision: PlanRevision | undefined;
    // Plan mode (the chat toggle) plans instead of running; so does any message to a proposal still
    // waiting for approval (it is a revision request, whatever the toggle says; see chats.send's user.plan).
    if (!continuePlan) {
      // A new message answers the plan question by itself (a revision or new work): withdraw the card.
      this.clearPlanConfirm(chat.id);
      const id = this.instructions.get(chat.id)!.id;
      // Messages held during the submitting turn (holdAsRevision) revise the proposal recorded at its end.
      const fromHold = this.reviseAfterTurn.delete(chat.id);
      heldRevision = fromHold ? waitingProposal(this.chats.store.events(chat.id)) : undefined;
      // A held revision request is always a read-only planning turn, even if no proposal is found.
      if (fromHold || this.chats.store.chat(chat.id)?.planMode || waitingProposal(this.chats.store.events(chat.id).filter(e => e.id < id))) this.planning.add(chat.id);
    }
    const planningTurn = !continuePlan && this.planning.has(chat.id);
    if (!continuePlan) {
      this.planRunning.delete(chat.id);
      const id = this.instructions.get(chat.id)!.id;
      const before = this.chats.store.events(chat.id).filter(e => e.id < id);
      const revision = planningTurn ? heldRevision ?? waitingProposal(before) : undefined;
      const previous = currentPlanView(before);
      if (!revision && previous?.steps.some(isOpenStep) && ["live", "running", "incomplete", "failed"].includes(previous.state)) {
        input = { ...input, text: input.text + `\n\n[이전 작업 미완료]\n${openStepsText(previous.steps)}\n이번 지시가 같은 작업의 상태 확인·재개·보완이라면 이 남은 단계들을 현재 checklist에 등록하고 기존 결과를 확인해 이어서 수행하세요. 완료된 작업을 다시 배정하지 마세요. 별개 새 작업이면 이전 단계를 가져오지 마세요.` };
      }
      if (revision) {
        this.chats.emit(chat.id, "orch", null, { type: "plan_state", planId: revision.planId, state: "cancelled", version: revision.version, reason: "수정 요청을 받아 새 버전 계획을 세웁니다." });
      } else if (previous && ["live", "running", "proposed"].includes(previous.state)) {
        const incomplete = previous.steps.some(isOpenStep);
        this.chats.emit(chat.id, "orch", null, { type: "plan_state", planId: previous.planId, state: incomplete ? "incomplete" : "done", reason: incomplete ? "새 작업이 시작되어 이전 계획을 정리했습니다(미완료 항목 있음)." : undefined });
      }
      this.chats.emit(chat.id, "orch", "orch", { type: "plan_update", planId: id, instructionId: id, steps: [] });
      if (planningTurn) {
        this.planSubmitted.delete(chat.id);
        this.planVersions.set(chat.id, revision ? revision.version + 1 : 1);
        input = { ...input, text: planPrompt(input.text, revision) };
      } else input = { ...input, text: input.text + "\n\n[새 작업 계획]\n이 지시의 작업 계획을 새로 정리하세요. 이전 작업의 완료·취소 목록을 이어 붙이지 마세요. 여러 단계 작업은 현재 목표·담당·작업자 간 취합·검증을 checklist로 등록하고, 간단한 질문은 계획 없이 답하세요. 진행 중 추가 지시에는 같은 계획을 갱신합니다." };
    }
    this.saveInstruction(chat.id);
    // Added only to what the model reads: the approval judge's instruction text must not include old transcript.
    const forkContext = this.forkContext(chat);
    try {
      const driver = await this.chats.driver(chat.id, "orch");
      if (this.stopped.has(chat.id) || this.epochs.get(chat.id) !== epoch) return;
      await driver.send({ ...input, text: forkContext + input.text + attachmentNote(input.attachments) + (this.planning.has(chat.id) ? "" : "\n\n[앱 협업 규칙] 먼저 할 일을 나눠 route_request(mode, reason, delegated이면 split=single|parallel|sequential)로 기록하세요. 서로 독립인 일은 ask_parallel 한 번으로 동시에 맡기고, 일 하나뿐일 때만 ask를 씁니다. reason에 담당 선택 이유를 적으세요. 결과는 wait_results로 기다리세요. CLI 내부 에이전트는 사용하지 마세요."), noWrites: this.planning.has(chat.id) });
    } catch (error) {
      if (!this.stopped.has(chat.id) && this.epochs.get(chat.id) === epoch) throw error;
    }
  }

  /** A branched chat's snapshot, for a native conversation that has not received it yet. */
  private forkContext(chat: Chat): string {
    if (!chat.fork || !this.chats.startsFreshSession(chat.id, "orch")) return "";
    const event = this.chats.store.events(chat.id).find((e) => e.event.type === "fork_context")?.event;
    return event?.type === "fork_context" ? forkContextPrompt(chat.fork.sourceTitle, event) : "";
  }

  /** Start a master turn with prepared text (same bookkeeping as a normal instruction). */
  private async instructWith(chat: Chat, text: string, contextText: string, continuePlan = false) {
    await this.instruct(chat, { text, attachments: [] }, continuePlan);
    const inst = this.instructions.get(chat.id);
    if (inst) inst.text = contextText;
    this.saveInstruction(chat.id);
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
    const events = this.chats.store.events(chatId);
    const current = instructionToResume(events, parseInstructionSnapshot(this.chats.store.getSetting(`runInstruction:${chatId}:current`)));
    if (!current) {
      this.chats.emit(chatId, "orch", null, { type: "notice", text: "중단 당시 어떤 지시를 실행 중이었는지 기록으로 확인할 수 없어 자동으로 이어가지 않았습니다. 대화 내용을 확인한 뒤 이어서 할 일을 새 지시로 보내 주세요." });
      this.chats.updateChat(chatId, { status: "idle", touch: true });
      return;
    }
    // Runtime mode sets are empty after restart; the restrictions come with the instruction they belonged to.
    if (current.planning) this.planning.add(chatId); else this.planning.delete(chatId);
    if (current.planRun !== undefined) this.planRunning.set(chatId, current.planRun); else this.planRunning.delete(chatId);
    if (current.reviewing) this.reviewing.add(chatId); else this.reviewing.delete(chatId);
    this.restorePlanTurn(chatId, current.planVersion, current.planSubmitted);
    const inst: Instruction = { id: current.id, mode: current.mode, dualInvestigation: current.dualInvestigation, text: current.text, asks: 0, reviews: 0, requests: new Map(), queued: [], pinned: [], ...(current.split ? { split: current.split } : {}) };
    this.reconcilePlanSteps(chatId);
    const direct = events.findLast((e) => e.event.type === "user" && !e.event.queued);
    const earlier = direct?.event.type === "user" && direct.id !== inst.id ? direct.event.text : "";
    const recovery = buildResumeContext({ instructionId: inst.id, instructionText: inst.text, consults: this.chats.store.listConsults(chatId), events: this.chats.store.events(chatId), agents: this.agents(chatId), assignment: (id) => this.chats.store.consultAssignment(id), goal: chat.goal });
    const counts = [recovery.done && `완료 ${recovery.done}`, recovery.interrupted && `중단 ${recovery.interrupted}`, recovery.unconfirmedTools && `결과 미확인 도구 ${recovery.unconfirmedTools}`, recovery.followUps && `추가 지시 ${recovery.followUps}`].filter(Boolean).join(" · ");
    this.chats.emit(chatId, "orch", null, { type: "notice", text: `중단된 작업을 이어서 진행합니다${counts ? ` (${counts})` : ""}` });
    this.chats.updateChat(chatId, { status: "working", touch: true });
    this.stopped.delete(chatId);
    this.instructions.set(chatId, inst);
    this.saveInstruction(chatId);
    const team = this.agents(chatId).filter((a) => a.status === "active").map((a) => a.nickname).join(", ");
    const note =
      "[AI_ChatterBox] 이전 실행이 앱 종료로 중단됐습니다. 작업 폴더의 현재 상태(git status, git diff, 파일 내용)를 확인하고, " +
      `아래 현재 지시의 남은 작업을 이어서 끝낸 뒤 결과를 보고하세요. 이미 끝난 부분은 다시 하지 마세요.${team ? ` 팀(${team})은 그대로 남아 있습니다.` : ""}\n\n현재 지시:\n` +
      (inst.text || "(기록 없음)") +
      (current.planning ? "\n\n[계획 모드] 읽기 전용입니다. 작업자를 쓰지 말고 파일을 바꾸지 마세요. 필요한 결정은 ask_user로 묻고 propose_plan으로 계획을 제출하세요. 배정은 사용자가 승인한 뒤 실행 단계에서 합니다." : "") +
      (earlier ? `\n\n이전 지시(참고용 — 현재 지시가 우선하며 다시 수행하라는 뜻이 아닙니다):\n${clipText(earlier, 2000)}` : "") +
      (recovery.text ? `\n\n${recovery.text}` : "");
    if (!this.agents(chatId).length && (chat.orchCodexThreadId || chat.orchClaudeSessionId))
      this.chats.emit(chatId, "orch", null, { type: "notice", text: "이전 버전의 CLI 내부 작업자 대화는 앱에 저장되지 않았을 수 있습니다. 새 배정부터 앱 작업자 기록으로 표시합니다." });
    try {
      const driver = await this.chats.driver(chatId, "orch");
      if (this.stopped.has(chatId) || this.epochs.get(chatId) !== epoch) return;
      await driver.send({ text: this.forkContext(chat) + this.handover(chat) + note, attachments: [], noWrites: !!current.planning });
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
  /**
   * A message sent after the planning turn submitted its plan (the turn still running) is a revision of
   * that plan: the open card and any choice made on it are void at once, and the message starts a revision
   * turn on that proposal once this turn ends.
   */
  private holdAsRevision(chat: Chat): boolean {
    if (!this.planning.has(chat.id) || !this.planSubmitted.has(chat.id)) return false;
    this.clearPlanConfirm(chat.id);
    this.reviseAfterTurn.add(chat.id);
    return true;
  }

  private async queue(chat: Chat, input: AgentInput) {
    if (this.holdAsRevision(chat)) {
      // Kept apart from inst.queued, which tool responses of the running turn would consume.
      this.revisionHold.set(chat.id, [...(this.revisionHold.get(chat.id) ?? []), input]);
      this.chats.emit(chat.id, "orch", null, { type: "notice", text: "계획 수정 요청을 받았습니다. 지금 턴이 끝나면 이 계획을 수정하는 턴으로 이어집니다." });
      return;
    }
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
    // After the plan was submitted, the message waits for the turn's end and revises that plan.
    if (this.planning.has(chat.id) && this.planSubmitted.has(chat.id)) return this.queue(chat, input);
    const driver = this.chats.liveDriver(chat.id, "orch");
    const text = input.text + attachmentNote(input.attachments);
    const prompt = "[사용자 즉시 질문·수정 요청 — 작업 결과를 기다리지 말고 먼저 직접 답변]\n" + input.text + "\n\n질문에 먼저 한국어로 답하고, 수정 요청이면 이해한 내용과 반영 방법을 먼저 말하세요. 기존 작업자는 유지하며 본 작업의 위임·리뷰 요건도 유지합니다.";
    const remember = () => {
      inst.text += "\n\n[사용자 추가 지시]\n" + text;
      inst.pinned.push(text);
      inst.pendingImmediate = true;
      this.saveInstruction(chat.id);
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
      await driver.send({ ...input, text: prompt, noWrites: false });
    } else if (driver && this.masterConsultWaiters.get(chat.id)?.size) {
      remember();
      this.wakeMasterConsults(chat.id);
      this.chats.emit(chat.id, "orch", null, { type: "notice", text: "마스터의 협의 대기를 풀고 추가 요청을 전달했습니다. 기존 작업자는 계속 작업합니다." });
    } else {
      await this.queue(chat, input);
      this.chats.emit(chat.id, "orch", null, { type: "notice", text: "현재 CLI가 즉시 전달을 받지 못해 다음 단계 전달로 보관했습니다." });
    }
  }

  /** Deliver new notes once; keep the originals for recovery instead of replaying them on every call. */
  private takeQueued(chatId: number): string {
    const inst = this.instructions.get(chatId);
    if (!inst) return "";
    const recovery = inst.recoveryNote;
    inst.recoveryNote = undefined;
    const fresh = inst.queued.splice(0);
    inst.pinned.push(...fresh.map((x) => x.text + attachmentNote(x.attachments)));
    const unsent = inst.pinned.slice(inst.pinnedSent ?? 0);
    inst.pinnedSent = inst.pinned.length;
    if (!unsent.length) return recovery ? `\n\n${recovery}` : "";
    return "\n\n[사용자 추가 지시 — 작업 중에 도착함, 최종 보고까지 반드시 반영]\n" + unsent.map((t) => `- ${t}`).join("\n") + (recovery ? `\n\n${recovery}` : "");
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
        // instruct() wraps the request in the read-only planning prompt (and revises a waiting proposal).
        this.planning.add(chatId);
        await this.chats.startTurn(chatId, `/plan ${arg}`, [], () => this.instructWith(chat, arg, arg));
        return;
      }
      case "plan-run": {
        needIdle();
        // Only the plan still waiting for approval runs: never a cancelled, finished or superseded one.
        const events = this.chats.store.events(chatId);
        const planId = pendingProposal(events);
        if (planId === undefined) throw new Error("승인할 제안 계획이 없습니다. 취소·완료됐거나 그 뒤에 다른 지시가 있었던 계획은 실행할 수 없으니 /plan으로 새로 계획하세요.");
        const steps = planStepsFor(events, planId);
        const version = latestPlanVersion(events, planId);
        // An approval button names the plan and version it showed (another client may have revised or
        // replaced it since). A bare "/plan-run" typed by the user runs the latest proposal and says which.
        const seen = arg.trim();
        if (seen) {
          const m = /^(\d+):v?(\d+)$/i.exec(seen);
          if (!m) throw new Error("승인할 계획은 \"계획ID:버전\" 형식으로 보내세요.");
          if (Number(m[1]) !== planId || Number(m[2]) !== (version ?? 1))
            throw new Error(`계획이 바뀌었습니다(승인 화면: 계획 ${m[1]} v${m[2]} → 현재: 계획 ${planId} v${version ?? 1}). 최신 계획을 확인한 뒤 다시 승인하세요.`);
        } else this.chats.emit(chatId, "orch", null, { type: "notice", text: `/plan-run: 최신 제안(계획 ${planId} v${version ?? 1})을 실행합니다.` });
        this.planning.delete(chatId);
        this.clearPlanConfirm(chatId); // approved by button or by the plan question: one path
        this.planRunning.set(chatId, planId);
        // The definitions approved now are fixed for the run (assignments and checklists are checked against them).
        this.chats.store.setSetting(`approvedPlan:${chatId}`, JSON.stringify({ planId, version, tasks: steps ?? [] }));
        // Approval ends plan mode: the next message runs normally unless the user turns it on again.
        if (chat.planMode) this.chats.updateChat(chatId, { planMode: false });
        this.chats.emit(chatId, "orch", null, { type: "plan_state", state: "running", planId, ...(version ? { version } : {}) });
        const grouped = !!steps?.some((s) => s.group !== undefined);
        const text = grouped
          ? `사용자가 계획${version ? ` v${version}` : ""}을 승인했다. 계획대로 실행하라.\n` +
            "- group 번호 순서로 진행한다. 한 group에서 선행이 끝난 작업들은 ask_parallel 한 번으로 동시에 맡긴다(task마다 planTaskId=작업 id, kind, scope, reason, 완료 기준을 담은 message). 시작할 작업이 하나뿐일 때만 ask를 쓴다.\n" +
            "- 필요한 작업자는 agentKind에 맞춰 spawn으로 그 group의 동시 작업 수만큼 확보하고, owner가 있으면 그 작업자를 쓴다.\n" +
            "- planTaskId를 주면 앱이 단계를 진행 중·완료로 바꾸고 협의 id를 연결한다. 결과를 확인해 문제가 있으면 보완을 맡기고, 진행하지 않을 단계는 checklist에서 cancelled와 cancelReason으로 남긴다.\n" +
            "- 결과를 기다릴 때는 wait_results를 쓴다. 끝나지 않은 단계가 남으면 앱은 완료로 처리하지 않는다.\n\n승인된 계획:\n" + planByGroup(steps!)
          : "사용자가 계획을 승인했다. 계획대로 실행하라: 필요한 작업자를 spawn 하고, 서로 독립인 단계는 ask_parallel 한 번으로 동시에, 앞 결과가 필요한 단계만 차례로 맡기고(implement는 scope 지정), 단계를 시작·완료할 때마다 checklist를 갱신하고, " +
            "모든 단계를 완료하거나, 진행하지 않을 단계는 cancelled와 cancelReason으로 표시한 뒤 결과를 보고하라. 끝나지 않은 단계가 남으면 앱은 완료로 처리하지 않는다." +
            (steps?.length ? `\n\n승인된 계획 단계:\n${steps.map((s) => `- ${s.id ? `${s.id} ` : ""}${s.title} (${s.status})`).join("\n")}` : "");
        await this.chats.startTurn(chatId, "계획 실행", [], () => this.instructWith(chat, text, "계획 실행", true));
        return;
      }
      case "plan-cancel": {
        // Cancels a proposal that waits for approval, and nothing else: no flag, snapshot or queued work changes.
        if (busy) throw new Error("계획을 세우거나 실행하는 중에는 계획을 취소할 수 없습니다. 멈추려면 중지(/stop)를 사용하세요.");
        const planId = pendingProposal(this.chats.store.events(chatId));
        if (planId === undefined) throw new Error("취소할 제안 계획이 없습니다.");
        this.clearPlanConfirm(chatId);
        this.chats.emit(chatId, "orch", null, { type: "plan_state", state: "cancelled", planId, reason: "사용자가 제안을 취소했습니다." });
        return;
      }
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
        // Compacting first would open a session that never received the branch snapshot.
        if (chat.fork && this.chats.startsFreshSession(chatId, "orch")) throw new Error("아직 압축할 대화가 없습니다.");
        const project = this.chats.store.project(chat.projectId)!;
        const { agent } = chatOrchestrator(chat, project);
        if (agent === "codex") {
          const threadId = chat.orchCodexThreadId;
          if (!threadId) throw new Error("아직 압축할 대화가 없습니다.");
          const [owner, generation] = (this.chats.store.getSetting(`orchSessionAccount:${chatId}:codex`) ?? "").split("@");
          if (owner && (!isCliAccountId(owner) || !owner.startsWith("gpt-"))) throw new Error("마스터 스레드의 CLI 계정 기록이 올바르지 않습니다.");
          // Legacy threads without an owner record belong to the original default account.
          const accountId = isCliAccountId(owner) ? owner : this.chats.runningAccount(chatId, "orch") ?? "gpt-1";
          const account = this.chats.assertCliAccount(accountId, "gpt");
          if (generation !== undefined && (generation === "" || !Number.isFinite(Number(generation)) || Number(generation) !== account.createdAt))
            throw new Error("마스터 대화를 만든 계정이 삭제·재생성되어 압축할 수 없습니다. 새 대화로 이어가세요.");
          const server = this.chats.codex(accountId);
          await server.ensure();
          await server.request("thread/compact/start", { threadId });
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
    const incomplete = this.planIncomplete.delete(chatId);
    const chat = this.chats.store.chat(chatId);
    // A pause ends the turn too; the plan resumes with the chat, so its state stays as it is.
    const pausing = ["pausing", "paused"].includes(chat?.status ?? "");
    const proposal = this.planning.has(chatId);
    if (proposal) {
      this.planning.delete(chatId);
      const submitted = this.planSubmitted.delete(chatId);
      const planId = this.instructions.get(chatId)?.id;
      const version = this.planVersions.get(chatId);
      this.planVersions.delete(chatId);
      // Only a plan submitted with propose_plan waits for approval: a checklist or native todo list is not one.
      const steps = planId === undefined ? undefined : planStepsFor(this.chats.store.events(chatId), planId);
      const decision = this.planDecision.get(chatId);
      this.planDecision.delete(chatId);
      if (end.ok && submitted && steps?.length) {
        this.chats.emit(chatId, "orch", null, { type: "plan_state", state: "proposed", planId, ...(version ? { version } : {}) });
        // The user already answered the plan question during the turn: same paths as the buttons, once idle.
        // Bound to this submission and this run: re-checked right before acting, so a stop, a new
        // instruction or another proposal in between leaves the plan as it is.
        const epoch = this.epochs.get(chatId);
        if (decision) setTimeout(() => {
          const c = this.chats.store.chat(chatId);
          if (!c || ["paused", "pausing"].includes(c.status) || this.stopped.has(chatId) || this.epochs.get(chatId) !== epoch) return;
          const events = this.chats.store.events(chatId);
          if (pendingProposal(events) !== planId || (latestPlanVersion(events, planId!) ?? 1) !== (version ?? 1)) return;
          void this.command(chatId, decision === "run" ? "plan-run" : "plan-cancel", decision === "run" ? `${planId}:${version ?? 1}` : "")
            .catch((e) => this.chats.emit(chatId, "orch", null, { type: "notice", text: `계획 ${decision === "run" ? "진행" : "취소"} 처리 실패: ${e instanceof Error ? e.message : String(e)}` }));
        }, 0);
      } else {
        if (!end.ok || end.interrupted) this.clearPlanConfirm(chatId);
      }
      if (end.ok && !(submitted && steps?.length)) this.chats.emit(chatId, "orch", null, { type: "notice", text: chat?.planMode ? "아직 제출된 계획이 없습니다. 답변이나 추가 설명을 보내면 계획 모드로 이어서 세웁니다." : "아직 제출된 계획이 없습니다. /plan으로 다시 요청하세요." });
    } else if (this.planRunning.has(chatId) && !pausing) {
      const planId = this.planRunning.get(chatId)!;
      this.planRunning.delete(chatId);
      // The completion guard already let this turn end successfully only without open steps.
      if (!incomplete) this.chats.emit(chatId, "orch", null, end.interrupted
        ? { type: "plan_state", state: "stopped", planId, reason: "사용자가 작업을 중지했습니다." }
        : end.ok ? { type: "plan_state", state: "done", planId }
        : { type: "plan_state", state: "failed", planId, reason: end.error });
    }
    // A proposal waits for the user's approval: never continue a goal past it automatically.
    if (proposal) return;
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
    // The continuation belongs to this instruction: a later instruction or command (a new /plan, which a
    // proposal cancel can only follow), a stop or a restart in between makes it stale.
    const inst = this.instructions.get(chatId);
    const epoch = this.epochs.get(chatId);
    setTimeout(() => {
      const c = this.chats.store.chat(chatId);
      if (!c?.goal || c.goal.status !== "active" || this.stopped.has(chatId) || ["working", "pausing", "paused"].includes(c.status) || this.chats.isBusy(chatId)) return;
      if (this.instructions.get(chatId) !== inst || this.epochs.get(chatId) !== epoch) return;
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

  /** Asks [진행/수정/취소] for a submitted plan; replaces an earlier question for the same chat. */
  private askPlanConfirm(chatId: number, version: number, tasks: number) {
    this.clearPlanConfirm(chatId);
    const id = `ask:${randomUUID()}`;
    this.planConfirm.set(chatId, id);
    this.asks.set(id, { chatId, keepStatus: true, resolve: (answer) => void this.onPlanConfirm(chatId, id, answer) });
    this.chats.emit(chatId, "orch", "orch", { type: "ask_user", id, question: `계획 v${version}(작업 ${tasks}개)이 준비됐습니다. 진행할까요? 진행하면 바로 group별로 실행하고, 수정을 고르면 다음 메시지로 고칠 내용을 받아 계획을 보강합니다.`, options: ["진행", "수정", "취소"], planConfirm: true });
  }

  /** Withdraws an open plan question (the plan was approved, cancelled, revised or replaced another way). */
  private clearPlanConfirm(chatId: number) {
    const id = this.planConfirm.get(chatId);
    this.planConfirm.delete(chatId);
    // A choice belongs to the submission its card showed: a re-submission or a new message voids it.
    this.planDecision.delete(chatId);
    if (!id || !this.asks.has(id)) return;
    this.asks.delete(id);
    this.chats.emit(chatId, "orch", null, { type: "ask_user_answer", id, answer: "(처리됨)" });
  }

  /** The user's answer: 진행 runs the plan through the approval path, 취소 cancels, 수정 (or own words) revises. */
  private async onPlanConfirm(chatId: number, id: string, answer: string) {
    if (this.planConfirm.get(chatId) !== id) return;
    this.planConfirm.delete(chatId);
    if (!answer.startsWith("사용자 답변: ")) return; // stopped, not answered
    const choice = answer.slice("사용자 답변: ".length).trim();
    const fail = (e: unknown) => {
      try { this.chats.emit(chatId, "orch", null, { type: "notice", text: `계획 ${choice} 처리 실패: ${e instanceof Error ? e.message : String(e)}` }); }
      catch { /* the chat or the app closed meanwhile */ }
    };
    // Still inside the planning turn: decide once it ends (the proposal is recorded then).
    if (this.planning.has(chatId)) {
      if (choice === "진행") this.planDecision.set(chatId, "run");
      else if (choice === "취소") this.planDecision.set(chatId, "cancel");
      else {
        this.planDecision.delete(chatId);
        const text = choice === "수정" ? "[사용자 선택: 수정] 무엇을 바꿀지 ask_user로 물은 뒤 반영해 propose_plan으로 다시 제출하세요." : `[사용자 선택: 수정] 사용자의 수정 요청: ${choice}\n반영해 propose_plan으로 다시 제출하세요.`;
        try { await this.chats.liveDriver(chatId, "orch")?.steer?.({ text, attachments: [] }); } catch (e) { fail(e); }
      }
      return;
    }
    const events = this.chats.store.events(chatId);
    const planId = pendingProposal(events);
    if (planId === undefined) return fail(new Error("승인 대기 중인 계획이 없습니다."));
    try {
      if (choice === "진행") await this.command(chatId, "plan-run", `${planId}:${latestPlanVersion(events, planId) ?? 1}`);
      else if (choice === "취소") await this.command(chatId, "plan-cancel", "");
      else if (choice === "수정") this.chats.emit(chatId, "orch", null, { type: "notice", text: "고칠 내용을 보내 주세요. 다음 메시지는 계획 수정 요청으로 처리됩니다." });
      else await this.chats.send(chatId, choice, []); // the user's own words are the revision request
    } catch (e) { fail(e); }
  }

  answerAsk(chatId: number, askId: string, answer: string) {
    const a = this.asks.get(askId);
    if (!a || a.chatId !== chatId) return false;
    this.asks.delete(askId);
    this.chats.emit(chatId, "orch", null, { type: "ask_user_answer", id: askId, answer });
    // The plan confirmation can be answered after the turn ended: it never marks the chat working by itself.
    if (!a.keepStatus) this.chats.updateChat(chatId, { status: "working" });
    a.resolve(`사용자 답변: ${answer}`);
    return true;
  }

  // ---------- stop
  async stop(chatId: number, preserve = false) {
    this.nextEpoch(chatId);
    this.stopped.add(chatId);
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
    await Promise.all([this.chats.stop(chatId), this.council.cancel(chatId)]);
    if (!preserve && ["pausing", "paused"].includes(this.chats.store.chat(chatId)?.status ?? "")) this.chats.updateChat(chatId, { status: "idle" });
  }

  private pauseState(chatId: number): PauseState | undefined {
    const raw = this.chats.store.getSetting(`pause:${chatId}`);
    return raw ? JSON.parse(raw) as PauseState : undefined;
  }

  private restoreInstruction(state: PauseState): Instruction {
    return { ...state.instruction, requests: new Map(state.instruction.requests), waitingForResults: false, pendingImmediate: false, pinnedSent: 0 };
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
      planning: this.planning.has(chat.id), reviewing: this.reviewing.has(chat.id), planRun: this.planRunning.get(chat.id),
      ...(this.planVersions.has(chat.id) ? { planVersion: this.planVersions.get(chat.id) } : {}), ...(this.planSubmitted.has(chat.id) ? { planSubmitted: true } : {}),
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
    if (state.planRun !== undefined) this.planRunning.set(chat.id, state.planRun); else this.planRunning.delete(chat.id);
    if (state.reviewing) this.reviewing.add(chat.id); else this.reviewing.delete(chat.id);
    this.restorePlanTurn(chat.id, state.planVersion, state.planSubmitted);
    this.stopped.delete(chat.id);
    this.chats.updateChat(chat.id, { status: "working", touch: true });
    this.chats.emit(chat.id, "orch", null, { type: "notice", text: "마스터와 일시 정지했던 작업자에게 재시작을 요청합니다." });
    const resumed = new Set<string>();
    for (const assignment of state.assignments) {
      const target = this.chats.store.agentByKey(chat.id, assignment.target.key);
      if (!target || target.status !== "active") continue;
      const prior = assignment.consultId ? this.chats.store.consult(assignment.consultId) : undefined;
      // Finished before the pause (its log was still being archived): never run it again, just record it.
      if (prior?.status === "done") {
        if (assignment.planTask) this.updatePlanStep(chat.id, assignment.planTask, (s) => ({ ...s, status: "completed", consultIds: [...new Set([...(s.consultIds ?? []), prior.id])] }));
        continue;
      }
      const message = `[일시 정지한 작업 재시작]\n현재 파일과 이전 진행 상태를 확인하고 남은 부분만 이어가세요. 이미 완료된 변경은 반복하지 마세요.\n\n${assignment.message}${prior?.responseSummary ? `\n\n중지 전 진행 내용:\n${prior.responseSummary}` : ""}`;
      void this.consult(chat.id, assignment.caller, target, assignment.kind, message, assignment.scope, assignment.attach, "일시 정지한 기존 작업을 같은 담당자에게 재전달", prior?.id, assignment.effort, assignment.discussion, true, undefined, assignment.model, assignment.planTask).catch(error => {
        this.chats.emit(chat.id, target.key, target.key, { type: "error", message: `작업 재시작 실패: ${String(error)}` });
      });
      if (assignment.planTask) resumed.add(assignment.planTask.taskId);
    }
    this.reconcilePlanSteps(chat.id, resumed);
    try {
      const driver = await this.chats.driver(chat.id, "orch");
      if (this.stopped.has(chat.id) || this.epochs.get(chat.id) !== epoch) return;
      await driver.send({
        text: `[일시 정지 후 기존 지시 계속]\n${inst.text}\n\n같은 작업자에게 미완료 요청을 재전달했습니다. 이미 끝난 작업은 반복하거나 중복 배정하지 말고 현재 상태를 확인하세요. 기존 배정 결과를 기다려 검토·취합하세요. 만료된 승인·질문은 필요한 경우 다시 요청하세요.${this.planning.has(chat.id) ? "\n[계획 모드] 읽기 전용입니다. 작업자를 쓰지 말고 propose_plan으로 계획을 제출하세요." : ""}${this.takeQueued(chat.id)}`,
        attachments: [], noWrites: this.planning.has(chat.id),
      });
    } catch (error) {
      if (this.stopped.has(chat.id) || this.epochs.get(chat.id) !== epoch) return;
      this.chats.emit(chat.id, "orch", "orch", { type: "error", message: `마스터 재시작 실패: ${String(error)}` });
      this.chats.orchTurnEnded(chat.id, { type: "turn_end", ok: false, error: String(error) });
    }
  }

  forget(chatId: number) {
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
  const review = kind === "review" ? "\n[리뷰 결과 제출] 마치기 전에 report_review 도구(Claude: mcp__chatterbox_bridge__report_review)로 결론을 제출하세요. 도구를 쓸 수 없으면 문장으로 보고하세요." : "";
  return `[${from}의 ${CONSULT_KIND_LABEL[kind]} 요청${scope.length ? ` · 고칠 수 있는 범위: ${scope.join(", ")}` : ""} — 필요한 수정은 지정 범위와 승인 절차를 따르세요]${review}\n`;
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
