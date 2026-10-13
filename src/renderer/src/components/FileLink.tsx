import type { ReactNode } from "react";
import { api, errorMessage } from "../lib/utils";
import { useStore } from "../store";
import { safeLinkHref } from "../../../shared/links";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "./ui";

export function FileLink({ href, children }: { href: string; children: ReactNode }) {
  const chatId = useStore((s) => s.selection?.chatId);
  const safe = safeLinkHref(href);
  const act = async (action: "open" | "reveal" | "save") => {
    try {
      if (!chatId) throw new Error("대화를 선택해 주세요.");
      await api.linkAction(chatId, safe, action);
    } catch (e) { useStore.getState().toast(errorMessage(e)); }
  };
  if (!safe) return <span>{children}</span>;
  if (safe.startsWith("#")) return <a href={safe}>{children}</a>;
  if (/^https?:\/\//i.test(safe)) return <a href={safe} title={safe} rel="noreferrer" onClick={(e) => { e.preventDefault(); void act("open"); }}>{children}</a>;
  return <DropdownMenu>
    <DropdownMenuTrigger asChild><button type="button" className="cursor-pointer text-primary underline underline-offset-2" title={safe}>{children}</button></DropdownMenuTrigger>
    <DropdownMenuContent>
      <DropdownMenuItem onSelect={() => void act("open")}>파일 열기</DropdownMenuItem>
      <DropdownMenuItem onSelect={() => void act("reveal")}>탐색기에서 보기</DropdownMenuItem>
      <DropdownMenuItem onSelect={() => void act("save")}>다른 이름으로 저장 (다운로드)</DropdownMenuItem>
    </DropdownMenuContent>
  </DropdownMenu>;
}
