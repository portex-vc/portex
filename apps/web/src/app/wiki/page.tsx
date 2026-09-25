import { WikiArticle } from "@/components/wiki/article";
import { GROUPS, SECTIONS, subId } from "@/components/wiki/content";
import { WikiNav, type NavGroup } from "@/components/wiki/wiki-nav";
import { stageLabel } from "@/lib/stages";
import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("wiki");
  return { title: t("title"), description: t("description") };
}

/** How Portex works, in one article with a section nav (DESIGN_V2: plain conventional documentation UI). */
export default async function WikiPage() {
  const t = await getTranslations();
  const w = await getTranslations("wiki");
  const byId = new Map(SECTIONS.map((s) => [s.id, s]));
  const groups: NavGroup[] = GROUPS.map((g) => ({
    id: g.id,
    label: w(`groups.${g.id}`),
    sections: g.sections.map((id) => {
      const section = byId.get(id)!;
      return {
        id,
        title: section.stage ? stageLabel(t, section.stage) : (w.raw(`s.${id}.title`) as string),
        subs: section.blocks.flatMap((b) =>
          b.kind === "h3" ? [{ id: subId(id, b.key), title: w.raw(`s.${id}.${b.key}`) as string }] : [],
        ),
      };
    }),
  }));
  return (
    <div className="flex flex-col gap-10 pt-2 lg:pt-4" data-testid="wiki-page">
      <header className="max-w-2xl space-y-2">
        <p className="micro">{w("eyebrow")}</p>
        <h1 className="t-title">{w("title")}</h1>
        <p className="text-[0.9375rem] leading-relaxed text-fg-2">{w("description")}</p>
      </header>
      <div className="grid gap-8 lg:grid-cols-[13.5rem_minmax(0,1fr)] lg:gap-14 xl:gap-20">
        {/* Phones: the contents bar sticks under the header; desktop: the nav column stretches and its nav sticks. */}
        <div className="sticky top-[4.5rem] z-30 min-w-0 self-start lg:static lg:z-auto lg:self-stretch">
          <WikiNav groups={groups} label={w("contents")} />
        </div>
        <WikiArticle />
      </div>
    </div>
  );
}
