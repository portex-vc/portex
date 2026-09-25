// Pretty formatting for the quote asset (6 decimals), project tokens (18 decimals),
// book prices (quote base units per whole token) and basis points.

export function fmtQuote(x: bigint, decimals = 2): string {
  return `${fmtUnits(x, 6, decimals)} USDG`;
}

export function fmtToken(x: bigint, decimals = 4): string {
  return fmtUnits(x, 18, decimals);
}

/** bookPrice()/dex price are quote base units per whole token → USDG price = x / 1e6. */
export function fmtPrice(bookPrice: bigint): string {
  return `${fmtUnits(bookPrice, 6, 6)} USDG`;
}

/** USDG amount from a plain number: q(50_000) = 50_000e6 base units. */
export function q(amount: number | bigint): bigint {
  return BigInt(amount) * 1_000_000n;
}

/** Whole-token amount: t(1_000_000) = 1e6e18 base units. */
export function t(amount: number | bigint): bigint {
  return BigInt(amount) * 1_000_000_000_000_000_000n;
}

export function fmtBps(bps: number | bigint): string {
  return `${(Number(bps) / 100).toFixed(1)}%`;
}

export function fmtDuration(sec: number | bigint): string {
  const s = Number(sec);
  if (s % 3600 === 0) return `${s / 3600}h`;
  if (s % 60 === 0) return `${s / 60}min`;
  return `${s}s`;
}

export function fmtPct(x: number, decimals = 1): string {
  return `${(x * 100).toFixed(decimals)}%`;
}

/** Signed quote delta for P&L columns. */
export function fmtSignedQuote(x: bigint): string {
  const sign = x < 0n ? '-' : '+';
  return `${sign}${fmtUnits(x < 0n ? -x : x, 6, 2)}`;
}

export function fmtUnits(x: bigint, decimals: number, displayDecimals: number): string {
  const neg = x < 0n;
  const v = neg ? -x : x;
  const base = 10n ** BigInt(decimals);
  const whole = v / base;
  const frac = v % base;
  const fracStr = frac.toString().padStart(decimals, '0').slice(0, displayDecimals);
  const grouped = whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${neg ? '-' : ''}${grouped}${displayDecimals > 0 ? `.${fracStr}` : ''}`;
}

export function shortAddr(addr: string): string {
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

/** Markdown table row from cells. */
export function mdRow(cells: (string | number)[]): string {
  return `| ${cells.join(' | ')} |`;
}
