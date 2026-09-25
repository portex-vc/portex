import { MechanismVisual } from "@/components/home/mechanism-visual";
import { STAGE_TONE, stageLabel } from "@/lib/stages";
import { cn } from "@/lib/utils";
import { Link2 } from "lucide-react";
import { useTranslations } from "next-intl";
import type { ReactNode } from "react";
import { SECTIONS, subId, type Block, type Section } from "./content";
import { DeployedContracts, NetworkFacts } from "./deployment";
import { LiveTiming, StepperNote, TimingsTable } from "./live-timing";
import { rich } from "./rich";

type Raw = (key: string) => unknown;

/** A heading with a quiet anchor link that appears on hover and focus. */
function Anchored({
  as: Tag,
  id,
  className,
  children,
}: {
  as: "h2" | "h3";
  id: string;
  className: string;
  children: ReactNode;
}) {
  const t = useTranslations("docs");
  return (
    <Tag id={id} className={cn("group scroll-mt-16 lg:scroll-mt-0", className)}>
      {children}
      <a
        href={`#${id}`}
        aria-label={t("anchor")}
        className="ml-2 inline-flex translate-y-[-1px] align-middle text-fg-3 opacity-0 transition-opacity duration-150 hover:text-fg focus-visible:opacity-100 group-hover:opacity-100"
      >
        <Link2 className="size-3.5" aria-hidden />
      </a>
    </Tag>
  );
}

function Stepper() {
  const t = useTranslations();
  const w = useTranslations("docs.stepper");
  const stages = ["Stage1", "Stage2", "Stage3"] as const;
  return (
    <figure className="my-8" data-testid="docs-stepper">
      <ol className="grid gap-px overflow-hidden rounded-[14px] border border-fg/[0.08] bg-fg/[0.08] sm:grid-cols-3">
        {stages.map((stage, i) => (
          <li key={stage} className="flex flex-col gap-2 bg-surface-1 p-5">
            <span className="flex items-center gap-2 text-xs">
              <span className="num flex size-5 items-center justify-center rounded-full border border-fg/15 text-2xs text-fg-2">
                {i + 1}
              </span>
              <span className={cn("inline-flex items-center gap-1.5 font-medium", STAGE_TONE[stage].text)}>
                <span aria-hidden className={cn("size-1.5 rounded-full", STAGE_TONE[stage].dot)} />
                {stageLabel(t, stage, "short")}
              </span>
            </span>
            <span className="text-[0.9375rem] font-medium leading-6 text-fg">{t(`stages.${stage}.name`)}</span>
            <span className="num text-xs text-fg-3">
              {w(`${stage}.when`)}
              {stage !== "Stage3" ? (
                <LiveTiming k={stage === "Stage1" ? "stage1" : "stage2"} block className="mt-1" />
              ) : null}
            </span>
            <span className="text-sm leading-6 text-fg-2">{w(`${stage}.what`)}</span>
          </li>
        ))}
      </ol>
      <figcaption className="mt-3 flex flex-col gap-1 text-xs leading-5 text-fg-3">
        <span>
          <span className="font-medium text-fg-2">{w("dissolutionLabel")}.</span> {w("dissolution")}
        </span>
        <StepperNote note={w("note")} />
      </figcaption>
    </figure>
  );
}

function Figure({ figure }: { figure: Extract<Block, { kind: "figure" }>["figure"] }) {
  const home = useTranslations("home");
  if (figure === "stepper") return <Stepper />;
  if (figure === "timings") return <TimingsTable />;
  if (figure === "contracts") return <DeployedContracts />;
  if (figure === "network") return <NetworkFacts />;
  if (figure === "hero")
    return (
      <blockquote className="my-6 border-l-2 border-fg/20 pl-5" data-testid="docs-hero">
        <p className="text-lg font-medium leading-7 tracking-[-0.01em] text-fg">{home("title")}</p>
        <p className="mt-3 text-[0.9375rem] leading-7 text-fg-2">{home("sub")}</p>
      </blockquote>
    );
  if (figure === "boundary")
    return (
      <p className="my-6 rounded-[12px] border border-fg/[0.08] bg-fg/[0.02] px-4 py-3 text-sm leading-6 text-fg-2">
        {home("boundary")}
      </p>
    );
  return (
    <figure className="my-8">
      <div className="surface-1 p-4 sm:p-6">
        <MechanismVisual />
      </div>
      <figcaption className="mt-3 text-xs leading-5 text-fg-3">{home("visual.caption")}</figcaption>
    </figure>
  );
}

function Table({ value }: { value: { head: string[]; rows: string[][] } }) {
  return (
    <>
      <div className="my-6 hidden overflow-hidden rounded-[12px] border border-fg/[0.08] sm:block">
        <table className="w-full text-left text-sm">
          <thead className="bg-fg/[0.025] text-xs text-fg-3">
            <tr>
              {value.head.map((h, i) => (
                <th key={i} scope="col" className="px-4 py-2.5 font-normal">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {value.rows.map((row, r) => (
              <tr key={r} className="border-t border-fg/[0.07] align-top">
                {row.map((cell, c) =>
                  c === 0 ? (
                    <th key={c} scope="row" className="w-[26%] px-4 py-3 font-medium text-fg">
                      {rich(cell)}
                    </th>
                  ) : (
                    <td key={c} className="px-4 py-3 leading-6 text-fg-2">
                      {rich(cell)}
                    </td>
                  ),
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {/* Phones: one block per row, each value under its column label. */}
      <div className="my-6 flex flex-col divide-y divide-fg/[0.07] rounded-[12px] border border-fg/[0.08] sm:hidden">
        {value.rows.map((row, r) => (
          <dl key={r} className="flex flex-col gap-2 px-4 py-3.5">
            <dt className="text-sm font-medium text-fg">{rich(row[0])}</dt>
            {row.slice(1).map((cell, c) => (
              <dd key={c} className="text-sm leading-6 text-fg-2">
                {value.head[c + 1] ? <span className="block text-xs text-fg-3">{value.head[c + 1]}</span> : null}
                {rich(cell)}
              </dd>
            ))}
          </dl>
        ))}
      </div>
    </>
  );
}

function BlockView({ section, block, raw }: { section: string; block: Block; raw: Raw }) {
  switch (block.kind) {
    case "figure":
      return <Figure figure={block.figure} />;
    case "h3":
      return (
        <Anchored as="h3" id={subId(section, block.key)} className="mb-3 mt-9 text-base font-medium text-fg">
          {raw(block.key) as string}
        </Anchored>
      );
    case "p":
      return <p className="my-4 text-[0.9375rem] leading-7 text-fg-2">{rich(raw(block.key) as string)}</p>;
    case "list":
      return (
        <ul className="my-4 flex flex-col gap-2.5">
          {(raw(block.key) as string[]).map((item, i) => (
            <li key={i} className="flex gap-3 text-[0.9375rem] leading-7 text-fg-2">
              <span aria-hidden className="mt-[0.8rem] size-1 shrink-0 rounded-full bg-fg-3" />
              <span>{rich(item)}</span>
            </li>
          ))}
        </ul>
      );
    case "steps":
      return (
        <ol className="my-4 flex flex-col gap-3" data-testid="docs-steps">
          {(raw(block.key) as string[]).map((item, i) => (
            <li key={i} className="flex gap-3 text-[0.9375rem] leading-7 text-fg-2">
              <span
                aria-hidden
                className="num mt-[0.3rem] flex size-5 shrink-0 items-center justify-center rounded-full border border-fg/15 text-2xs text-fg-2"
              >
                {i + 1}
              </span>
              <span>{rich(item)}</span>
            </li>
          ))}
        </ol>
      );
    case "related":
      return <Related ids={block.ids} />;
    case "note":
      return (
        <p
          className={cn(
            "my-6 rounded-[12px] border px-4 py-3 text-sm leading-6",
            block.tone === "protected"
              ? "border-protected/25 bg-protected/[0.06] text-fg"
              : "border-fg/[0.08] bg-fg/[0.02] text-fg-2",
          )}
        >
          {rich(raw(block.key) as string)}
        </p>
      );
    case "table":
      return <Table value={raw(block.key) as { head: string[]; rows: string[][] }} />;
    case "faq":
      return (
        <dl className="my-4 flex flex-col divide-y divide-fg/[0.07] border-y border-fg/[0.07]" data-testid="docs-faq">
          {(raw(block.key) as { q: string; a: string }[]).map((item, i) => (
            <div key={i} className="py-5">
              <dt className="text-[0.9375rem] font-medium leading-6 text-fg">{item.q}</dt>
              <dd className="mt-2 text-[0.9375rem] leading-7 text-fg-2">{rich(item.a)}</dd>
            </div>
          ))}
        </dl>
      );
    case "terms":
      return (
        <dl className="mb-4 mt-7 grid gap-x-8 gap-y-5 sm:grid-cols-[11rem_minmax(0,1fr)]" data-testid="docs-glossary">
          {(raw(block.key) as { term: string; def: string }[]).map((item, i) => (
            <div key={i} className="contents">
              <dt className="text-sm font-medium text-fg">{item.term}</dt>
              <dd className="-mt-4 text-sm leading-6 text-fg-2 sm:mt-0">{rich(item.def)}</dd>
            </div>
          ))}
        </dl>
      );
  }
}

export function sectionTitle(t: ReturnType<typeof useTranslations>, section: Section, raw: Raw): string {
  return section.stage ? stageLabel(t, section.stage) : (raw("title") as string);
}

/** "Related" links from a guide to the concept sections it relies on. */
function Related({ ids }: { ids: string[] }) {
  const t = useTranslations();
  const d = useTranslations("docs");
  const byId = new Map(SECTIONS.map((s) => [s.id, s]));
  return (
    <p
      className="mt-6 flex flex-wrap items-baseline gap-x-3 gap-y-1 border-t border-fg/[0.07] pt-4 text-sm"
      data-testid="docs-related"
    >
      <span className="text-xs text-fg-3">{d("related")}</span>
      {ids.map((id) => {
        const section = byId.get(id)!;
        return (
          <a key={id} href={`#${id}`} className="link text-fg-2">
            {section.stage ? stageLabel(t, section.stage) : (d.raw(`s.${id}.title`) as string)}
          </a>
        );
      })}
    </p>
  );
}

function SectionView({ section }: { section: Section }) {
  const t = useTranslations();
  const s = useTranslations(`docs.s.${section.id}`);
  const raw: Raw = (key) => s.raw(key);
  return (
    <section
      aria-labelledby={section.id}
      className="border-t border-fg/[0.07] pt-10 first:border-t-0 first:pt-0"
      data-testid={`docs-section-${section.id}`}
    >
      <Anchored as="h2" id={section.id} className="t-section text-fg">
        {sectionTitle(t, section, raw)}
      </Anchored>
      <p className="mt-2 text-base leading-7 text-fg">{rich(raw("lede") as string)}</p>
      {section.blocks.map((block, i) => (
        <BlockView key={i} section={section.id} block={block} raw={raw} />
      ))}
    </section>
  );
}

/** The whole documentation as one article: every section in reading order. */
export function DocsArticle() {
  return (
    <article className="flex min-w-0 max-w-[46rem] flex-col gap-14 pb-10" data-testid="docs-article">
      {SECTIONS.map((section) => (
        <SectionView key={section.id} section={section} />
      ))}
    </article>
  );
}
