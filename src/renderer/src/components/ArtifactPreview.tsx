import { useEffect, useRef, useState, type ReactNode } from "react";
import type { AttachmentRef } from "../../../shared/types";
import { isLocalArtifactImage } from "../../../shared/artifact-markdown";
import { safeLinkHref } from "../../../shared/links";
import { api } from "../lib/utils";
import { useStore } from "../store";
import { FileLink } from "./FileLink";

type ArtifactPreviewProps = {
  href: string;
  label?: ReactNode;
  image?: boolean;
};

/** Keep the preview and its FileLink inline so Markdown paragraphs stay valid. */
export function ArtifactPreview({ href, label, image = false }: ArtifactPreviewProps) {
  const chatId = useStore((s) => s.selection?.chatId);
  const safe = safeLinkHref(href);
  const wantsPreview = image ? Boolean(safe) && !/^https?:\/\//i.test(safe) : isLocalArtifactImage(safe);
  const [attachment, setAttachment] = useState<AttachmentRef | null>(null);
  const request = useRef(0);

  useEffect(() => {
    const current = ++request.current;
    setAttachment(null);
    if (!chatId || !wantsPreview) return () => { request.current++; };
    void api.previewImage(chatId, safe).then(
      (next) => {
        if (request.current === current) setAttachment(next);
      },
      () => {
        if (request.current === current) setAttachment(null);
      },
    );
    return () => { request.current++; };
  }, [chatId, safe, wantsPreview]);

  const linkLabel = label ?? (safe || "파일");
  const link = <FileLink href={safe}>{linkLabel}</FileLink>;
  if (!attachment) return <span className="inline-flex max-w-full align-middle">{link}</span>;

  return (
    <span className="my-2 flex max-w-full flex-col items-start gap-1" data-testid="artifact-preview">
      <img
        src={`cbx://attachment/${attachment.id}`}
        alt={typeof linkLabel === "string" ? linkLabel : "이미지 미리보기"}
        className="block max-h-[320px] max-w-full object-contain"
        style={{ width: 320 }}
        draggable={false}
        onError={() => setAttachment(null)}
      />
      <span className="inline-flex max-w-full">{link}</span>
    </span>
  );
}
