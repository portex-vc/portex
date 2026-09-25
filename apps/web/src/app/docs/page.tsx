import { DocsArticle } from "@/components/docs/article";
import { GROUPS, SECTIONS, subId } from "@/components/docs/content";
import { DocsNav, type NavGroup } from "@/components/docs/docs-nav";
import { stageLabel } from "@/lib/stages";
import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("docs");
  return { title: t("title"), description: t("description") };
}

/** How Portex works, in one article with a section nav (DESIGN_V2: plain conventional documentation UI). */
export default async function DocsPage() {
  const t = await getTranslations();
  const d = await getTranslations("docs");
  const byId = new Map(SECTIONS.map((s) => [s.id, s]));
  const groups: NavGroup[] = GROUPS.map((g) => ({
    id: g.id,
    label: d(`groups.${g.id}`),
    sections: g.sections.map((id) => {
      const section = byId.get(id)!;
      return {
        id,
        title: section.stage ? stageLabel(t, section.stage) : (d.raw(`s.${id}.title`) as string),
        subs: section.blocks.flatMap((b) =>
          b.kind === "h3" ? [{ id: subId(id, b.key), title: d.raw(`s.${id}.${b.key}`) as string }] : [],
        ),
      };
    }),
  }));
  return (
    <div className="flex flex-col gap-10 pt-2 lg:pt-4" data-testid="docs-page">
      <header className="max-w-2xl space-y-2">
        <h1 className="t-title">{d("heading")}</h1>
        <p className="text-[0.9375rem] leading-relaxed text-fg-2">{d("description")}</p>
      </header>
      <div className="grid gap-8 lg:grid-cols-[13.5rem_minmax(0,1fr)] lg:gap-14 xl:gap-20">
        {/* Phones: the contents bar sticks under the header; desktop: the nav column stretches and its nav sticks. */}
        <div className="sticky top-[4.5rem] z-30 min-w-0 self-start lg:static lg:z-auto lg:self-stretch">
          <DocsNav groups={groups} label={d("contents")} />
        </div>
        <DocsArticle />
      </div>
    </div>
  );
}
