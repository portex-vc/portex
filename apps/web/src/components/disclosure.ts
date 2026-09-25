/** Shared `<details>` row: full-width summary, chevron on the right, no native marker. */
export const SUMMARY =
  "flex cursor-pointer list-none items-center justify-between gap-3 py-3 text-xs font-medium text-fg-2 transition-colors hover:text-fg [&::-webkit-details-marker]:hidden";

/** Chevron for SUMMARY; the parent `<details>` must carry the `group` class. */
export const CHEVRON = "size-3.5 shrink-0 text-fg-3 transition-transform duration-150 group-open:rotate-180";
