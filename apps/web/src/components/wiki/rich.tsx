import Link from "next/link";
import type { ReactNode } from "react";

/**
 * The wiki's only inline markup: `**strong**` and `[label](href)`. Anchors (`#…`) stay on the page; other paths use
 * client navigation. Text is read with `t.raw`, so no ICU syntax is involved.
 */
export function rich(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  const pattern = /\*\*(.+?)\*\*|\[(.+?)\]\((.+?)\)/g;
  let last = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text))) {
    if (match.index > last) out.push(text.slice(last, match.index));
    const key = `${match.index}`;
    if (match[1]) {
      out.push(
        <strong key={key} className="font-medium text-fg">
          {match[1]}
        </strong>,
      );
    } else if (match[3].startsWith("#")) {
      out.push(
        <a key={key} href={match[3]} className="link">
          {match[2]}
        </a>,
      );
    } else {
      out.push(
        <Link key={key} href={match[3]} className="link">
          {match[2]}
        </Link>,
      );
    }
    last = pattern.lastIndex;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}
