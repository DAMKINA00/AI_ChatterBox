import type { GeminiWebAccountId, GeminiWebUsage } from "../../shared/types";

export const GEMINI_ORIGIN = "https://gemini.google.com";
export function webAccountId(value: unknown): GeminiWebAccountId | null {
  return typeof value === "string" && /^gemini-(?:[1-9]|10)$/.test(value) ? value as GeminiWebAccountId : null;
}
export function conversationAccount(id: string | null): GeminiWebAccountId | null {
  return webAccountId(/^web:(gemini-(?:[1-9]|10)):\/app\/[a-zA-Z0-9_-]+$/.exec(id ?? "")?.[1]);
}
export function webConversationUrl(id: string | null, accountId: GeminiWebAccountId = "gemini-1"): string {
  return GEMINI_ORIGIN + (conversationAccount(id) === accountId ? id!.split(":").slice(2).join(":") : "/app");
}
export function webConversationId(url: string, accountId: GeminiWebAccountId = "gemini-1"): string | null {
  try {
    const parsed = new URL(url);
    return parsed.origin === GEMINI_ORIGIN && /^\/app\/[a-zA-Z0-9_-]+$/.test(parsed.pathname)
      ? `web:${accountId}:${parsed.pathname}` : null;
  } catch { return null; }
}

/** Parse only product notices supplied by the browser adapter, never assistant prose. */
export function webUsage(notices: string[], now = Date.now()): GeminiWebUsage {
  const detail = notices.map((text) => text.trim()).filter((text) => /limit|remaining|left|한도|남은|남았습니다|잔여|제한.*도달/i.test(text)).join("\n").slice(0, 1600);
  if (!detail) return { status: "unknown", detail: "현재 웹 화면에서 잔여 사용량 수치를 확인할 수 없습니다.", checkedAt: now };
  const limited = /reached.{0,30}limit|limit.{0,30}reached|no.{0,15}(requests|prompts).{0,15}left|한도.{0,30}(도달|초과|소진)|제한.{0,30}도달/i.test(detail);
  const left = /(?:remaining|남은|잔여)\s*[:：]?\s*(\d+)\s*(?:\/|of)\s*(\d+)|(\d+)\s*(?:of|\/)\s*(\d+)\s*(?:requests? |prompts? )?(?:remaining|left)/i.exec(detail);
  const remaining = left ? Number(left[1] ?? left[3]) : undefined;
  const limit = left ? Number(left[2] ?? left[4]) : undefined;
  const valid = remaining !== undefined && limit !== undefined && remaining >= 0 && limit > 0 && remaining <= limit;
  const resetText = detail.split("\n").find((line) => /reset|다시 사용|초기화|재설정/i.test(line));
  return { status: limited ? "limited" : valid ? "available" : "unknown", detail, checkedAt: now, ...(valid ? { remaining, limit } : {}), ...(resetText ? { resetText } : {}) };
}

/** Parse visible numbers only; do not infer quotas from CSS widths or message counts. */
export function webUsagePage(current: string, weekly: string, now = Date.now()): GeminiWebUsage {
  const parse = (text: string) => {
    const match = /(?:^|\s)(\d+(?:\.\d+)?)\s*%\s*(?:사용됨|사용|used)/i.exec(text);
    const usedPercent = match ? Number(match[1]) : NaN;
    if (!Number.isFinite(usedPercent) || usedPercent < 0 || usedPercent > 100) return undefined;
    return { usedPercent, resetText: text.split(/\n/).find(line => /초기화|재설정|reset/i.test(line))?.trim() };
  };
  const c = parse(current), w = parse(weekly);
  if (!c && !w) return webUsage([], now);
  return { status: c?.usedPercent === 100 || w?.usedPercent === 100 ? "limited" : "available", checkedAt: now,
    detail: [c && `현재 ${c.usedPercent}% 사용됨`, w && `주간 ${w.usedPercent}% 사용됨`].filter(Boolean).join(" · "),
    ...(c ? { current: c } : {}), ...(w ? { weekly: w } : {}) };
}

export const USAGE_SCRIPT = `(() => {
  if(location.origin !== '${GEMINI_ORIGIN}' || location.pathname !== '/usage') return null;
  return { current: document.querySelector('[data-test-id="gxu-currently"]')?.innerText || '',
    weekly: document.querySelector('[data-test-id="gxu-weekly"]')?.innerText || '',
    login: !!document.querySelector('a[href*="accounts.google.com/ServiceLogin"]'),
    loaded: !!document.querySelector('usage-metrics-window .usage-metrics-container') };
})()`;

export interface WebSnapshot {
  url: string;
  login: boolean;
  composer: boolean;
  draft: string;
  model: string;
  chatMode: boolean;
  generating: boolean;
  users: string[];
  responses: { text: string; complete: boolean; images?: string[] }[];
  notices: string[];
}

// Runs inside the sandboxed Gemini renderer. No Node APIs or access to cookies/storage.
export const SNAPSHOT_SCRIPT = String.raw`(() => {
  if (location.origin !== 'https://gemini.google.com') return null;
  const visible = el => !!el.getClientRects().length;
  const buttons = Array.from(document.querySelectorAll('button,[role=button]')).filter(visible);
  const label = el => (el.getAttribute('aria-label') || '') + ' ' + (el.innerText || '');
  const mode = buttons.find(el => /모드 선택|mode picker|model picker|choose.*model|select.*model/i.test(label(el)));
  const chat = buttons.find(el => /^(채팅|Chat)$/i.test(el.innerText.trim()));
  const editor = document.querySelector('rich-textarea [contenteditable=true],[contenteditable=true][role=textbox]');
  const responses = Array.from(document.querySelectorAll('model-response')).map(el => {
    const body = el.querySelector('.model-response-text .markdown,.markdown,.model-response-text');
    let text = body?.innerText || '';
    if (body) {
      const copy = body.cloneNode(true);
      for (const link of copy.querySelectorAll('a[href]')) { const href = link.getAttribute('href'); if (/^https?:/.test(href || '')) link.replaceWith('[' + link.textContent + '](' + href + ')'); }
      for (const pre of copy.querySelectorAll('pre')) pre.replaceWith('\n\u0060\u0060\u0060\n' + (pre.querySelector('code') || pre).textContent + '\n\u0060\u0060\u0060\n');
      for (const br of copy.querySelectorAll('br')) br.replaceWith('\n');
      for (const li of copy.querySelectorAll('li')) { li.prepend('- '); li.append('\n'); }
      for (const block of copy.querySelectorAll('p,div,h1,h2,h3,h4,h5,h6,ul,ol,table,tr,blockquote')) block.append('\n\n');
      for (const cell of copy.querySelectorAll('td,th')) cell.append(' | ');
      text = copy.textContent || text;
    }
    const images = Array.from(el.querySelectorAll('generated-image img,.generated-image img,[data-test-id="generated-image"] img,img[alt*="Generated"],img[alt*="생성된"]')).filter(img => img.naturalWidth >= 128 && img.naturalHeight >= 128 && /^https:\/\/[^/]+\.googleusercontent\.com\//i.test(img.currentSrc || img.src)).map(img => img.currentSrc || img.src);
    return { text: text.trim(), images, complete: Array.from(el.querySelectorAll('button')).some(b => /복사|copy response|다운로드|download/i.test(label(b))) };
  });
  return { url: location.origin + location.pathname, login: !!document.querySelector('a[href*="accounts.google.com/ServiceLogin"]') || buttons.some(b => /^(로그인|Sign in)$/i.test((b.innerText || '').trim())),
    composer: !!editor && visible(editor), draft: editor?.innerText || '', model: mode?.innerText?.trim() || '',
    chatMode: chat ? !!chat.closest('gem-segmented-button')?.classList.contains('gem-segmented-button-selected')
      : /^\/app(?:\/[a-zA-Z0-9_-]+)?$/.test(location.pathname) && !!document.querySelector('user-query'),
    generating: buttons.some(b => /응답 중지|답변 중지|생성 중지|stop response|stop generating/i.test(label(b))),
    users: Array.from(document.querySelectorAll('user-query')).map(el => el.innerText || ''), responses,
    notices: Array.from(document.querySelectorAll('[role=alert], [role=status], [role=dialog], .usage-limit, .limit-banner')).filter(el => visible(el) && !el.closest('model-response,user-query')).map(el => el.innerText || '') };
})()`;

export function buttonScript(pattern: string): string {
  return `(() => { if (location.origin !== 'https://gemini.google.com') return false; const re = new RegExp(${JSON.stringify(pattern)}, 'i'); const el = Array.from(document.querySelectorAll('button,[role=button],[role=menuitem],[role=option]')).find(el => el.getClientRects().length && re.test((el.getAttribute('aria-label') || '') + ' ' + (el.innerText || '').trim())); if (!el || el.disabled || el.getAttribute('aria-disabled') === 'true') return false; el.click(); return true; })()`;
}
