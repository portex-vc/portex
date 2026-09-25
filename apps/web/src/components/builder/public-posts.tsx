"use client";

import { ActionButton } from "@/components/action-button";
import { NativeSelect } from "@/components/figures";
import { raiseInvalidations } from "@/components/raise/common";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { api, type BuilderUpdate, type RaiseDetail } from "@/lib/api";
import { useSignedWrite } from "@/lib/use-signed-write";
import { useTranslations } from "next-intl";
import { useState } from "react";

export function PublicPosts({ detail }: { detail: RaiseDetail }) {
  const t = useTranslations("builderConsole");
  const tu = useTranslations("updates");
  const { send, pending } = useSignedWrite();
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [kind, setKind] = useState<BuilderUpdate["kind"]>("update");
  const [response, setResponse] = useState(detail.latestReport?.builderResponse?.text ?? "");
  return (
    <div className="grid items-start gap-5 lg:grid-cols-2">
      <form
        className="surface-1 space-y-5 p-5 sm:p-6"
        onSubmit={async (event) => {
          event.preventDefault();
          const result = await send(
            t("post"),
            (signer) => api.postUpdate(detail.address, { title, body, kind }, signer),
            raiseInvalidations(detail.address),
          );
          if (result) {
            setTitle("");
            setBody("");
          }
        }}
      >
        <h2 className="text-base font-medium">{t("postTitle")}</h2>
        <label className="block space-y-2 text-xs text-fg-2">
          <span>{t("kind")}</span>
          <NativeSelect value={kind} onChange={(e) => setKind(e.target.value as BuilderUpdate["kind"])}>
            {(["milestone", "update", "incident"] as const).map((value) => (
              <option key={value} value={value}>
                {tu(`kinds.${value}`)}
              </option>
            ))}
          </NativeSelect>
        </label>
        <label className="block space-y-2 text-xs text-fg-2">
          <span>{t("updateTitle")}</span>
          <Input required maxLength={200} value={title} onChange={(e) => setTitle(e.target.value)} />
        </label>
        <label className="block space-y-2 text-xs text-fg-2">
          <span>{t("body")}</span>
          <Textarea required maxLength={5000} rows={5} value={body} onChange={(e) => setBody(e.target.value)} />
        </label>
        <ActionButton
          type="submit"
          variant="outline"
          label={t("post")}
          pending={pending}
          reason={!title.trim() || !body.trim() ? t("required") : null}
        />
      </form>
      <form
        className="surface-1 space-y-5 p-5 sm:p-6"
        onSubmit={async (event) => {
          event.preventDefault();
          if (detail.latestReport)
            await send(
              t("respond"),
              (signer) => api.respond(detail.address, detail.latestReport!.reportHash, { text: response }, signer),
              raiseInvalidations(detail.address),
            );
        }}
      >
        <h2 className="text-base font-medium">{t("responseTitle")}</h2>
        {detail.latestReport ? (
          <p className="break-all font-mono text-2xs text-fg-3">{detail.latestReport.reportHash}</p>
        ) : (
          <p className="text-sm text-fg-2">{t("noReport")}</p>
        )}
        <label className="block space-y-2 text-xs text-fg-2">
          <span>{t("response")}</span>
          <Textarea required maxLength={2000} rows={5} value={response} onChange={(e) => setResponse(e.target.value)} />
        </label>
        <ActionButton
          type="submit"
          variant="outline"
          label={t("respond")}
          pending={pending}
          reason={!detail.latestReport ? t("noReportReason") : !response.trim() ? t("required") : null}
        />
      </form>
    </div>
  );
}
