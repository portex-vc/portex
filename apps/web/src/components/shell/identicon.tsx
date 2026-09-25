import { cn } from "@/lib/utils";

/**
 * Deterministic account glyph: two muted hues and an angle derived from the address, so the same
 * account always looks the same across the app without external services.
 */
export function Identicon({ address, size = 18, className }: { address: string; size?: number; className?: string }) {
  const hex = address.toLowerCase().replace(/^0x/, "").padEnd(40, "0");
  const n = (i: number) => parseInt(hex.slice(i, i + 4), 16);
  const h1 = n(0) % 360;
  const h2 = (h1 + 40 + (n(4) % 140)) % 360;
  const angle = n(8) % 360;
  return (
    <span
      aria-hidden
      className={cn("inline-block shrink-0 rounded-full ring-1 ring-inset ring-fg/10", className)}
      style={{
        width: size,
        height: size,
        background: `linear-gradient(${angle}deg, hsl(${h1} 42% 58%), hsl(${h2} 48% 42%))`,
      }}
    />
  );
}
