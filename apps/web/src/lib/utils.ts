import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function shortAddress(addr: string | undefined | null, chars = 4): string {
  if (!addr) return "—";
  return `${addr.slice(0, chars + 2)}…${addr.slice(-chars)}`;
}
