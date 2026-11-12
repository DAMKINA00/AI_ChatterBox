// CLI accounts per family (Claude / Codex / Grok). `*-1` is the CLI's own default directory and
// keeps today's behavior; added accounts get a fresh directory under the app data folder and run
// with CLAUDE_CONFIG_DIR / CODEX_HOME / GROK_HOME pointing at it.
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import {
  CLI_ACCOUNT_KINDS,
  MAX_CLI_ACCOUNTS,
  cliAccountKindOf,
  defaultCliAccountId,
  isCliAccountId,
  priorityOrder,
  type CliAccount,
  type CliAccountId,
  type CliAccountKind,
  type CliAccountPolicies,
  type CliAccountPolicy,
  type ResolvedCliAccount,
} from "../shared/types";
import type { ProviderUsage } from "../shared/usage";

export const CLI_LOW_REMAINING = 10;
/** Older readings are unknown, never a full balance (same rule as Gemini web). */
export const CLI_USAGE_STALE_MS = 600_000;
const ACCOUNTS_SETTING = "cliAccounts";
/** Last generation per account ID, so a re-created ID never reuses an earlier one. */
const GENERATIONS_SETTING = "cliAccountGenerations";
const MARKERS_MIGRATED_SETTING = "cliAccountOwnerMarkersMigrated";
export const POLICY_SETTING = "cliAccountPolicy";
/** Written into every directory this app creates; deletion requires it. */
export const OWNER_MARKER = ".chatterbox-cli-account.json";

const samePath = (a: string, b: string) => process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;

export const CLI_ENV_VAR: Record<CliAccountKind, string> = { claude: "CLAUDE_CONFIG_DIR", gpt: "CODEX_HOME", grok: "GROK_HOME" };
/** Official sign-in / sign-out subcommands (claude auth --help, codex --help, grok --help). */
export const CLI_LOGIN_ARGS: Record<CliAccountKind, string[]> = { claude: ["auth", "login"], gpt: ["login"], grok: ["login"] };
export const CLI_LOGOUT_ARGS: Record<CliAccountKind, string[]> = { claude: ["auth", "logout"], gpt: ["logout"], grok: ["logout"] };

interface Settings { getSetting(key: string): string | undefined; setSetting(key: string, value: string): void }

/** Lowest remaining percent of the 5-hour and weekly windows; undefined when unread, failed or stale. */
export function cliRemaining(value: Pick<CliAccount, "usage"> | CliAccount["usage"] | undefined, now = Date.now()): number | undefined {
  const usage = value && "usage" in value && !("checkedAt" in value) ? value.usage : value as CliAccount["usage"];
  if (!usage || usage.error || !Number.isFinite(usage.checkedAt) || now - usage.checkedAt > CLI_USAGE_STALE_MS || usage.checkedAt > now + 60_000) return undefined;
  const values = [usage.fiveHour?.usedPercent, usage.weekly?.usedPercent]
    .filter((v): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 100).map(v => 100 - v);
  return values.length ? Math.min(...values) : undefined;
}

const sameKind = (kind: CliAccountKind, id: unknown): id is CliAccountId => isCliAccountId(id) && cliAccountKindOf(id) === kind;

export function validPolicy(kind: CliAccountKind, value: unknown): CliAccountPolicy | undefined {
  if (!value || typeof value !== "object") return undefined;
  const p = value as Record<string, unknown>;
  if (p.mode !== "fixed" && p.mode !== "auto" && p.mode !== "priority") return undefined;
  if (p.accountId !== undefined && !sameKind(kind, p.accountId)) return undefined;
  const policy: CliAccountPolicy = p.accountId ? { mode: p.mode, accountId: p.accountId as CliAccountId } : { mode: p.mode };
  // Only priority keeps an order; older files (fixed/auto without order) stay exactly as they were.
  if (p.mode === "priority" && p.order !== undefined) {
    if (!Array.isArray(p.order) || p.order.length > MAX_CLI_ACCOUNTS || !p.order.every(id => sameKind(kind, id))) return undefined;
    const order = [...new Set(p.order as CliAccountId[])];
    if (order.length) policy.order = order;
  }
  return policy;
}

/**
 * Provider (CLI account) usage or rate limits as Claude/Codex/Grok and their APIs word them. A bare
 * "quota" or "429" is not enough: disk/file-system quotas, max-turn/context limits and a line number
 * 429 are ordinary failures.
 */
const PROVIDER_LIMIT = new RegExp([
  String.raw`rate[ _-]?limit`, String.raw`usage[ _-]?limit`, String.raw`insufficient[ _-]?quota`,
  String.raw`exceeded your (?:current )?quota`, String.raw`(?:api|request|usage|token|plan|account|billing|subscription|monthly|daily|weekly)[ _-]?quota`,
  String.raw`quota[ _-]?(?:exceeded|exhausted|reached|limit)`, String.raw`resource[ _-]?exhausted`, String.raw`\btoo many requests\b`,
  String.raw`\byou(?:'ve|’ve| have) (?:hit|reached) your (?:usage |weekly |5-hour |session |daily |monthly )?limit\b`,
  String.raw`(?:5-hour|five-hour|weekly|session|daily|monthly) (?:usage )?limit(?: (?:reached|exceeded|hit))?\b`,
  String.raw`(?:계정|사용량|요청|구독|이용|잔여)\s*한도.{0,12}(?:소진|초과|부족)`, String.raw`^한도\s*(?:소진|초과|부족)`,
  String.raw`(?:status|code|http|error)\W{0,3}\s*429\b`, String.raw`\b429\b\W{0,3}(?:too many|rate|limit|quota)`,
].join("|"), "i");
const NOT_PROVIDER_LIMIT = /\b(?:disk|file ?system|filesystem|storage|inode|block|volume|user|group|mailbox)s?\s+quota\b|\bEDQUOT\b|quota\s+(?:exceeded\s+)?(?:on|for)\s+(?:disk|device|volume|file)/i;
export function isQuotaError(error: string | undefined): boolean {
  const text = error ?? "";
  return PROVIDER_LIMIT.test(text) && !NOT_PROVIDER_LIMIT.test(text);
}

/**
 * Sign-in failures of the CLI account itself, as Claude Code / Codex / Grok and this app word them,
 * plus an account taken out of assignment meanwhile. A bare 401, "Unauthorized" or "authentication
 * failed" is not enough: line numbers (app.ts:401) and the user's own servers or databases rejecting a
 * request are ordinary task failures. A 401 counts only as the CLI's API error or from a provider host.
 */
const PROVIDER_AUTH = new RegExp([
  String.raw`authentication_error`, String.raw`invalid[ _-]?(?:x-)?api[ _-]?key`, String.raw`please run /login`,
  String.raw`not (?:logged|signed) in\b`, String.raw`please (?:log|sign) ?in again`, String.raw`log out and sign in again`,
  String.raw`(?:oauth|access|refresh|authentication) token (?:has expired|is expired|expired|could not be refreshed|was revoked|is invalid)`,
  String.raw`\btoken_expired\b`, String.raw`refresh_token_(?:reused|expired|invalidated)`,
  String.raw`^api error: 401\b`, String.raw`\bapi error: 401 \{`,
  String.raw`\b401\b[^\n]{0,200}(?:api\.anthropic\.com|api\.openai\.com|chatgpt\.com|auth\.openai\.com|api\.x\.ai)`,
  String.raw`(?:api\.anthropic\.com|api\.openai\.com|chatgpt\.com|auth\.openai\.com|api\.x\.ai)[^\n]{0,200}\b401\b`,
  String.raw`run [\x60'"]?(?:claude|codex|grok) login\b`, String.raw`(?:grok|codex|claude) 로그인이 필요`,
  String.raw`CLI 계정 [a-z]+-\d+에 로그인되어 있지 않습니다`, String.raw`^로그인이 필요합니다`,
  String.raw`CLI 계정 [a-z]+-\d+은\(는\) 배정에서 제외되어 있`,
].join("|"), "im");
export function isAuthError(error: string | undefined): boolean {
  return PROVIDER_AUTH.test(error ?? "");
}

export type PriorityFailureReason = "quota" | "auth" | "unresponsive";
export const PRIORITY_FAILURE_LABEL: Record<PriorityFailureReason, string> = { quota: "한도 소진", auth: "인증 실패", unresponsive: "무응답" };
export const PRIORITY_COOLDOWN_MS: Record<PriorityFailureReason, number> = { quota: 30 * 60_000, auth: 30 * 60_000, unresponsive: 10 * 60_000 };
export interface PriorityFailure { reason: PriorityFailureReason; at: number; until: number }

const resetMs = (value: number | null | undefined) => typeof value === "number" && Number.isFinite(value) && value > 0 ? value > 1e12 ? value : value * 1000 : undefined;

/** Until when a failed account is passed over: a known future limit reset, otherwise a fixed cooldown. */
export function priorityFailure(reason: PriorityFailureReason, account: Pick<CliAccount, "usage"> | undefined, at = Date.now()): PriorityFailure {
  let until = at + PRIORITY_COOLDOWN_MS[reason];
  if (reason === "quota" && account?.usage && !account.usage.error) {
    const windows = [account.usage.fiveHour, account.usage.weekly, account.usage.monthly].filter(w => w && resetMs(w.resetsAt) !== undefined && resetMs(w.resetsAt)! > at);
    const exhausted = windows.filter(w => w!.usedPercent >= 100);
    const resets = (exhausted.length ? exhausted : windows).map(w => resetMs(w!.resetsAt)!);
    // An exhausted window resets at its own time; otherwise the latest known reset bounds the wait.
    if (resets.length) until = exhausted.length ? Math.max(...resets) : Math.min(...resets);
  }
  return { reason, at, until };
}

/**
 * A recorded failure applies until it expires. Early recovery is decided once, when a reading arrives
 * (priorityRecovered), and then removes the record, so an aging reading can never revive it.
 */
export function priorityFailureActive(failure: PriorityFailure | undefined, now = Date.now()): boolean {
  return !!failure && now < failure.until;
}

/** A newer check of the account; startedAt is when that reading or login check began. */
export interface PriorityEvidence { startedAt: number; remaining?: number; loggedIn?: boolean }

/**
 * Only a check that began after the failure counts. Limit: remaining > 0. Sign-in: a confirmed login.
 * No response: either remaining > 0 or a confirmed login.
 */
export function priorityRecovered(failure: PriorityFailure, evidence: PriorityEvidence): boolean {
  if (!(evidence.startedAt > failure.at)) return false;
  const usable = typeof evidence.remaining === "number" && evidence.remaining > 0;
  const loggedIn = evidence.loggedIn === true;
  return failure.reason === "quota" ? usable : failure.reason === "auth" ? loggedIn : usable || loggedIn;
}

/** Why a priority candidate is passed over before trying it; undefined = try it (unknown usage is tried). */
export function prioritySkipReason(account: CliAccount | undefined, failure: PriorityFailure | undefined, now = Date.now()): string | undefined {
  if (!account) return "미등록";
  if (!account.enabled) return "배정 제외";
  if (account.auth && !account.auth.loggedIn) return "로그인 필요";
  if (cliRemaining(account, now) === 0) return "잔여 0%";
  if (priorityFailureActive(failure, now)) return `최근 ${PRIORITY_FAILURE_LABEL[failure!.reason]}`;
  return undefined;
}

/** Keeps only well-formed families; unknown keys and malformed entries are dropped. */
export function sanitizePolicies(value: unknown): CliAccountPolicies {
  const out: CliAccountPolicies = {};
  if (!value || typeof value !== "object" || Array.isArray(value)) return out;
  for (const kind of CLI_ACCOUNT_KINDS) {
    const policy = validPolicy(kind, (value as Record<string, unknown>)[kind]);
    if (policy) out[kind] = policy;
  }
  return out;
}

/** Explicit accountId > project accountPolicy > app-wide cliAccountPolicy > fixed `*-1`. */
export function resolveAccountPolicy(kind: CliAccountKind, project: CliAccountPolicies | undefined, global: CliAccountPolicies | undefined, explicitId?: CliAccountId): ResolvedCliAccount {
  const projectPolicy = validPolicy(kind, project?.[kind]);
  const globalPolicy = validPolicy(kind, global?.[kind]);
  const base = projectPolicy ? { policy: projectPolicy, source: "project" as const }
    : globalPolicy ? { policy: globalPolicy, source: "global" as const }
    : { policy: { mode: "fixed" } as CliAccountPolicy, source: "default" as const };
  if (explicitId !== undefined) {
    if (!isCliAccountId(explicitId) || cliAccountKindOf(explicitId) !== kind) throw new Error(`${explicitId}은(는) ${kind} 계열 계정이 아닙니다.`);
    return { kind, mode: base.policy.mode, accountId: explicitId, source: "explicit", ...(base.policy.mode === "priority" ? { order: priorityOrder(kind, base.policy) } : {}) };
  }
  if (base.policy.mode === "priority") {
    const order = priorityOrder(kind, base.policy);
    return { kind, mode: "priority", accountId: order[0], source: base.source, order };
  }
  return { kind, mode: base.policy.mode, accountId: base.policy.accountId ?? defaultCliAccountId(kind), source: base.source };
}

/** Environment for a CLI process on this account; empty for the default directory. */
export function accountEnv(account: Pick<CliAccount, "kind" | "configDir"> | undefined): Record<string, string> {
  return account?.configDir ? { [CLI_ENV_VAR[account.kind]]: account.configDir } : {};
}

function validUsage(value: any): CliAccount["usage"] | undefined {
  return value && typeof value === "object" && Number.isFinite(value.checkedAt) ? value : undefined;
}

export class CliAccounts {
  private accounts: CliAccount[];

  constructor(readonly root: string, private settings: Settings) {
    let saved: unknown;
    try { saved = JSON.parse(settings.getSetting(ACCOUNTS_SETTING) ?? "[]"); } catch { saved = []; }
    const seen = new Set<string>();
    const list: CliAccount[] = [];
    for (const a of Array.isArray(saved) ? saved : []) {
      if (!a || !isCliAccountId(a.accountId) || seen.has(a.accountId)) continue;
      const kind = cliAccountKindOf(a.accountId);
      const isDefault = a.accountId === defaultCliAccountId(kind);
      // Only `*-1` uses the CLI's own directory; added accounts always live under our root.
      const configDir = isDefault ? null : this.dirOf(a.accountId);
      seen.add(a.accountId);
      list.push({
        accountId: a.accountId, kind, configDir,
        label: typeof a.label === "string" && a.label.trim() ? a.label.trim().slice(0, 60) : isDefault ? "기본 계정" : `계정 ${a.accountId.slice(kind.length + 1)}`,
        // The default account always stays assignable.
        enabled: isDefault || a.enabled !== false,
        createdAt: Number.isFinite(a.createdAt) ? a.createdAt : 0,
        ...(a.auth && typeof a.auth.loggedIn === "boolean" && Number.isFinite(a.auth.checkedAt) ? { auth: { loggedIn: a.auth.loggedIn, checkedAt: a.auth.checkedAt, ...(typeof a.auth.email === "string" ? { email: a.auth.email } : {}) } } : {}),
        ...(validUsage(a.usage) ? { usage: validUsage(a.usage) } : {}),
      });
    }
    for (const kind of CLI_ACCOUNT_KINDS)
      if (!seen.has(defaultCliAccountId(kind))) list.push({ accountId: defaultCliAccountId(kind), kind, label: "기본 계정", configDir: null, enabled: true, createdAt: 0 });
    this.accounts = list;
    this.adoptLegacy();
  }

  private dirOf(id: CliAccountId) { return join(this.root, id); }

  /** The root must be a real directory, never a junction or symbolic link. */
  private realRoot(create: boolean): string | undefined {
    if (create) mkdirSync(this.root, { recursive: true });
    let stat;
    try { stat = lstatSync(this.root); } catch { return undefined; }
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`CLI 계정 폴더 위치가 링크(junction) 또는 파일이라 사용하지 않습니다: ${this.root}`);
    return realpathSync.native(this.root);
  }

  /**
   * True only for a real directory directly under the real root, named after the account, holding
   * our ownership marker (itself a plain file) for that account and, when given, that generation.
   */
  private owned(id: CliAccountId, generation?: number): boolean {
    const root = this.realRoot(false);
    if (!root) return false;
    const dir = this.dirOf(id);
    try {
      const stat = lstatSync(dir);
      if (stat.isSymbolicLink() || !stat.isDirectory()) return false;
      const real = realpathSync.native(dir);
      if (!samePath(dirname(real), root) || basename(real).toLowerCase() !== id) return false;
      const marker = join(dir, OWNER_MARKER);
      const markerStat = lstatSync(marker);
      if (markerStat.isSymbolicLink() || !markerStat.isFile()) return false;
      const saved = JSON.parse(readFileSync(marker, "utf8"));
      return saved?.accountId === id && (generation === undefined || saved.createdAt === generation);
    } catch { return false; }
  }

  /** Deletes an account directory only after the ownership checks above. */
  private removeOwned(id: CliAccountId, generation?: number) {
    if (!existsSync(this.dirOf(id)) && !this.isLink(this.dirOf(id))) return;
    if (!this.owned(id, generation)) throw new Error(`앱이 만든 것으로 확인되지 않은 폴더라 삭제하지 않았습니다: ${this.dirOf(id)}`);
    rmSync(this.dirOf(id), { recursive: true, force: true });
  }

  private isLink(path: string) {
    try { return lstatSync(path).isSymbolicLink(); } catch { return false; }
  }

  private writeMarker(account: CliAccount) {
    writeFileSync(join(this.dirOf(account.accountId), OWNER_MARKER), JSON.stringify({ accountId: account.accountId, createdAt: account.createdAt, owner: "AI_ChatterBox" }), { flag: "wx" });
  }

  /** Accounts saved before ownership markers existed: adopt only plain directories at our exact path. */
  private adoptLegacy() {
    if (this.settings.getSetting(MARKERS_MIGRATED_SETTING) === "1") return;
    // Record the attempt first: a later restart must never re-authorize a replaced directory.
    this.settings.setSetting(MARKERS_MIGRATED_SETTING, "1");
    const generations = this.generations();
    let root: string | undefined;
    try { root = this.realRoot(false); } catch { return; }
    if (!root) return;
    for (const a of this.accounts) {
      if (!a.configDir || generations[a.accountId] !== undefined || existsSync(join(a.configDir, OWNER_MARKER))) continue;
      try {
        const stat = lstatSync(a.configDir);
        const real = realpathSync.native(a.configDir);
        if (!stat.isSymbolicLink() && stat.isDirectory() && samePath(dirname(real), root) && basename(real).toLowerCase() === a.accountId) this.writeMarker(a);
      } catch { /* missing or unreadable: never adopted */ }
    }
  }

  private generations(): Record<string, number> {
    try { const value = JSON.parse(this.settings.getSetting(GENERATIONS_SETTING) ?? "{}"); return value && typeof value === "object" ? value : {}; }
    catch { return {}; }
  }

  /** Changes whenever an account ID is removed and created again; sessions record it. */
  generation(id: CliAccountId): number | undefined {
    return this.accounts.find(a => a.accountId === id)?.createdAt;
  }
  private sorted() {
    return [...this.accounts].sort((a, b) => CLI_ACCOUNT_KINDS.indexOf(a.kind) - CLI_ACCOUNT_KINDS.indexOf(b.kind)
      || Number(a.accountId.slice(a.kind.length + 1)) - Number(b.accountId.slice(b.kind.length + 1)));
  }
  private save() { this.settings.setSetting(ACCOUNTS_SETTING, JSON.stringify(this.accounts)); }

  list(kind?: CliAccountKind): CliAccount[] {
    return this.sorted().filter(a => !kind || a.kind === kind).map(a => ({ ...a }));
  }
  get(id: CliAccountId): CliAccount | undefined {
    const a = this.accounts.find(x => x.accountId === id);
    return a && { ...a };
  }
  private must(id: CliAccountId): CliAccount {
    const a = isCliAccountId(id) ? this.accounts.find(x => x.accountId === id) : undefined;
    if (!a) throw new Error(`등록되지 않은 CLI 계정입니다: ${String(id)}`);
    return a;
  }

  /** A brand-new, empty configuration directory; the user signs in from a console afterwards. */
  create(kind: CliAccountKind, label?: string): CliAccount {
    if (!CLI_ACCOUNT_KINDS.includes(kind)) throw new Error("지원하지 않는 CLI 계열입니다.");
    if (label !== undefined && (typeof label !== "string" || label.trim().length > 60)) throw new Error("계정 이름은 60자 이하로 입력하세요.");
    const free = Array.from({ length: MAX_CLI_ACCOUNTS }, (_, i) => i + 1).filter(i => !this.accounts.some(a => a.accountId === `${kind}-${i}`));
    if (!free.length) throw new Error(`${kind} 계정은 최대 ${MAX_CLI_ACCOUNTS}개까지 만들 수 있습니다.`);
    this.realRoot(true);
    // Never adopt leftovers (they could hold someone else's credentials): our own are deleted,
    // anything unverified (junctions, foreign folders) is left alone and its number skipped.
    const n = free.find(i => {
      const id = `${kind}-${i}` as CliAccountId;
      const dir = this.dirOf(id);
      if (!existsSync(dir) && !this.isLink(dir)) return true;
      if (!this.owned(id)) return false;
      rmSync(dir, { recursive: true, force: true });
      return true;
    });
    if (!n) throw new Error(`앱이 만든 것으로 확인되지 않은 폴더가 있어 새 ${kind} 계정을 만들지 않았습니다. ${this.root} 안의 폴더를 확인하세요.`);
    const accountId = `${kind}-${n}` as CliAccountId;
    const dir = this.dirOf(accountId);
    mkdirSync(dir);
    const generations = this.generations();
    const createdAt = Math.max(Date.now(), (Number(generations[accountId]) || 0) + 1);
    const account: CliAccount = { accountId, kind, label: label?.trim() || `계정 ${n}`, configDir: dir, enabled: true, createdAt };
    this.writeMarker(account);
    this.settings.setSetting(GENERATIONS_SETTING, JSON.stringify({ ...generations, [accountId]: createdAt }));
    this.accounts.push(account);
    this.save();
    return { ...account };
  }

  update(id: CliAccountId, patch: { label?: string; enabled?: boolean }): CliAccount {
    const a = this.must(id);
    if (patch.label !== undefined && (typeof patch.label !== "string" || !patch.label.trim() || patch.label.trim().length > 60)) throw new Error("계정 이름은 1~60자로 입력하세요.");
    if (patch.enabled !== undefined && typeof patch.enabled !== "boolean") throw new Error("계정 배정 설정이 잘못되었습니다.");
    if (patch.enabled === false && !a.configDir) throw new Error("기본 계정(*-1)은 배정에서 제외할 수 없습니다.");
    if (patch.label !== undefined) a.label = patch.label.trim();
    if (patch.enabled !== undefined) a.enabled = patch.enabled;
    this.save();
    return { ...a };
  }

  /** Deletes an added account and only the directory this app created for it. */
  remove(id: CliAccountId) {
    const a = this.must(id);
    if (!a.configDir) throw new Error("기본 계정은 삭제할 수 없습니다.");
    this.realRoot(false);
    this.removeOwned(a.accountId, a.createdAt);
    this.accounts = this.accounts.filter(x => x !== a);
    this.save();
  }

  /** `generation` (from when a reading started) drops results meant for a removed/re-created account. */
  setAuth(id: CliAccountId, auth: CliAccount["auth"], generation?: number) {
    const a = this.accounts.find(x => x.accountId === id);
    if (!a || (generation !== undefined && a.createdAt !== generation)) return;
    if (auth) a.auth = auth; else delete a.auth;
    this.save();
  }

  /** Partial windows (Claude/Codex live events) keep the window they don't mention. */
  setUsage(id: CliAccountId, usage: ProviderUsage, partial: boolean, now = Date.now(), generation?: number) {
    const a = this.accounts.find(x => x.accountId === id);
    if (!a || (generation !== undefined && a.createdAt !== generation)) return;
    const cur = partial && !a.usage?.error ? a.usage : undefined;
    a.usage = usage.error ? { error: usage.error, checkedAt: now }
      : { ...cur, ...usage, fiveHour: usage.fiveHour ?? cur?.fiveHour, weekly: usage.weekly ?? cur?.weekly, checkedAt: now };
    for (const key of ["fiveHour", "weekly", "monthly"] as const) if (a.usage[key] === undefined) delete a.usage[key];
    this.save();
  }

  env(id: CliAccountId): Record<string, string> {
    return accountEnv(this.must(id));
  }

  policies(): CliAccountPolicies {
    try { return sanitizePolicies(JSON.parse(this.settings.getSetting(POLICY_SETTING) ?? "{}")); } catch { return {}; }
  }
  setPolicies(value: unknown): CliAccountPolicies {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("CLI 계정 정책 형식이 올바르지 않습니다.");
    const policies = sanitizePolicies(value);
    for (const kind of Object.keys(value as object))
      if (!(CLI_ACCOUNT_KINDS as readonly string[]).includes(kind) || !policies[kind as CliAccountKind]) throw new Error(`CLI 계정 정책이 올바르지 않습니다: ${kind}`);
    for (const policy of Object.values(policies))
      for (const id of [policy?.accountId, ...(policy?.order ?? [])])
        if (id && !this.accounts.some(a => a.accountId === id)) throw new Error(`등록되지 않은 CLI 계정입니다: ${id}`);
    this.settings.setSetting(POLICY_SETTING, JSON.stringify(policies));
    return policies;
  }
}
