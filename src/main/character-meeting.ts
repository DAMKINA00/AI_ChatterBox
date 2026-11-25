import { isAbsolute } from "node:path";
import { CHARACTER_PROVIDERS, type CharacterModel, type CharacterModels, type MeetingEvent, type MeetingMessage, type MeetingRequest, type MeetingSnapshot } from "../shared/character-meeting";
import { MONITOR_CHARACTERS, MONITOR_CHARACTER_LABEL, type MonitorCharacterId } from "../shared/usage-companion";
import type { CharacterChat } from "./character-chat";
import { exploreRepository } from "./council-repository";

type Participant = Exclude<MonitorCharacterId, "orch">;
type Agenda = { assignee: Participant; task: string; keywords: string[] };
type Event = MeetingEvent extends infer E ? E extends MeetingEvent ? Omit<E, "requestId" | "seq"> : never : never;
type MessageContent = Omit<MeetingMessage, "id" | "at">;

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
      const ask = (choice: CharacterModel, input: object, timeout = 65_000, onText?: (value: string) => void) =>
        this.chat.meetingReply(choice.agent, choice.model, { question: text, previous, ...input },
          AbortSignal.any([signal, AbortSignal.timeout(timeout)]), onText);
      const memberModel = (id: Participant) => settings[id] ?? { agent: CHARACTER_PROVIDERS[id], model: "" };
      const speak = async (sender: MonitorCharacterId, kind: NonNullable<MeetingMessage["kind"]>, choice: CharacterModel, input: object, timeout?: number) => {
        let message: MeetingMessage = { id: `${requestId}:${kind}:${sender}`, at: Date.now(), sender, kind, text: "" };
        let lastSent = 0;
        this.drafts.set(message.id, message);
        emit({ type: "draft", message });
        try {
          const result = await ask(choice, input, timeout, value => {
            if (signal.aborted || Date.now() - lastSent < 105) return;
            lastSent = Date.now();
            message = { ...message, text: value };
            this.drafts.set(message.id, message);
            emit({ type: "draft", message });
          });
          return post({ sender, kind, text: result }, message);
        } catch (error) {
          this.drafts.delete(message.id);
          emit({ type: "withdraw", id: message.id });
          throw error;
        }
      };

      status("마스터가 안건을 읽는 중…");
      let agenda: Agenda;
      try {
        const raw = await ask(master, {
          task: "회의 진행을 맡은 마스터입니다. 안건에 맞는 에이전트 한 명을 명단에서 지명하고 그가 검토할 내용을 한 문장으로 적으세요. 조사 폴더가 있으면 파일 내용에서 검색할 짧고 구체적인 키워드를 최대 3개 고르세요. JSON 객체만 반환하세요. 형식은 {assignee: 참가자 ID, task: 검토 내용, keywords: [검색어]}입니다.",
          members: members.map(id => ({ id, name: MONITOR_CHARACTER_LABEL[id] })), folderSelected: !!folder,
        }, 32_000);
        agenda = parseAgenda(raw, members);
        post({ sender: "orch", kind: "assignment", text: `@${MONITOR_CHARACTER_LABEL[agenda.assignee]} · ${agenda.task}` });
      } catch {
        signal.throwIfAborted();
        agenda = { assignee: first, task: "사용자의 안건을 검토하고 결과를 발표해 주세요.", keywords: [] };
        post({ sender: "system", kind: "assignment", text: `마스터 지명을 받지 못해 ${MONITOR_CHARACTER_LABEL[first]}에게 검토를 맡겼어요.` });
      }

      const research = await this.research(folder, agenda.keywords, text, signal);
      let report: string | undefined;
      for (const assignee of [agenda.assignee, ...members.filter(id => id !== agenda.assignee)]) {
        signal.throwIfAborted();
        status(`${MONITOR_CHARACTER_LABEL[assignee]} 검토 중…`);
        try {
          report = (await speak(assignee, "report", memberModel(assignee), {
            task: `회의에서 지명된 담당자입니다. ${agenda.task} 조사 결과나 분석을 발표하고, 확인한 사항과 추정을 구분하세요. 파일 근거는 경로와 줄 번호를 표시하세요. 답변은 1800자 안으로 작성하세요.`,
            research,
          })).text;
        } catch {
          signal.throwIfAborted();
          post({ sender: "system", text: `${MONITOR_CHARACTER_LABEL[assignee]}의 답변을 받지 못했어요.` });
          continue;
        }
        agenda.assignee = assignee;
        break;
      }
      if (!report) { end = "조사 보고를 받지 못했어요. 모델 연결을 확인해 주세요."; return; }

      const reviews: MeetingMessage[] = [];
      const peers = members.filter(id => id !== agenda.assignee);
      if (peers.length) status("참가자들이 조사 결과를 검토하는 중…");
      await Promise.all(peers.map(async member => {
        try {
          const review = await speak(member, "review", memberModel(member), {
            task: "다른 참가자의 발표를 검토하세요. 동의하거나 바로잡을 점 또는 빠진 관점을 750자 안으로 적고, 확인할 수 없는 것은 구분하세요.",
            report: { sender: MONITOR_CHARACTER_LABEL[agenda.assignee], text: report.slice(0, 4_000) }, research,
          }, 45_000);
          reviews.push(review);
        } catch {
          if (!signal.aborted) post({ sender: "system", text: `${MONITOR_CHARACTER_LABEL[member]}의 검토 의견을 받지 못했어요.` });
        }
      }));
      signal.throwIfAborted();
      status("마스터가 회의 결과를 정리하는 중…");
      await speak("orch", "summary", master, {
        task: "회의 진행자로서 사용자 질문에 답하고, 담당자의 발견, 참가자들이 합의한 사항, 남은 이견이나 미확인 사항을 정리하세요. 자료에 실제로 있는 인용만 유지하세요.",
        report: { sender: MONITOR_CHARACTER_LABEL[agenda.assignee], text: report.slice(0, 4_000) },
        reviews: reviews.map(review => ({ sender: review.sender, text: review.text.slice(0, 1_800) })), research,
      });
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

function parseAgenda(raw: string, members: Participant[]): Agenda {
  const value = JSON.parse(raw.trim().replace(/^```(?:json)?\s*|\s*```$/gi, "")) as Partial<Agenda>;
  if (!value.assignee || !members.includes(value.assignee) || typeof value.task !== "string" || !value.task.trim())
    throw new Error("Invalid assignment");
  const keywords = Array.isArray(value.keywords) ? value.keywords.filter(term =>
    typeof term === "string" && term.trim().length > 1 && term.length <= 64 && !/[\r\n]/.test(term)).slice(0, 3).map(term => term.trim()) : [];
  return { assignee: value.assignee, task: value.task.trim().slice(0, 360), keywords: [...new Set(keywords)] };
}
