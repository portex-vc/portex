"use client";

import { displayAmountInput, normalizeAmountEdit } from "@/lib/amount-input";
import { isValidAmountInput } from "@/lib/format";
import { useNumbers } from "@/lib/use-numbers";
import { cn } from "@/lib/utils";
import { useLocale, useTranslations } from "next-intl";
import { formatUnits } from "viem";

/** Amount field with the unit and a Max shortcut inside the field, and the available balance under it. */
export function AmountInput({
  value,
  onChange,
  symbol,
  balance,
  balanceDecimals,
  balanceLabel,
  placeholder = "0",
  disabled,
  id,
  maxTestId,
}: {
  value: string;
  onChange: (v: string) => void;
  symbol?: string;
  /** Smallest-unit balance used by Max and shown under the input. */
  balance?: bigint;
  balanceDecimals?: number;
  /** Label for the balance line ("Wallet balance", "Position tokens"). */
  balanceLabel?: string;
  placeholder?: string;
  disabled?: boolean;
  /** Forwarded to the underlying <input> (for labels and tests). */
  id?: string;
  maxTestId?: string;
}) {
  const t = useTranslations("amount");
  const locale = useLocale();
  const n = useNumbers();
  const invalid = value !== "" && !isValidAmountInput(value);
  const over =
    balance !== undefined &&
    balanceDecimals !== undefined &&
    value !== "" &&
    !invalid &&
    exceeds(value, balance, balanceDecimals);
  return (
    <div className="flex flex-col gap-1.5">
      <div
        className={cn(
          "flex h-14 items-center gap-2 rounded-[12px] border bg-fg/[0.025] pl-4 pr-2 transition-[border-color,box-shadow] duration-150 focus-within:border-fg/25 focus-within:shadow-[0_0_0_4px_rgb(var(--fg)/0.05)]",
          invalid || over ? "border-negative/60" : "border-fg/[0.1]",
          disabled && "opacity-50",
        )}
      >
        <input
          id={id}
          aria-label={t("label", { unit: symbol ?? "" })}
          aria-invalid={invalid || over || undefined}
          inputMode="decimal"
          autoComplete="off"
          placeholder={placeholder}
          value={displayAmountInput(value, locale)}
          disabled={disabled}
          onChange={(e) => {
            const v = normalizeAmountEdit(e.target.value, locale);
            if ((isValidAmountInput(v) && (v.split(".")[1]?.length ?? 0) <= (balanceDecimals ?? 18)) || v === "")
              onChange(v);
          }}
          className="num min-w-0 flex-1 bg-transparent text-xl font-normal tracking-[-0.02em] outline-none placeholder:text-fg-3/70"
        />
        {symbol ? <span className="whitespace-nowrap text-sm text-fg-3">{symbol}</span> : null}
        {balanceDecimals !== undefined ? (
          <button
            type="button"
            data-testid={maxTestId}
            disabled={disabled || balance === undefined || balance === 0n}
            title={balance === undefined ? t("unavailable") : undefined}
            onClick={() => balance !== undefined && onChange(formatUnits(balance, balanceDecimals))}
            className="h-7 rounded-[8px] bg-fg/[0.06] px-2.5 text-xs font-medium text-fg-2 transition-colors hover:bg-fg/[0.1] hover:text-fg disabled:opacity-40 disabled:hover:bg-fg/[0.06]"
          >
            {t("max")}
          </button>
        ) : null}
      </div>
      {balanceDecimals !== undefined ? (
        <p className="num flex justify-between gap-3 px-0.5 text-xs text-fg-3">
          <span>{balanceLabel ?? t("balance")}</span>
          <span>
            {balanceDecimals === 6 ? n.quote(balance) : n.token(balance)} {symbol}
          </span>
        </p>
      ) : null}
    </div>
  );
}

function exceeds(value: string, balance: bigint, decimals: number) {
  const [whole, fraction = ""] = value.split(".");
  try {
    const atoms =
      BigInt(whole || "0") * 10n ** BigInt(decimals) +
      BigInt((fraction + "0".repeat(decimals)).slice(0, decimals) || "0");
    return atoms > balance;
  } catch {
    return false;
  }
}
