import { isAbsolute } from "node:path";
import { CHARACTER_PROVIDERS, type CharacterModel, type CharacterModels, type MeetingEvent, type MeetingMessage, type MeetingRequest, type MeetingSnapshot } from "../shared/character-meeting";
import { MONITOR_CHARACTERS, MONITOR_CHARACTER_LABEL, type MonitorCharacterId } from "../shared/usage-companion";
import type { CharacterChat } from "./character-chat";
import { exploreRepository } from "./council-repository";

type Participant = Exclude<MonitorCharacterId, "orch">;
type SpeakingTurn = { speaker: Participant; focus: string; keywords: string[] };
type DiscussionEntry = { speaker: Participant; focus: string; text: string };
type Event = MeetingEvent extends infer E ? E extends MeetingEvent ? Omit<E, "requestId" | "seq"> : never : never;
type MessageContent = Omit<MeetingMessage, "id" | "at">;
const MAX_TURNS = 6;
const DISCUSSION_TIMEOUT_MS = 350_000;
const OPENING_FOCUS = "안건에서 가장 먼저 정해야 할 항목 하나에 대해서만 의견을 주세요.";
const FOLLOWUP_FOCUS = "직전 발언을 받아 아직 정하지 못한 다음 항목 하나를 제안하거나 질문해 주세요.";

export class CharacterMeeting {
  private active?: { requestId: string; controller: AbortController; result: Promise<void> };
  private history: MeetingMessage[] = [];
  private drafts = new Map<string, MeetingMessage>();
  private seq = 0;
  private status = "";
  private members: MonitorCharacterId[] | undefined;

  constructor(
    private readonly chat: Pick<CharacterChat, "configured" | "meetingReply">,
    private readonly models: () => CharacterModels,
    private readonly publish: (event: MeetingEvent) => void,
    private readonly explore = exploreRepository,
  ) {}

  start(request: MeetingRequest): Promise<void> {
    if (this.active) throw new Error("다른 회의 안건을 처리 중이에요.");
    const controller = new AbortController();
    const result = Promise.resolve().then(() => this.run(request, controller.signal));
    this.active = { requestId: request.requestId, controller, result };
    return result;
  }

  snapshot(): MeetingSnapshot {
    return { seq: this.seq, requestId: this.active?.requestId ?? null, status: this.status,
      messages: this.history, drafts: [...this.drafts.values()], connected: this.members ?? this.availability().connected };
  }

  cancel(id: string) {
    if (this.active?.requestId === id) this.active.controller.abort();
  }

  async dispose() {
    this.active?.controller.abort();
    await this.active?.result;
  }

  private availability() {
    const settings = this.models();
    const providers = this.chat.configured();
    const members = MONITOR_CHARACTERS.filter((id): id is Participant => id !== "orch" && providers.includes(CHARACTER_PROVIDERS[id]));
    const first = members[0];
    const master = settings.orch ?? (first ? { agent: CHARACTER_PROVIDERS[first], model: "" } : undefined);
    const leader = master && providers.includes(master.agent) ? master : undefined;
    const connected: MonitorCharacterId[] = leader ? ["orch", ...members] : members;
    return { settings, members, first, leader, connected };
  }

  private async run({ requestId, text, folder }: MeetingRequest, signal: AbortSignal) {
    const emit = (event: Event) => this.publish({ ...event, requestId, seq: ++this.seq });
    const post = (content: MessageContent, draft?: MeetingMessage) => {
      signal.throwIfAborted();
      const message = { ...content, id: draft?.id ?? `${requestId}:${this.seq + 1}`, at: draft?.at ?? Date.now() };
      this.drafts.delete(message.id);
      this.history.push(message);
      this.history = this.history.slice(-45);
      emit({ type: "message", message });
      return message;
    };
    const status = (text: string) => { this.status = text; emit({ type: "status", text }); };
    const previous = this.history.slice(-14).map(message => ({ ...message, text: message.text.slice(0, 1_300) }));
    let end = "";
    try {
      post({ sender: "user", text });
      const { settings, members, first, leader: master, connected } = this.availability();
      this.members = connected;
      emit({ type: "roster", connected });
      if (!first || !master) {
        end = "회의를 진행하려면 마스터 모델과 에이전트 한 명 이상을 연결해 주세요.";
        return;
      }
      const discussionSignal = AbortSignal.any([signal, AbortSignal.timeout(DISCUSSION_TIMEOUT_MS)]);
      const ask = (choice: CharacterModel, input: object, phase: AbortSignal, timeout: number, onText?: (value: string) => void) =>
        this.chat.meetingReply(choice.agent, choice.model, { question: text, previous, ...input },
          AbortSignal.any([phase, AbortSignal.timeout(timeout)]), onText);
      const memberModel = (id: Participant) => settings[id] ?? { agent: CHARACTER_PROVIDERS[id], model: "" };
      const speak = async (sender: MonitorCharacterId, kind: "discussion" | "summary", choice: CharacterModel,
        input: object, phase: AbortSignal, timeout: number) => {
        phase.throwIfAborted();
        let message: MeetingMessage = { id: `${requestId}:${this.seq + 1}`, at: Date.now(), sender, kind, text: "" };
        let lastSent = 0;
        this.drafts.set(message.id, message);
        emit({ type: "draft", message });
        try {
          const result = await ask(choice, input, phase, timeout, value => {
            if (phase.aborted || Date.now() - lastSent < 105) return;
            lastSent = Date.now();
            message = { ...message, text: value };
            this.drafts.set(message.id, message);
            emit({ type: "draft", message });
          });
          phase.throwIfAborted();
          return post({ sender, kind, text: result }, message);
        } catch (error) {
          this.drafts.delete(message.id);
          emit({ type: "withdraw", id: message.id });
          throw error;
        }
      };

      const discussion: DiscussionEntry[] = [];
      const failed = new Set<Participant>();
      const transcript = () => discussion.map(turn => ({ ...turn, name: MONITOR_CHARACTER_LABEL[turn.speaker] }));
      let research: Awaited<ReturnType<CharacterMeeting["research"]>> | undefined;
      for (let step = 0; step < MAX_TURNS && !discussionSignal.aborted; step++) {
        const available = members.filter(member => !failed.has(member));
        if (!available.length) break;
        const last = discussion.at(-1)?.speaker;
        const alternates = available.filter(member => member !== last);
        const candidates = alternates.length ? alternates : available;
        const opening = discussion.length === 0;
        const minimumTurns = members.length > 1 && alternates.length ? 2 : 1;
        const mayConclude = discussion.length >= minimumTurns;
        status(opening ? "마스터가 첫 쟁점을 고르는 중…" : "마스터가 다음 발언을 고르는 중…");
        let turn: SpeakingTurn | "conclude";
        let moderated = true;
        try {
          const raw = await ask(master, {
            stage: opening ? "opening" : "moderate",
            task: opening
              ? "회의를 여세요. 안건 전체를 맡기지 말고, 가장 먼저 결정할 항목 하나를 구체적인 질문으로 좁히고 적합한 참가자에게 첫 답변만 요청하세요. 조사 폴더가 있으면 안건에서 검색할 키워드를 최대 세 개 고르세요. JSON 객체만 반환하세요. 형식은 {speaker: 참가자 ID, focus: 첫 질문, keywords: [검색어]}입니다."
              : "회의를 이어가세요. 가장 최근 발언에 직접 응답하거나 그 발언이 열어 준 다음 미결 쟁점 하나를 다룰 참가자를 고르세요. 같은 초안의 병렬 검토나 단순 동의 확인을 요청하지 마세요. 필요한 사람은 앞서 발언했어도 다시 부를 수 있습니다. 사용자가 명시한 항목이나 발언자가 아직 남았다면 이어가세요. 충분히 다뤘고 mayConclude가 true이면 {action:\"conclude\"}, 더 논의해야 하면 {speaker: 참가자 ID, focus: 다음에 다룰 한 가지 쟁점}을 반환하세요. 두 경우 모두 JSON 객체만 반환하세요.",
            members: candidates.map(id => ({ id, name: MONITOR_CHARACTER_LABEL[id] })),
            folderSelected: !!folder, discussion: transcript(), mayConclude, remainingTurns: MAX_TURNS - step,
          }, discussionSignal, opening ? 32_000 : 22_000);
          turn = parseFloor(raw, candidates, mayConclude);
        } catch {
          if (discussionSignal.aborted) break;
          moderated = false;
          const speaker = candidates.find(candidate => !discussion.some(entry => entry.speaker === candidate)) ?? candidates[0]!;
          turn = { speaker, focus: opening ? OPENING_FOCUS : FOLLOWUP_FOCUS, keywords: [] };
        }
        if (turn === "conclude" || discussionSignal.aborted) break;
        const { speaker, focus, keywords } = turn;
        if (opening) post({ sender: moderated ? "orch" : "system", kind: "assignment", text: `@${MONITOR_CHARACTER_LABEL[speaker]} · ${focus}` });
        if (!research) {
          try { research = await this.research(folder, keywords, text, discussionSignal); }
          catch (error) { if (discussionSignal.aborted) break; throw error; }
        }
        status(`${MONITOR_CHARACTER_LABEL[speaker]} 발언 중…`);
        try {
          const message = await speak(speaker, "discussion", memberModel(speaker), {
            stage: "speak",
            task: opening
              ? "첫 질문에 대한 발언 한 번만 하세요. 주어진 쟁점 하나에만 답하고 전체 계획, 나머지 쟁점, 최종 결론은 미루세요."
              : "같은 방에서 이야기하는 참가자입니다. 직전 발언의 구체적인 내용을 짚어 받아서 현재 쟁점에 제안 하나나 질문 하나를 더하세요. 조정이나 반론을 할 때도 대화를 앞으로 이끌어 주세요. 앞사람의 작업물을 채점하거나 앞선 발언을 반복하지 마세요.",
            focus, discussion: transcript(), research,
            format: "사용자와 다른 참가자가 듣는 짧은 발언으로 2~5문장만 작성하세요. 확인한 사실과 추정을 구분하고, 실제 파일 근거에 한해 경로와 줄 번호를 표시하세요.",
          }, discussionSignal, 55_000);
          discussion.push({ speaker, focus, text: message.text.slice(0, 2_500) });
        } catch {
          if (discussionSignal.aborted) break;
          failed.add(speaker);
          post({ sender: "system", text: `${MONITOR_CHARACTER_LABEL[speaker]}의 발언을 받지 못해 다음 참가자로 넘어갑니다.` });
        }
      }
      signal.throwIfAborted();
      if (!discussion.length) { end = "참가자 발언을 받지 못했어요. 모델 연결을 확인해 주세요."; return; }
      status("마스터가 회의 결과를 정리하는 중…");
      await speak("orch", "summary", master, {
        stage: "conclude",
        task: "회의 진행자로서 사용자 질문에 답하세요. 오간 발언에서 어떻게 제안이 발전했는지 필요한 만큼 반영하고, 합의·이견·미결 항목을 구분하세요. 발언이 없거나 검증되지 않은 사항을 합의 또는 사실로 쓰지 마세요. 실제 자료의 인용만 유지하세요.",
        discussion: transcript(), research,
      }, signal, 75_000);
      end = "회의를 마쳤어요.";
    } catch {
      end = signal.aborted ? "회의를 중단했어요." : "회의를 마치지 못했어요. 모델 연결이나 사용량을 확인해 주세요.";
    } finally {
      this.status = end;
      this.active = undefined;
      emit({ type: "end", text: end });
    }
  }

  private async research(folder: string | undefined, keywords: string[], question: string, signal: AbortSignal) {
    if (!folder || !isAbsolute(folder)) return { note: "선택된 조사 폴더가 없습니다. 학습 지식에 근거한 검토이며 외부 자료를 직접 확인하지 않았습니다." };
    const search = keywords.length ? keywords : question.match(/[\p{L}\p{N}_-]{2,}/gu)?.slice(0, 3) ?? [];
    const phase = AbortSignal.any([signal, AbortSignal.timeout(12_000)]);
    const searches = await Promise.allSettled(search.map(async term => ({
      term, ...await this.explore(folder, term, "grep", phase),
    })));
    signal.throwIfAborted();
    return {
      note: "사용자가 선택한 폴더에서 찾은 제한된 발췌입니다. 웹을 검색하지 않았습니다. 검색 실패와 미확인 자료를 구분하세요.",
      searches: searches.flatMap(result => result.status === "fulfilled" ? [result.value] : []),
      incomplete: searches.some(result => result.status === "rejected"),
    };
  }
}

function parseFloor(raw: string, members: Participant[], mayConclude: boolean): SpeakingTurn | "conclude" {
  const value = JSON.parse(raw.trim().replace(/^```(?:json)?\s*|\s*```$/gi, "")) as Partial<SpeakingTurn> & { action?: string };
  if (value?.action === "conclude" && mayConclude) return "conclude";
  if (!value?.speaker || !members.includes(value.speaker) || typeof value.focus !== "string" || !value.focus.trim())
    throw new Error("Invalid floor decision");
  const keywords = Array.isArray(value.keywords) ? value.keywords.filter(term =>
    typeof term === "string" && term.trim().length > 1 && term.length <= 64 && !/[\r\n]/.test(term)).slice(0, 3).map(term => term.trim()) : [];
  return { speaker: value.speaker, focus: value.focus.trim().slice(0, 360), keywords: [...new Set(keywords)] };
}
