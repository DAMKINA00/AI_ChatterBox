import { isAbsolute } from "node:path";
import { CHARACTER_PROVIDERS, MAX_MEETING_HISTORY, type CharacterModel, type CharacterModels, type MeetingEvent, type MeetingMessage, type MeetingRequest, type MeetingSnapshot } from "../shared/character-meeting";
import { MONITOR_CHARACTERS, MONITOR_CHARACTER_LABEL, type MonitorCharacterId } from "../shared/usage-companion";
import type { CharacterChat } from "./character-chat";
import { exploreRepository } from "./council-repository";
import { agendaUrls, type WebLookup, type WebSource } from "./boardroom-web";
import { readCredits, STRENGTHS, type BoardroomMemory, type Credit, type ModelIdentity } from "./boardroom-memory";
import type { BoardroomHistory } from "./boardroom-history";

type Participant = Exclude<MonitorCharacterId, "orch">;
type SpeakingTurn = { speaker: Participant; focus: string; keywords: string[]; mode: "reply" | "interject" | "reaction"; webQuery?: string };
type DiscussionKind = "discussion" | "interjection" | "agreement" | "objection" | "evidence";
type DiscussionEntry = { speaker: Participant; focus: string; text: string; kind: DiscussionKind };
type MeetingServices = { web?: (lookup: WebLookup, signal: AbortSignal) => Promise<WebSource[]>; memory?: BoardroomMemory; history?: BoardroomHistory };
type Event = MeetingEvent extends infer E ? E extends MeetingEvent ? Omit<E, "requestId" | "seq"> : never : never;
type MessageContent = Omit<MeetingMessage, "id" | "at">;
const MAX_TURNS = 6;
const MAX_REACTIONS = 2;
const MAX_WEB_LOOKUPS = 3;
const DISCUSSION_TIMEOUT_MS = 350_000;
const OPENING_FOCUS = "안건에서 가장 먼저 정해야 할 항목 하나에 대해서만 의견을 주세요.";
const FOLLOWUP_FOCUS = "직전 발언을 받아 아직 정하지 못한 다음 항목 하나를 제안하거나 질문해 주세요.";

export class CharacterMeeting {
  private active?: { requestId: string; controller: AbortController; result: Promise<void> };
  private history: MeetingMessage[] = [];
  private drafts = new Map<string, MeetingMessage>();
  private seq = 0;
  private status = "";
  private roster?: { connected: MonitorCharacterId[]; resting: MonitorCharacterId[] };

  constructor(
    private readonly chat: Pick<CharacterChat, "configured" | "meetingReply" | "meetingEligibility">,
    private readonly models: () => CharacterModels,
    private readonly publish: (event: MeetingEvent) => void,
    private readonly explore = exploreRepository,
    private readonly services: MeetingServices = {},
  ) {
    const saved = services.history?.load();
    if (saved) {
      this.history = saved.messages;
      this.seq = saved.seq;
      this.status = saved.status;
    }
  }

  start(request: MeetingRequest): Promise<void> {
    if (this.active) throw new Error("다른 회의 안건을 처리 중이에요.");
    const controller = new AbortController();
    const result = Promise.resolve().then(() => this.run(request, controller.signal));
    this.active = { requestId: request.requestId, controller, result };
    return result;
  }

  snapshot(): MeetingSnapshot {
    const { connected, resting } = (this.active && this.roster) || this.availability();
    return { seq: this.seq, requestId: this.active?.requestId ?? null, status: this.status,
      messages: this.history, drafts: [...this.drafts.values()], connected, resting };
  }

  cancel(id: string) {
    if (this.active?.requestId === id) this.active.controller.abort();
  }

  async dispose() {
    this.active?.controller.abort();
    await this.active?.result;
  }

  private saveHistory(status: string) {
    try { this.services.history?.save({ seq: this.seq + 1, status, messages: this.history }); }
    catch { return false; }
    return true;
  }

  private availability(settings = this.models(), providers = this.chat.configured()) {
    const state = new Map(providers.map(agent => [agent, this.chat.meetingEligibility(agent)]));
    const participants = MONITOR_CHARACTERS.filter((id): id is Participant => id !== "orch");
    const members = participants.filter(id => state.get(CHARACTER_PROVIDERS[id]) === "available");
    const resting: MonitorCharacterId[] = participants.filter(id => state.get(CHARACTER_PROVIDERS[id]) === "resting");
    const preferred = settings.orch;
    const preferredState = preferred && state.get(preferred.agent);
    const first = members[0];
    const fallback = first ? { agent: CHARACTER_PROVIDERS[first], model: "" } : undefined;
    const leader = preferredState === "available" ? preferred : !preferred || preferredState === "resting" ? fallback : undefined;
    const masterResting = !leader && (preferredState === "resting" || (!preferred && resting.length > 0));
    if (masterResting) resting.unshift("orch");
    const connected = MONITOR_CHARACTERS.filter(id => (id === "orch" && !!leader) || resting.includes(id) || (id !== "orch" && members.includes(id)));
    return { members, leader, connected, resting };
  }

  private async run({ requestId, text, folder }: MeetingRequest, signal: AbortSignal) {
    const emit = (event: Event) => this.publish({ ...event, requestId, seq: ++this.seq });
    const post = (content: MessageContent, draft?: MeetingMessage) => {
      signal.throwIfAborted();
      const message = { ...content, id: draft?.id ?? `${requestId}:${this.seq + 1}`, at: draft?.at ?? Date.now() };
      this.drafts.delete(message.id);
      this.history.push(message);
      this.history = this.history.slice(-MAX_MEETING_HISTORY);
      this.saveHistory("앱 종료로 진행 중이던 회의가 중단됐어요.");
      emit({ type: "message", message });
      return message;
    };
    const status = (text: string) => { this.status = text; emit({ type: "status", text }); };
    const previous = this.history.slice(-14).map(message => ({ ...message, text: message.text.slice(0, 1_300) }));
    let end = "";
    try {
      post({ sender: "user", text });
      const settings = this.models();
      const providers = this.chat.configured();
      this.roster = undefined;
      const refreshRoster = () => {
        const { connected, resting, ...floor } = this.availability(settings, providers);
        if (this.roster?.connected.join() !== connected.join() || this.roster?.resting.join() !== resting.join()) {
          this.roster = { connected, resting };
          emit({ type: "roster", connected, resting });
        }
        return { ...floor, resting };
      };
      const start = refreshRoster();
      if (!start.members.length || !start.leader) {
        end = start.resting.length ? "잔여 사용량을 확인해 주세요. 지금 회의를 진행할 모델이 부족해요."
          : "회의를 진행하려면 마스터 모델과 에이전트 한 명 이상을 연결해 주세요.";
        return;
      }
      const discussionSignal = AbortSignal.any([signal, AbortSignal.timeout(DISCUSSION_TIMEOUT_MS)]);
      const ask = (choice: CharacterModel, input: object, phase: AbortSignal, timeout: number, onText?: (value: string) => void,
        onModel?: (model: string) => void) =>
        this.chat.meetingReply(choice.agent, choice.model, { question: text, previous, ...input },
          AbortSignal.any([phase, AbortSignal.timeout(timeout)]), onText, onModel);
      const memberModel = (id: Participant) => settings[id] ?? { agent: CHARACTER_PROVIDERS[id], model: "" };
      const speak = async (sender: MonitorCharacterId, kind: DiscussionKind | "summary", choice: CharacterModel,
        input: object, phase: AbortSignal, timeout: number, onModel?: (model: string) => void) => {
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
          }, onModel);
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
      const identities = new Map<number, ModelIdentity>();
      const credits: Credit[] = [];
      const memory = this.services.memory;
      const transcript = () => discussion.map((turn, index) => ({ ...turn, turn: index + 1, name: MONITOR_CHARACTER_LABEL[turn.speaker] }));
      const record = (turn: DiscussionEntry, model: string | undefined) => {
        discussion.push(turn);
        if (model) identities.set(discussion.length, { agent: CHARACTER_PROVIDERS[turn.speaker], model });
      };
      const urls = agendaUrls(text);
      const explicitSearch = /(?:웹\s*(?:검색|조회)|인터넷\s*검색|검색해|검색해서|찾아봐|찾아\s*줘|조회해|\b(?:search|look up|browse)\b)/iu.test(text);
      const webSources = new Map<string, WebSource>();
      const webAttempts = new Set<string>();
      let webNote = "이번 안건에서 웹 자료를 아직 조회하지 않았습니다.";
      const webContext = () => ({ sources: [...webSources.values()], note: webNote });
      const lookup = async (query: string | undefined, links: string[] = []) => {
        if (!query && !links.length) return;
        const key = JSON.stringify([query?.toLowerCase().replace(/\s+/g, " "), links]);
        if (webAttempts.size >= MAX_WEB_LOOKUPS || webAttempts.has(key)) return;
        webAttempts.add(key);
        if (!this.services.web || !providers.includes("codex") || this.chat.meetingEligibility("codex") !== "available") {
          webNote = "웹 조사에 사용할 수 있는 Codex 연결이 없습니다.";
          return;
        }
        status("공개 웹 자료를 확인하는 중…");
        try {
          const sources = await this.services.web({ query, urls: links },
            AbortSignal.any([discussionSignal, AbortSignal.timeout(48_000)]));
          if (discussionSignal.aborted) return;
          const fresh = sources.filter(source => !webSources.has(source.url));
          for (const source of fresh) webSources.set(source.url, source);
          webNote = webSources.size ? "공유된 페이지 요약과 검색 발췌만 웹 근거로 사용하세요. kind=search는 원문을 읽은 자료가 아닙니다. 출처가 뒷받침하지 않는 내용은 미확인으로 남기세요."
            : "웹 조회를 시도했지만 열람을 확인할 수 있는 출처를 받지 못했습니다.";
          if (fresh.length) post({ sender: "system", kind: "sources",
            text: fresh.map(source => `[${source.title}](${source.url})${source.kind === "search" ? " · 검색 결과" : ""}`).join("\n") });
        } catch {
          webNote = "웹 조회가 완료되지 않았습니다. 웹에서 확인한 사실로 쓰지 마세요.";
        }
      };
      let research: Awaited<ReturnType<CharacterMeeting["research"]>> | undefined;
      let reactions = 0, substantive = 0;
      for (let step = 0; step < MAX_TURNS + MAX_REACTIONS && substantive < MAX_TURNS && !discussionSignal.aborted; step++) {
        const { members, leader: master } = refreshRoster();
        if (!master) break;
        const available = members.filter(member => !failed.has(member));
        if (!available.length) break;
        const last = discussion.at(-1)?.speaker;
        const alternates = available.filter(member => member !== last);
        const candidates = alternates.length ? alternates : available;
        const opening = discussion.length === 0;
        const minimumTurns = members.length > 1 && alternates.length ? 2 : 1;
        const mayConclude = substantive >= minimumTurns;
        status(opening ? "마스터가 첫 쟁점을 고르는 중…" : "마스터가 다음 발언을 고르는 중…");
        let turn: SpeakingTurn | "conclude";
        let moderated = true;
        try {
          const raw = await ask(master, {
            stage: opening ? "opening" : "moderate",
            task: (opening
              ? "안건에서 먼저 결정할 질문 하나만 적합한 참가자에게 물어보세요. 조사 폴더가 있으면 검색할 키워드를 최대 세 개 고르세요."
              : "쟁점이 남아 있으면 이미 대화 중인 두 사람이 서로 응답하도록 하세요. 순서를 채우려고 참가자를 호출하지 마세요. 다른 참가자가 새 근거나 중요한 반론을 보탤 수 있으면 interject로 끼어들게 하세요. 반응할 의미가 있을 때만 짧은 동의나 이의 여부를 reaction으로 물으세요. 사용자가 요청한 항목을 충분히 다뤘고 mayConclude가 true이면 action을 conclude로 반환하세요.") +
              " members의 모델 강점 기록은 예전 회의에서 실제 기여한 항목입니다. 현재 쟁점이 그 강점과 맞을 때 발언자 선정에 활용하세요. 최신 정보나 외부 확인이 필요한 경우에만 webQuery에 기관·지역·시점 등 공개 키워드를 넣으세요. 개인 정보와 비공개 자료는 검색어에 포함하지 마세요. JSON 객체 {speaker, focus, mode:\"reply\"|\"interject\"|\"reaction\", keywords?, webQuery?, credits?} 또는 {action:\"conclude\", credits?}만 반환하세요. credits는 실제 토론에서 유용한 기여를 한 발언에만 [{turn, strength}]로 적으세요.",
            members: candidates.map(id => {
              const choice = memberModel(id);
              return { id, name: MONITOR_CHARACTER_LABEL[id], strengths: memory?.hints(choice.agent, choice.model) };
            }),
            strengthCategories: memory ? STRENGTHS : undefined,
            folderSelected: !!folder, discussion: transcript(), webAlreadyChecked: [...webSources.keys()], mayConclude,
            remainingTurns: MAX_TURNS - substantive, remainingReactions: MAX_REACTIONS - reactions,
          }, discussionSignal, opening ? 32_000 : 22_000);
          const decision = parseFloor(raw, candidates, mayConclude, !opening && reactions < MAX_REACTIONS);
          turn = decision.turn;
          credits.push(...decision.credits);
        } catch {
          if (discussionSignal.aborted) break;
          moderated = false;
          const speaker = discussion.findLast(entry => entry.speaker !== last
            && entry.kind !== "agreement" && entry.kind !== "objection" && candidates.includes(entry.speaker))?.speaker ?? candidates[0]!;
          turn = { speaker, focus: opening ? OPENING_FOCUS : FOLLOWUP_FOCUS, keywords: [], mode: "reply" };
        }
        if (turn === "conclude" || discussionSignal.aborted) break;
        const { speaker, focus, keywords, mode, webQuery } = turn;
        if (opening) post({ sender: moderated ? "orch" : "system", kind: "assignment", text: `@${MONITOR_CHARACTER_LABEL[speaker]} · ${focus}` });
        if (!research) {
          try { research = await this.research(folder, keywords, text, discussionSignal); }
          catch (error) { if (discussionSignal.aborted) break; throw error; }
        }
        const fallbackQuery = opening && explicitSearch && !urls.length ? searchQuery(text) : undefined;
        if (mode !== "reaction") await lookup(webQuery ?? fallbackQuery, opening ? urls : []);
        if (discussionSignal.aborted) break;
        status(`${MONITOR_CHARACTER_LABEL[speaker]} 발언 중…`);
        const choice = memberModel(speaker);
        let model = choice.model || undefined;
        const selected = (value: string) => { model = value; };
        try {
          if (mode === "reaction") {
            reactions++;
            const reaction = parseReaction(await ask(choice, {
              stage: "react", focus, discussion: transcript(), research, web: webContext(),
              task: "요청받은 직전 의견의 구체적인 지점 하나만 판단하세요. 덧붙일 내용이 없으면 {kind:\"pass\"}. 동의하면 이유를 한 문장으로 {kind:\"agree\",text}. 이의가 있으면 반대 지점만 한 문장으로 {kind:\"object\",text,webQuery?}. 근거 설명은 다음 발언에서 하므로 지금은 넣지 마세요. 웹 확인이 필요할 때는 공개 키워드만 webQuery에 쓰세요. JSON만 반환하세요.",
            }, discussionSignal, 23_000, undefined, selected));
            if (!reaction || discussionSignal.aborted) continue;
            const kind = reaction.kind === "agree" ? "agreement" : "objection";
            post({ sender: speaker, kind, text: reaction.text });
            record({ speaker, focus, kind, text: reaction.text }, model);
            if (reaction.kind === "object") {
              await lookup(reaction.webQuery ?? webQuery);
              status(`${MONITOR_CHARACTER_LABEL[speaker]}의 이의 근거를 듣는 중…`);
              const message = await speak(speaker, "evidence", choice, {
                stage: "evidence", focus, discussion: transcript(), research, web: webContext(),
                task: "방금 본인이 제기한 이의에 대해 근거를 별도 발언으로 설명하세요. 공유 검색 결과 또는 조사 파일이 뒷받침하는 범위를 밝히고 출처 링크를 쓰세요. 확인하지 못했다면 확인 조건을 제시하세요.",
              }, discussionSignal, 42_000, selected);
              record({ speaker, focus, kind: "evidence", text: message.text.slice(0, 2_500) }, model);
              substantive++;
            }
            continue;
          }
          const kind = mode === "interject" && !opening ? "interjection" : "discussion";
          const message = await speak(speaker, kind, choice, {
            stage: "speak",
            task: opening
              ? "첫 질문에 대한 발언 한 번만 하세요. 주어진 쟁점 하나에만 답하고 전체 계획, 나머지 쟁점, 최종 결론은 미루세요."
              : "같은 방에서 말하는 참가자입니다. 답변이면 직전 발언에 바로 답하세요. 끼어들기라면 대화 방향을 바꿀 새 근거나 빠진 관점을 한 가지 보태세요. 앞선 발언을 반복하거나 보고서 전체를 채점하지 마세요.",
            focus, mode, discussion: transcript(), research, web: webContext(),
            format: "사용자와 다른 참가자가 듣는 짧은 발언으로 2~5문장만 작성하세요. 확인한 사실과 추정을 구분하고, 실제 파일 근거에 한해 경로와 줄 번호를 표시하세요.",
          }, discussionSignal, 55_000, selected);
          record({ speaker, focus, kind, text: message.text.slice(0, 2_500) }, model);
          substantive++;
        } catch {
          if (discussionSignal.aborted) break;
          failed.add(speaker);
          post({ sender: "system", text: `${MONITOR_CHARACTER_LABEL[speaker]}의 발언을 받지 못해 다음 참가자로 넘어갑니다.` });
        }
      }
      signal.throwIfAborted();
      const { leader: master, resting } = refreshRoster();
      if (!discussion.length) { end = "참가자 발언을 받지 못했어요. 모델 연결을 확인해 주세요."; return; }
      if (!master) {
        end = resting.length ? "잔여 사용량이 낮아 회의 결론을 정리하지 못했어요." : "회의를 정리할 마스터 모델에 연결할 수 없어요.";
        return;
      }
      status("마스터가 회의 결과를 정리하는 중…");
      await speak("orch", "summary", master, {
        stage: "conclude",
        task: "회의 진행자로서 사용자 질문에 답하세요. 오간 발언에서 어떻게 제안이 발전했는지 필요한 만큼 반영하고, 합의·이견·미결 항목을 구분하세요. 발언이 없거나 검증되지 않은 사항을 합의 또는 사실로 쓰지 마세요. 실제 자료의 인용만 유지하세요.",
        discussion: transcript(), research, web: webContext(),
      }, signal, 75_000);
      if (memory && identities.size) {
        try {
          if (!credits.some(credit => credit.turn === discussion.length)) {
            const raw = await ask(master, {
              stage: "assess", discussion: transcript(), strengthCategories: STRENGTHS,
              task: "이번 회의에서 실제로 도움이 된 발언만 평가하세요. 행동에서 드러난 강점만 골라 JSON {credits:[{turn, strength}]}로 반환하세요. 말투, 모델 자기소개, 단순 동의만으로 강점을 기록하지 마세요.",
            }, signal, 16_000).catch(() => "");
            if (raw) credits.push(...readCredits(jsonObject(raw)?.credits));
          }
          signal.throwIfAborted();
          memory.learn(credits, identities);
        }
        catch { /* A local settings failure should not discard the finished conversation. */ }
      }
      signal.throwIfAborted();
      end = "회의를 마쳤어요.";
    } catch {
      end = signal.aborted ? "회의를 중단했어요." : "회의를 마치지 못했어요. 모델 연결이나 사용량을 확인해 주세요.";
    } finally {
      if (!this.saveHistory(end)) end += " 회의 기록을 저장하지 못했어요.";
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

function jsonObject(raw: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(raw.trim().replace(/^```(?:json)?\s*|\s*```$/gi, ""));
    if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  } catch { /* The caller can continue with the transcript if a model emits invalid JSON. */ }
}

function searchQuery(value: unknown): string | undefined {
  if (typeof value !== "string") return;
  return value.replace(/https?:\/\/\S+/gi, "").replace(/\s+/g, " ").trim().slice(0, 220) || undefined;
}

function parseFloor(raw: string, members: Participant[], mayConclude: boolean, mayReact: boolean): { turn: SpeakingTurn | "conclude"; credits: Credit[] } {
  const value = jsonObject(raw) as (Partial<SpeakingTurn> & { action?: unknown; credits?: unknown }) | undefined;
  const credits = readCredits(value?.credits);
  if (value?.action === "conclude" && mayConclude) return { turn: "conclude", credits };
  if (!value?.speaker || !members.includes(value.speaker) || typeof value.focus !== "string" || !value.focus.trim())
    throw new Error("Invalid floor decision");
  const keywords = Array.isArray(value.keywords) ? value.keywords.filter(term =>
    typeof term === "string" && term.trim().length > 1 && term.length <= 64 && !/[\r\n]/.test(term)).slice(0, 3).map(term => term.trim()) : [];
  const mode = value.mode === "interject" ? "interject" : value.mode === "reaction" && mayReact ? "reaction" : "reply";
  return { turn: { speaker: value.speaker, focus: value.focus.trim().slice(0, 360), keywords: [...new Set(keywords)],
    mode, webQuery: searchQuery(value.webQuery) }, credits };
}

function parseReaction(raw: string) {
  const value = jsonObject(raw);
  if (!value || (value.kind !== "agree" && value.kind !== "object") || typeof value.text !== "string" || !value.text.trim()) return;
  return { kind: value.kind, text: value.text.replace(/\s+/g, " ").trim().slice(0, 260), webQuery: searchQuery(value.webQuery) };
}
