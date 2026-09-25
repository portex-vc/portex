"use client";

import { cn } from "@/lib/utils";
import { ChevronDown } from "lucide-react";
import { useEffect, useRef, useState } from "react";

export interface NavGroup {
  id: string;
  label: string;
  sections: { id: string; title: string; subs: { id: string; title: string }[] }[];
}

/** Keeps the heading nearest the top of the viewport (below the sticky header) as the current location. */
function useActiveHeading(ids: string[]) {
  const [active, setActive] = useState(ids[0] ?? "");
  useEffect(() => {
    let frame = 0;
    const update = () => {
      frame = 0;
      let current = ids[0] ?? "";
      for (const id of ids) {
        const el = document.getElementById(id);
        if (el && el.getBoundingClientRect().top <= 160) current = id;
      }
      // At the very bottom the last headings may never reach the top; select the last one.
      if (window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 4)
        current = ids.at(-1) ?? current;
      setActive(current);
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(update);
    };
    update();
    window.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule);
    return () => {
      if (frame) cancelAnimationFrame(frame);
      window.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
    };
  }, [ids]);
  return active;
}

function Links({ groups, active, onNavigate }: { groups: NavGroup[]; active: string; onNavigate?: () => void }) {
  const section = groups.flatMap((g) => g.sections).find((s) => s.id === active || s.subs.some((x) => x.id === active));
  return (
    <div className="flex flex-col gap-6">
      {groups.map((g) => (
        <div key={g.id}>
          <p className="micro mb-2">{g.label}</p>
          <ul className="flex flex-col border-l border-fg/[0.08]">
            {g.sections.map((s) => {
              const on = section?.id === s.id;
              return (
                <li key={s.id}>
                  <a
                    href={`#${s.id}`}
                    onClick={onNavigate}
                    aria-current={on ? "location" : undefined}
                    data-testid={`wiki-nav-${s.id}`}
                    className={cn(
                      "-ml-px block border-l py-1.5 pl-3 text-[0.8125rem] leading-5 transition-colors duration-150",
                      on ? "border-fg font-medium text-fg" : "border-transparent text-fg-2 hover:text-fg",
                    )}
                  >
                    {s.title}
                  </a>
                  {on && s.subs.length ? (
                    <ul className="mb-1.5">
                      {s.subs.map((x) => (
                        <li key={x.id}>
                          <a
                            href={`#${x.id}`}
                            onClick={onNavigate}
                            className={cn(
                              "block py-1 pl-6 text-xs leading-4 transition-colors duration-150",
                              active === x.id ? "text-fg" : "text-fg-3 hover:text-fg-2",
                            )}
                          >
                            {x.title}
                          </a>
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </div>
  );
}

/** Section navigation: sticky beside the article on desktop, a collapsible contents list on phones. */
export function WikiNav({ groups, label }: { groups: NavGroup[]; label: string }) {
  const ids = groups.flatMap((g) => g.sections.flatMap((s) => [s.id, ...s.subs.map((x) => x.id)]));
  const [stable] = useState(ids);
  const active = useActiveHeading(stable);
  const details = useRef<HTMLDetailsElement>(null);
  const current = groups.flatMap((g) => g.sections).find((s) => s.id === active || s.subs.some((x) => x.id === active));
  return (
    <>
      <details ref={details} className="surface-1 group lg:hidden" data-testid="wiki-contents">
        <summary className="flex cursor-pointer list-none items-center justify-between px-4 py-3 text-sm font-medium [&::-webkit-details-marker]:hidden">
          <span className="flex min-w-0 items-baseline gap-2">
            {label}
            {current ? <span className="truncate text-xs font-normal text-fg-3">{current.title}</span> : null}
          </span>
          <ChevronDown
            className="size-4 text-fg-3 transition-transform duration-200 group-open:rotate-180"
            aria-hidden
          />
        </summary>
        <nav
          aria-label={label}
          className="scroll-thin max-h-[65vh] overflow-y-auto border-t border-fg/[0.07] px-4 py-4"
        >
          <Links groups={groups} active={active} onNavigate={() => details.current?.removeAttribute("open")} />
        </nav>
      </details>
      <nav
        aria-label={label}
        className="scroll-thin sticky top-24 hidden max-h-[calc(100vh-7rem)] overflow-y-auto pb-8 pr-2 lg:block"
        data-testid="wiki-nav"
      >
        <Links groups={groups} active={active} />
      </nav>
    </>
  );
}
