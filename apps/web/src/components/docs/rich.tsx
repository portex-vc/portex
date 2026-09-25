import Link from "next/link";
import type { ReactNode } from "react";
import { LiveTiming } from "./live-timing";
import { isTiming } from "./timings";

/**
 * The docs' only inline markup: `**strong**`, `` `code` ``, `[label](href)` and `{{timing}}` (this network's value
 * of a governed timing, shown only when shorter than production). Anchors (`#…`) stay on the page, `http…` links
 * open in a new tab, other paths use client navigation. Text is read with `t.raw`, so no ICU syntax is involved.
 */
export function rich(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  const pattern = /\*\*(.+?)\*\*|`([^`]+)`|\[(.+?)\]\((.+?)\)|\{\{(\w+)\}\}/g;
  let last = 0;
  let timings = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text))) {
    if (match.index > last) out.push(text.slice(last, match.index));
    const key = `${match.index}`;
    const [, strong, code, label, href, timing] = match;
    if (strong) {
      out.push(
        <strong key={key} className="font-medium text-fg">
          {strong}
        </strong>,
      );
    } else if (code) {
      out.push(
        <code key={key} className="rounded-[5px] bg-fg/[0.06] px-1 py-px font-mono text-[0.8125em] text-fg">
          {code}
        </code>,
      );
    } else if (timing) {
      if (isTiming(timing)) out.push(<LiveTiming key={key} k={timing} why={timings++ === 0} />);
    } else if (href.startsWith("#")) {
      out.push(
        <a key={key} href={href} className="link">
          {label}
        </a>,
      );
    } else if (/^https?:\/\//.test(href)) {
      out.push(
        <a key={key} href={href} target="_blank" rel="noreferrer" className="link">
          {label}
        </a>,
      );
    } else {
      out.push(
        <Link key={key} href={href} className="link">
          {label}
        </Link>,
      );
    }
    last = pattern.lastIndex;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}
