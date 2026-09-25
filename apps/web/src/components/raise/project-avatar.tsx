"use client";

import type { BuilderProfile } from "@/lib/api";
import { cn } from "@/lib/utils";
import { useState } from "react";

const SIZES = {
  xs: "size-5 rounded-[6px] text-[0.5rem]",
  sm: "size-6 rounded-[7px] text-[0.5625rem]",
  md: "size-10 rounded-[11px] text-[0.6875rem]",
  lg: "size-14 rounded-[15px] text-sm",
};

/** The image a project is identified by: the uploaded image, else the legacy logo URL, else none. */
export function projectImage(profile?: Pick<BuilderProfile, "imageUrl" | "logoUrl"> | null): string | null {
  const candidate = profile?.imageUrl || profile?.logoUrl || null;
  return candidate && /^https?:\/\//i.test(candidate) ? candidate : null;
}

/**
 * Project image as a crisp rounded square with a hairline edge drawn over it, or a quiet monogram when
 * there is no image or it fails to load.
 */
export function ProjectAvatar({
  symbol,
  profile,
  src,
  logoUrl,
  large = false,
  size,
  className,
}: {
  symbol: string;
  /** Resolves `imageUrl`, then `logoUrl`. */
  profile?: Pick<BuilderProfile, "imageUrl" | "logoUrl"> | null;
  /** Explicit image URL; takes precedence over `profile`. */
  src?: string | null;
  /** @deprecated Pass `profile` so an uploaded image wins over the legacy logo. */
  logoUrl?: string | null;
  large?: boolean;
  size?: keyof typeof SIZES;
  className?: string;
}) {
  const explicit = src !== undefined ? src : logoUrl;
  const url =
    explicit !== undefined ? (explicit && /^https?:\/\//i.test(explicit) ? explicit : null) : projectImage(profile);
  const [failed, setFailed] = useState<string | null>(null);
  const [loaded, setLoaded] = useState<string | null>(null);
  const valid = url && failed !== url;
  const s = size ?? (large ? "lg" : "md");
  return (
    <span
      className={cn(
        "relative isolate flex shrink-0 items-center justify-center overflow-hidden bg-fg/[0.06] font-mono font-medium text-fg-2",
        SIZES[s],
        className,
      )}
      aria-hidden
    >
      {!valid || loaded !== url ? symbol.slice(0, s === "sm" || s === "xs" ? 1 : 3) : null}
      {valid ? (
        // eslint-disable-next-line @next/next/no-img-element -- remote project images of arbitrary origin
        <img
          src={url}
          alt=""
          decoding="async"
          draggable={false}
          className={cn(
            "absolute inset-0 size-full object-cover transition-opacity duration-300 ease-out",
            loaded === url ? "opacity-100" : "opacity-0",
          )}
          onLoad={() => setLoaded(url)}
          ref={(img) => {
            // Cached images can finish before hydration attaches onLoad.
            if (img?.complete && img.naturalWidth > 0 && loaded !== url) setLoaded(url);
          }}
          onError={() => setFailed(url)}
        />
      ) : null}
      {/* Hairline drawn above the image so light and dark artwork keep the same crisp edge. */}
      <span
        aria-hidden
        className="pointer-events-none absolute inset-0 rounded-[inherit] ring-1 ring-inset ring-fg/[0.1]"
      />
    </span>
  );
}
