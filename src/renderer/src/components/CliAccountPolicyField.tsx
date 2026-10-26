import { defaultCliAccountId, type CliAccountStatus, type CliAccountPolicy } from "../../../shared/types";
import { CLI_KIND_LABEL, type CliKind } from "../lib/cli-accounts-ui";

const selectClass = "h-8 min-w-0 rounded-md border border-input bg-background px-2 text-[12px] text-foreground focus-visible:ring-2 focus-visible:ring-ring/60 disabled:opacity-50 [color-scheme:light] dark:[color-scheme:dark]";

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
  return (
    <div className="grid gap-2 sm:grid-cols-2" data-testid={`cli-policy-${kind}`}>
      <select className={selectClass} aria-label={`${CLI_KIND_LABEL[kind]} 계정 선택 모드`} disabled={disabled}
        value={value?.mode ?? (inherit ? "inherit" : "fixed")}
        onChange={event => onChange(event.target.value === "inherit" ? undefined : event.target.value === "auto" ? { mode: "auto" } : { mode: "fixed", accountId: choices.find(account => account.enabled)?.accountId ?? defaultCliAccountId(kind) })}>
        {inherit && <option value="inherit">전역 설정 따름</option>}
        <option value="fixed">특정 계정 지정</option>
        <option value="auto">계정 자동 선택(마스터가 잔여량 보고 배분)</option>
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
      <p className="text-[11.5px] text-muted-foreground sm:col-span-2">특정 계정 지정: 이 계정만 사용, 한도 소진 시 멈추고 알림 / 자동 선택: 마스터가 계정별 잔여량을 보고 배분</p>
    </div>
  );
}
