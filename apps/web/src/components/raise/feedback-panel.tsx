"use client";

import { ActionButton } from "@/components/action-button";
import { Mark } from "@/components/brand/logo";
import { Reveal } from "@/components/motion/reveal";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { api } from "@/lib/api";
import { queryKeys, useFeedback } from "@/lib/hooks";
import { useNumbers } from "@/lib/use-numbers";
import { useSignedWrite } from "@/lib/use-signed-write";
import { shortAddress } from "@/lib/utils";
import { Star } from "lucide-react";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { useAccount } from "wagmi";

export function FeedbackPanel({ raiseAddress }: { raiseAddress: string }) {
  const t = useTranslations("feedback");
  const n = useNumbers();
  const { address: user } = useAccount();
  const { send, pending } = useSignedWrite();
  const { data, isLoading, isError, refetch } = useFeedback(raiseAddress);
  const [rating, setRating] = useState("4");
  const [text, setText] = useState("");
  const trimmed = text.trim();
  const reason = !user ? t("connect") : !trimmed ? t("write") : trimmed.length > 2000 ? t("tooLong") : null;
  const submit = async () => {
    if (!user || reason) return;
    const result = await send(
      t("submit"),
      async (signer) => {
        const message = `Portex feedback\nraise: ${raiseAddress.toLowerCase()}\nrating: ${rating}\ntext: ${trimmed}`;
        const signature = await signer.signMessage({ message });
        return api.postFeedback(raiseAddress, { author: user, rating: Number(rating), text: trimmed, signature });
      },
      [queryKeys.feedback(raiseAddress)],
    );
    if (result) setText("");
  };

  return (
    <section className="surface-1 min-w-0 space-y-4 p-5">
      <h3 className="text-sm font-medium">{t("title")}</h3>
      {isLoading ? (
        <div className="skeleton h-28 rounded-[10px]" aria-busy />
      ) : isError ? (
        <div className="space-y-2">
          <p className="text-xs text-negative">{t("error")}</p>
          <Button variant="outline" size="sm" onClick={() => refetch()}>
            {t("retry")}
          </Button>
        </div>
      ) : !data?.length ? (
        <div className="flex flex-col items-center gap-2 py-4 text-center">
          <Mark size={28} />
          <p className="text-xs text-fg-2">{t("empty")}</p>
          <a href="#tester-feedback" className="link text-xs">
            {t("writeAction")}
          </a>
        </div>
      ) : (
        <ol>
          {data.map((feedback, index) => (
            <li key={feedback.id} className="border-t border-hairline py-3">
              <Reveal index={index}>
                <div className="flex flex-wrap items-center gap-2">
                  <span className="flex gap-0.5" aria-label={t("stars", { count: feedback.rating })}>
                    {[1, 2, 3, 4, 5].map((star) => (
                      <Star
                        aria-hidden
                        key={star}
                        className={star <= feedback.rating ? "size-3 fill-fg text-fg" : "size-3 text-fg-3"}
                      />
                    ))}
                  </span>
                  <span className="font-mono text-2xs text-fg-2">{shortAddress(feedback.author)}</span>
                  {feedback.isBacker ? (
                    <span className="rounded-full bg-protected/10 px-2 text-2xs text-protected">{t("backer")}</span>
                  ) : null}
                </div>
                <p className="mt-2 whitespace-pre-wrap break-words text-sm">{feedback.text}</p>
                <time className="num mt-2 block text-2xs text-fg-3">{n.date(feedback.createdAt)}</time>
              </Reveal>
            </li>
          ))}
        </ol>
      )}
      <form
        className="space-y-3 border-t border-hairline pt-4"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <p className="text-xs text-fg-2">{t("hint")}</p>
        <Select value={rating} onValueChange={setRating}>
          <SelectTrigger aria-label={t("rating")} className="w-36">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {[5, 4, 3, 2, 1].map((value) => (
              <SelectItem key={value} value={String(value)}>
                {t("stars", { count: value })}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Textarea
          id="tester-feedback"
          aria-label={t("writeAction")}
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={t("placeholder")}
        />
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="num text-2xs text-fg-3">
            {n.number(trimmed.length, 0)} / {n.number(2000, 0)}
          </span>
          <ActionButton
            type="submit"
            label={t("submit")}
            reason={reason}
            pending={pending}
            variant="outline"
            size="sm"
          />
        </div>
      </form>
    </section>
  );
}
