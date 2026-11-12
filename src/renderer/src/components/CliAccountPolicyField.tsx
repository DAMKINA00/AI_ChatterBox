import { CLI_ACCOUNT_MODE_LABEL, defaultCliAccountId, priorityOrder, type CliAccountId, type CliAccountStatus, type CliAccountPolicy } from "../../../shared/types";
import { CLI_KIND_LABEL, type CliKind } from "../lib/cli-accounts-ui";

const selectClass = "h-8 min-w-0 rounded-md border border-input bg-background px-2 text-[12px] text-foreground focus-visible:ring-2 focus-visible:ring-ring/60 disabled:opacity-50 [color-scheme:light] dark:[color-scheme:dark]";
const moveClass = "h-6 rounded border border-input px-1.5 text-[11px] hover:bg-accent disabled:opacity-40";

/** Order list for the priority mode: included accounts in order, then the rest (not tried). */
function PriorityOrderList({ kind, choices, order, disabled, onChange }: {
  kind: CliKind;
  choices: CliAccountStatus[];
  order: CliAccountId[];
  disabled: boolean;
  onChange: (order: CliAccountId[]) => void;
}) {
  const rest = choices.filter(account => !order.includes(account.accountId));
  const move = (index: number, delta: number) => {
    const next = [...order];
    [next[index], next[index + delta]] = [next[index + delta], next[index]];
    onChange(next);
  };
  const label = (id: CliAccountId) => {
    const account = choices.find(a => a.accountId === id);
    if (!account) return `${id} · 목록에서 확인할 수 없음`;
    return `${account.label} · ${id}${account.isDefault ? " · 기본" : ""}${!account.enabled ? " · 배정 제외(건너뜀)" : ""}${account.authStatus === "required" ? " · 로그인 필요(건너뜀)" : ""}`;
  };
  return (
    <ol className="grid gap-1 sm:col-span-2" aria-label={`${CLI_KIND_LABEL[kind]} 계정 우선 순서`} data-testid={`cli-priority-${kind}`}>
      {order.map((id, index) => (
        <li key={id} className="flex items-center gap-1.5 rounded-md border px-2 py-1 text-[12px]">
          <span className="w-5 shrink-0 text-muted-foreground">{index + 1}.</span>
          <span className="min-w-0 flex-1 truncate">{label(id)}</span>
          <button type="button" className={moveClass} disabled={disabled || index === 0} aria-label={`${id} 위로`} onClick={() => move(index, -1)}>▲</button>
          <button type="button" className={moveClass} disabled={disabled || index === order.length - 1} aria-label={`${id} 아래로`} onClick={() => move(index, 1)}>▼</button>
          <button type="button" className={moveClass} disabled={disabled || order.length <= 1} aria-label={`${id} 순서에서 빼기`} onClick={() => onChange(order.filter(x => x !== id))}>빼기</button>
        </li>
      ))}
      {rest.map(account => (
        <li key={account.accountId} className="flex items-center gap-1.5 rounded-md border border-dashed px-2 py-1 text-[12px] text-muted-foreground">
          <span className="w-5 shrink-0">–</span>
          <span className="min-w-0 flex-1 truncate">{label(account.accountId)} · 순서에 없음</span>
          <button type="button" className={moveClass} disabled={disabled} aria-label={`${account.accountId} 순서에 추가`} onClick={() => onChange([...order, account.accountId])}>추가</button>
        </li>
      ))}
    </ol>
  );
}

export function CliAccountPolicyField({ kind, accounts, value, onChange, inherit = false, disabled = false }: {
  kind: CliKind;
  accounts: CliAccountStatus[];
  value?: CliAccountPolicy;
  onChange: (value: CliAccountPolicy | undefined) => void;
  inherit?: boolean;
  disabled?: boolean;
}) {
  const choices = accounts.filter(account => account.kind === kind);
  const accountId = value?.accountId ?? defaultCliAccountId(kind);
  const select = (mode: string) => {
    if (mode === "inherit") return onChange(undefined);
    if (mode === "auto") return onChange({ mode: "auto" });
    if (mode === "priority") {
      // Start from the current fixed account (if any), then the other assignable accounts in list order.
      const first = value?.mode === "fixed" ? value.accountId : undefined;
      const enabled = choices.filter(account => account.enabled).map(account => account.accountId);
      const order = [...new Set([...(first ? [first] : []), ...enabled])];
      return onChange({ mode: "priority", order: order.length ? order : [defaultCliAccountId(kind)] });
    }
    onChange({ mode: "fixed", accountId: choices.find(account => account.enabled)?.accountId ?? defaultCliAccountId(kind) });
  };
  return (
    <div className="grid gap-2 sm:grid-cols-2" data-testid={`cli-policy-${kind}`}>
      <select className={selectClass} aria-label={`${CLI_KIND_LABEL[kind]} 계정 선택 모드`} disabled={disabled}
        value={value?.mode ?? (inherit ? "inherit" : "fixed")}
        onChange={event => select(event.target.value)}>
        {inherit && <option value="inherit">전역 설정 따름</option>}
        <option value="fixed">{CLI_ACCOUNT_MODE_LABEL.fixed}</option>
        <option value="auto">계정 자동 선택(마스터가 잔여량 보고 배분)</option>
        <option value="priority">{CLI_ACCOUNT_MODE_LABEL.priority}(순서대로 사용, 실패 시 다음 계정)</option>
      </select>
      {(value?.mode === "fixed" || (!value && !inherit)) && (
        <select className={selectClass} aria-label={`${CLI_KIND_LABEL[kind]} 지정 계정`} disabled={disabled} value={accountId}
          onChange={event => {
            const account = choices.find(account => account.accountId === event.target.value);
            if (account) onChange({ mode: "fixed", accountId: account.accountId });
          }}>
          {!choices.some(account => account.accountId === accountId) && <option value={accountId}>{accountId} · 목록에서 확인할 수 없음</option>}
          {choices.map(account => <option key={account.accountId} value={account.accountId} disabled={!account.enabled}>{account.label} · {account.accountId}{account.isDefault ? " · 기본" : ""}{!account.enabled ? " · 배정 제외" : ""}</option>)}
        </select>
      )}
      {value?.mode === "priority" && (
        <PriorityOrderList kind={kind} choices={choices} order={priorityOrder(kind, value)} disabled={disabled}
          onChange={order => onChange({ mode: "priority", order })} />
      )}
      <p className="text-[11.5px] text-muted-foreground sm:col-span-2">특정 계정 지정: 이 계정만 사용, 한도 소진 시 멈추고 알림 / 자동 선택: 마스터가 계정별 잔여량을 보고 배분 / 계정 우선 할당: 1순위 계정을 먼저 쓰고 한도 소진·인증 실패·무응답이면 다음 순위 계정으로 같은 작업을 이어서 실행(1순위가 회복되면 다음 배정부터 다시 1순위)</p>
    </div>
  );
}
