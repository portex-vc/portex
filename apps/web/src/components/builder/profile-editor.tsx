"use client";

import { ActionButton } from "@/components/action-button";
import { XLogo } from "@/components/brand/x-logo";
import { ProjectImageField } from "@/components/builder/image-upload";
import { raiseInvalidations } from "@/components/raise/common";
import { projectImage } from "@/components/raise/project-avatar";
import { RaiseCard } from "@/components/raise/raise-card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { api, profileBody, type BuilderProfile, type RaiseDetail } from "@/lib/api";
import { useSignedWrite } from "@/lib/use-signed-write";
import { BookOpen, Github, Globe } from "lucide-react";
import { useTranslations } from "next-intl";
import { useState } from "react";

const LINKS = [
  { field: "website", icon: Globe, type: "url" },
  { field: "twitter", icon: XLogo, type: "text" },
  { field: "github", icon: Github, type: "text" },
  { field: "docs", icon: BookOpen, type: "url" },
] as const;

export function ProfileEditor({ detail }: { detail: RaiseDetail }) {
  const t = useTranslations("builderConsole");
  const [profile, setProfile] = useState<BuilderProfile>(detail.profile);
  /** undefined: unchanged (the API keeps the stored image); null: removed; otherwise the new upload. */
  const [image, setImage] = useState<{ uri: string; url: string } | null | undefined>(undefined);
  const { send, pending } = useSignedWrite();
  const shown = image === undefined ? projectImage(profile) : (image?.url ?? null);
  return (
    <form
      className="grid items-start gap-6 xl:grid-cols-[minmax(0,1fr)_22rem]"
      onSubmit={async (event) => {
        event.preventDefault();
        await send(
          t("save"),
          (signer) =>
            api.saveProfile(
              detail.address,
              profileBody(profile, image === undefined ? undefined : (image?.uri ?? null)),
              signer,
            ),
          raiseInvalidations(detail.address),
        );
      }}
    >
      <section className="surface-1 p-5 sm:p-6">
        <h2 className="text-base font-medium">{t("profile")}</h2>
        <div className="mt-5">
          <ProjectImageField
            symbol={detail.symbol}
            imageUrl={shown}
            disabled={pending}
            onChange={(next) => {
              setImage(next);
              // Removing the image also clears a legacy logo URL, so the monogram shows.
              if (next === null) setProfile((p) => ({ ...p, logoUrl: null, imageUrl: null }));
            }}
          />
        </div>
        <div className="mt-6 space-y-5 border-t border-fg/[0.07] pt-6">
          <label className="block space-y-2 text-xs text-fg-2">
            <span>{t("fields.tagline")}</span>
            <Input
              name="tagline"
              required
              maxLength={200}
              value={profile.tagline}
              onChange={(e) => setProfile({ ...profile, tagline: e.target.value })}
            />
          </label>
          <label className="block space-y-2 text-xs text-fg-2">
            <span>{t("fields.description")}</span>
            <Textarea
              name="description"
              required
              maxLength={2000}
              rows={5}
              value={profile.description}
              onChange={(e) => setProfile({ ...profile, description: e.target.value })}
            />
          </label>
        </div>
        <fieldset className="mt-6 border-t border-fg/[0.07] pt-6">
          <legend className="sr-only">{t("links")}</legend>
          <p aria-hidden className="mb-4 text-sm text-fg">
            {t("links")}
          </p>
          <div className="grid gap-5 sm:grid-cols-2">
            {LINKS.map(({ field, icon: Icon, type }) => (
              <label key={field} className="block space-y-2 text-xs text-fg-2">
                <span className="inline-flex items-center gap-1.5">
                  <Icon className="size-3 text-fg-3" aria-hidden />
                  {t(`fields.${field}`)}
                </span>
                <Input
                  name={field}
                  maxLength={field === "twitter" || field === "github" ? 200 : 500}
                  type={type}
                  inputMode={type === "url" ? "url" : undefined}
                  placeholder={t(`placeholders.${field}`)}
                  value={profile[field] ?? ""}
                  onChange={(e) => setProfile({ ...profile, [field]: e.target.value })}
                />
              </label>
            ))}
          </div>
        </fieldset>
      </section>
      <aside className="space-y-3 xl:sticky xl:top-24">
        <h2 className="micro">{t("preview")}</h2>
        <RaiseCard
          r={{
            ...detail,
            profile: { ...profile, imageUrl: shown, logoUrl: image === undefined ? profile.logoUrl : null },
            description: profile.description,
          }}
        />
        <div className="surface-1 corner-cut p-4">
          <ActionButton
            data-testid="primary-action"
            type="submit"
            className="w-full"
            label={t("save")}
            pending={pending}
            reason={!profile.tagline.trim() || !profile.description.trim() ? t("required") : null}
          />
        </div>
      </aside>
    </form>
  );
}
