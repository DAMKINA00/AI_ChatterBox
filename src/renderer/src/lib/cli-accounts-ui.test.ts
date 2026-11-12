import { test } from "node:test";
import assert from "node:assert/strict";
import * as React from "react";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { CliAccountStatus, CliAccountId } from "../../../shared/types";
import { cliRemaining, cliCheckedText, multipleCliAccounts, existingCliAccountPolicies } from "./cli-accounts-ui";
import { usageGroups } from "../../../shared/usage-view";

function account(accountId: CliAccountId = "claude-1", kind: CliAccountStatus["kind"] = "claude"): CliAccountStatus {
  return { accountId, kind, label: accountId, configDir: null, createdAt: 0, enabled: true, isDefault: accountId.endsWith("-1"), runningWorkers: 0, authStatus: "authenticated", auth: { loggedIn: true, checkedAt: 1_700_000_000_000, email: "person@example.com" }, usage: { checkedAt: 1_700_000_000_000, fiveHour: { usedPercent: 30 }, weekly: { usedPercent: 50 } } };
}

test("CLI remaining rejects unknown and invalid values instead of guessing", () => {
  for (const usedPercent of [NaN, Infinity, -1, 101]) assert.equal(cliRemaining({ usedPercent }), undefined);
  assert.equal(cliRemaining(undefined), undefined);
  assert.equal(cliRemaining({ usedPercent: 0 }), 100);
  assert.equal(cliRemaining({ usedPercent: 100 }), 0);
  assert.equal(cliRemaining({ usedPercent: 12.5 }), 87.5);
  assert.equal(cliCheckedText(undefined), "확인 시각 없음");
  assert.equal(cliCheckedText(1_700_000_000), cliCheckedText(1_700_000_000_000));
});

test("per-family account grouping keeps the original single-account path", () => {
  assert.deepEqual(multipleCliAccounts(undefined, "claude"), []);
  assert.deepEqual(multipleCliAccounts([account(), account("gpt-2", "gpt")], "claude"), []);
  assert.equal(multipleCliAccounts([account(), account("claude-2")], "claude").length, 2);
});

async function components() {
  // The unit bundler uses the classic JSX runtime for renderer imports.
  Object.assign(globalThis, {
    React,
    window: { chatterbox: {} },
    localStorage: { getItem: () => null },
  });
  const [{ CliAccountCard }, { CliAccountPolicyField }, { CliUsageBars }, { TooltipProvider }] = await Promise.all([
    import("../components/CliAccountsDialog"),
    import("../components/CliAccountPolicyField"),
    import("../components/Usage"),
    import("../components/ui"),
  ]);
  return { CliAccountCard, CliAccountPolicyField, CliUsageBars, TooltipProvider };
}

test("account card marks the default and disables its delete action, with unknown/error quotas hidden", async () => {
  const { CliAccountCard } = await components();
  const html = renderToStaticMarkup(createElement(CliAccountCard, { account: account(), pending: false, update: () => {}, run: () => {} }));
  assert.match(html, />기본</);
  assert.match(html, /<input[^>]*disabled=""/);
  assert.match(html, /disabled=""[^>]*title="기본 계정은 삭제할 수 없습니다"/);
  assert.match(html, /person@example.com/);
  assert.match(html, /aria-valuenow="70"/);
  const errored = renderToStaticMarkup(createElement(CliAccountCard, { account: { ...account("claude-2"), usage: { checkedAt: 0, error: "조회 실패", fiveHour: { usedPercent: 0 } } }, pending: false, update: () => {}, run: () => {} }));
  assert.doesNotMatch(errored, /aria-valuenow=/);
  assert.match(errored, /정보 없음/);
});

test("policy field preserves inherited, auto and missing fixed account selections", async () => {
  const { CliAccountPolicyField } = await components();
  const render = (props: Record<string, unknown>) => renderToStaticMarkup(createElement(CliAccountPolicyField, { kind: "claude", accounts: [account()], onChange: () => {}, ...props }));
  assert.match(render({ inherit: true }), /value="inherit" selected=""/);
  assert.match(render({ value: { mode: "auto" } }), /value="auto" selected=""/);
  assert.doesNotMatch(render({ value: { mode: "auto" } }), /aria-label="Claude 지정 계정"/);
  assert.match(render({ value: { mode: "fixed", accountId: "claude-9" } }), /value="claude-9" selected=""/);
});

test("policy field offers priority with an ordered list, move buttons and accounts outside the order", async () => {
  const { CliAccountPolicyField } = await components();
  const accounts = [account(), account("claude-2"), { ...account("claude-3"), enabled: false }];
  const render = (props: Record<string, unknown>) => renderToStaticMarkup(createElement(CliAccountPolicyField, { kind: "claude", accounts, onChange: () => {}, ...props }));
  assert.match(render({ inherit: true }), /<option value="priority">계정 우선 할당/);
  const html = render({ value: { mode: "priority", order: ["claude-2", "claude-1"] } });
  assert.match(html, /value="priority" selected=""/);
  assert.match(html, /aria-label="Claude 계정 우선 순서"/);
  assert.doesNotMatch(html, /aria-label="Claude 지정 계정"/);
  assert.ok(html.indexOf("1.</span><span class=\"min-w-0 flex-1 truncate\">claude-2") > 0, "first in order is listed first");
  assert.match(html, /disabled=""[^>]*aria-label="claude-2 위로"/);
  assert.match(html, /disabled=""[^>]*aria-label="claude-1 아래로"/);
  assert.match(html, /claude-3 · 배정 제외\(건너뜀\) · 순서에 없음/);
  assert.match(html, /aria-label="claude-3 순서에 추가"/);
  // An empty order shows the fallback: the policy account, then *-1.
  assert.match(render({ value: { mode: "priority" } }), /1\.<\/span><span class="min-w-0 flex-1 truncate">claude-1/);
});

test("project priority policies keep their order minus missing accounts and stay compatible with older entries", () => {
  assert.deepEqual(existingCliAccountPolicies({ claude: { mode: "priority", order: ["claude-9", "claude-2", "claude-1"] } }, [account(), account("claude-2")]),
    { claude: { mode: "priority", order: ["claude-2", "claude-1"] } });
  assert.deepEqual(existingCliAccountPolicies({ claude: { mode: "priority", order: ["claude-9"] } }, [account()]), { claude: { mode: "priority" } });
  assert.deepEqual(existingCliAccountPolicies({ claude: { mode: "priority", accountId: "claude-9" } }, [account()]), {});
});

test("usage bars follow the account store: one bar for one account, labelled rows for several, numbers from each account's stored reading", async () => {
  const { CliUsageBars, TooltipProvider } = await components();
  const render = (accounts: CliAccountStatus[]) => renderToStaticMarkup(createElement(TooltipProvider, null,
    ...usageGroups(accounts, { claude: { weekly: { usedPercent: 20 } } }).map(group => createElement(CliUsageBars, { key: group.kind, group, color: "bg-claude" }))));
  const one = render([account()]);
  assert.equal((one.match(/data-testid="usage-bar"/g) ?? []).length, 1);
  assert.match(one, /클로드/);
  assert.match(one, /50%/, "the account's stored weekly reading, not the legacy family value");
  const two = render([account(), { ...account("claude-2"), label: "PUBLIC 2", enabled: false, usage: { checkedAt: 1, weekly: { usedPercent: 90 } } }]);
  assert.equal((two.match(/data-testid="usage-bar"/g) ?? []).length, 2);
  assert.match(two, /data-testid="cli-usage-claude"/);
  assert.match(two, /PUBLIC 2/);
  assert.match(two, /10%/);
  assert.match(two, /opacity-60/, "an account excluded from assignment is shown dimmed");
  assert.doesNotMatch(two, /person@example.com/);
});

test("backend default and running-worker flags control account actions", async () => {
  const { CliAccountCard } = await components();
  const html = renderToStaticMarkup(createElement(CliAccountCard, {
    account: { ...account("claude-2"), isDefault: true, runningWorkers: 2, remainingPercent: 37 },
    pending: false, update: () => {}, run: () => {},
  }));
  assert.match(html, />기본</);
  assert.match(html, /배분 참고 잔여량: 37% · 실행 중 2명/);
  const actions = [...html.matchAll(/<button[^>]*disabled=""[^>]*>.*?<\/button>/g)].map(match => match[0]).join("");
  assert.match(actions, /로그인/);
  assert.match(actions, /로그아웃/);
  assert.match(actions, /삭제/);
});

test("a default account without a stored reading falls back to the live, then the legacy family value", () => {
  const bare = { ...account("gpt-1", "gpt"), usage: undefined };
  assert.equal(usageGroups([bare], { codex: { weekly: { usedPercent: 25 } } })[0].accounts[0].display?.remaining, 75);
  assert.equal(usageGroups([bare], { codex: { weekly: { usedPercent: 25 } }, accounts: { "gpt-1": { weekly: { usedPercent: 99 } } } })[0].accounts[0].display?.remaining, 1);
  assert.equal(usageGroups([{ ...bare, accountId: "gpt-2", isDefault: false }], { codex: { weekly: { usedPercent: 25 } } })[0].accounts[0].display, null, "the family value belongs to the default account only");
});

test("project policies discard missing or wrong-family accounts while preserving auto and valid fixed policies", () => {
  const original = { claude: { mode: "fixed" as const, accountId: "claude-9" as const }, gpt: { mode: "fixed" as const, accountId: "gpt-1" as const }, grok: { mode: "auto" as const } };
  assert.deepEqual(existingCliAccountPolicies(original, [account(), account("gpt-1", "gpt")]), { gpt: original.gpt, grok: original.grok });
  assert.equal(original.claude.accountId, "claude-9");
  assert.deepEqual(existingCliAccountPolicies({ claude: { mode: "fixed" } }, [account()]), { claude: { mode: "fixed" } });
  assert.deepEqual(existingCliAccountPolicies({ claude: { mode: "fixed", accountId: "gpt-1" } }, [account("gpt-1", "gpt")]), {});
  assert.equal(existingCliAccountPolicies(undefined, []), undefined);
  assert.equal(existingCliAccountPolicies(original, undefined), original);
});

test("usage and account-list refreshes preserve each other's success on rejection", async () => {
  await components();
  const { api } = await import("./utils");
  const { useStore } = await import("../store");
  const { refreshUsageAndAccounts } = await import("../components/Usage");
  const oldUsage = api.usage;
  const oldAccounts = api.cliAccounts;
  const oldState = useStore.getState();
  const errors: string[] = [];
  try {
    useStore.setState({ usage: {}, cliAccounts: [account()], toast: text => { errors.push(text); } });
    api.usage = async wait => { assert.equal(wait, true); return { claude: { weekly: { usedPercent: 31 } } }; };
    api.cliAccounts = { list: async () => { throw new Error("목록 실패"); } } as typeof api.cliAccounts;
    await refreshUsageAndAccounts(true);
    assert.equal(useStore.getState().usage.claude?.weekly?.usedPercent, 31);
    assert.equal(useStore.getState().cliAccounts.length, 1);
    api.usage = async () => { throw new Error("사용량 실패"); };
    api.cliAccounts.list = async () => [];
    await refreshUsageAndAccounts();
    assert.equal(useStore.getState().usage.claude?.weekly?.usedPercent, 31);
    assert.equal(useStore.getState().cliAccounts.length, 0);
    assert.deepEqual(errors, ["목록 실패", "사용량 실패"]);
  } finally {
    api.usage = oldUsage;
    api.cliAccounts = oldAccounts;
    useStore.setState(oldState);
  }
});
