"use client";

import type { AdminRole } from "@/lib/admin";
import { cn } from "@/lib/utils";
import { KeyRound, Landmark, ShieldCheck, Users } from "lucide-react";
import { useTranslations } from "next-intl";
import * as React from "react";

export const ROLE_ICONS: Record<AdminRole, React.ComponentType<{ className?: string }>> = {
  curator: Landmark,
  attester: ShieldCheck,
  council: Users,
  apiAdmin: KeyRound,
};

/** Quiet role marker: an icon and the role name, never coloured. */
export function RoleChip({ role, className }: { role: AdminRole; className?: string }) {
  const t = useTranslations("admin.roles");
  const Icon = ROLE_ICONS[role];
  return (
    <span
      data-testid={`role-${role}`}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border border-fg/[0.1] bg-fg/[0.03] py-0.5 pl-1.5 pr-2 text-2xs font-medium text-fg-2",
        className,
      )}
    >
      <Icon className="size-3 text-fg-3" aria-hidden />
      {t(role)}
    </span>
  );
}

/** One role-gated section of the admin console. */
export function AdminSection({
  id,
  title,
  description,
  roles,
  aside,
  children,
  className,
}: {
  id: string;
  title: string;
  description?: React.ReactNode;
  roles: AdminRole[];
  aside?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section
      id={id}
      aria-labelledby={`${id}-title`}
      data-testid={`admin-${id}`}
      className={cn("scroll-mt-24 space-y-5", className)}
    >
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div className="min-w-0 space-y-1.5">
          <div className="flex flex-wrap items-center gap-2.5">
            <h2 id={`${id}-title`} className="t-section">
              {title}
            </h2>
            {roles.map((role) => (
              <RoleChip key={role} role={role} />
            ))}
          </div>
          {description ? <p className="max-w-2xl text-sm leading-relaxed text-fg-2">{description}</p> : null}
        </div>
        {aside ? <div className="shrink-0">{aside}</div> : null}
      </div>
      {children}
    </section>
  );
}

/** Two-step inline confirmation for irreversible curator actions; the drawer review follows. */
export function ConfirmRow({
  message,
  onConfirm,
  onCancel,
  confirmLabel,
  cancelLabel,
  testId,
}: {
  message: React.ReactNode;
  onConfirm: () => void;
  onCancel: () => void;
  confirmLabel: string;
  cancelLabel: string;
  testId?: string;
}) {
  return (
    <div
      role="alertdialog"
      aria-live="polite"
      data-testid={testId}
      className="flex flex-col gap-3 rounded-[12px] border border-fg/[0.12] bg-fg/[0.03] p-3.5 motion-safe:animate-in motion-safe:fade-in-0 motion-safe:slide-in-from-top-1 sm:flex-row sm:items-center sm:justify-between"
    >
      <p className="text-xs leading-relaxed text-fg-2">{message}</p>
      <div className="flex shrink-0 gap-2">
        <button
          type="button"
          onClick={onCancel}
          className="h-8 rounded-[9px] px-3 text-[0.8125rem] text-fg-2 transition-colors hover:bg-fg/[0.05] hover:text-fg"
        >
          {cancelLabel}
        </button>
        <button
          type="button"
          onClick={onConfirm}
          data-testid={testId ? `${testId}-confirm` : undefined}
          className="h-8 rounded-[9px] bg-fg px-3 text-[0.8125rem] font-medium text-bg shadow-[inset_0_1px_0_rgb(255_255_255/0.14)] transition-[background-color,transform] duration-150 hover:bg-fg/90 active:scale-[0.985]"
        >
          {confirmLabel}
        </button>
      </div>
    </div>
  );
}

/** Accessible on/off switch (no colour beyond the monochrome tokens). */
export function Switch({
  checked,
  onChange,
  label,
  id,
  invalid,
}: {
  checked: boolean;
  onChange: (value: boolean) => void;
  label: string;
  id?: string;
  invalid?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      id={id}
      aria-checked={checked}
      aria-label={label}
      aria-invalid={invalid || undefined}
      onClick={() => onChange(!checked)}
      className={cn(
        "relative inline-flex h-5 w-9 shrink-0 items-center rounded-full border transition-colors duration-200",
        checked ? "border-fg bg-fg" : "border-fg/[0.14] bg-fg/[0.06]",
        invalid && "border-negative/60",
      )}
    >
      <span
        aria-hidden
        className={cn(
          "size-3.5 rounded-full shadow-sm transition-transform duration-200 ease-out",
          checked ? "translate-x-[1.125rem] bg-bg" : "translate-x-[0.1875rem] bg-fg-3",
        )}
      />
    </button>
  );
}

/** Label/value row used in read-only admin tables. */
export function Fact({ label, children, className }: { label: string; children: React.ReactNode; className?: string }) {
  return (
    <div className={cn("flex items-baseline justify-between gap-4 py-2.5", className)}>
      <dt className="min-w-0 text-xs text-fg-3">{label}</dt>
      <dd className="num min-w-0 text-right text-sm text-fg">{children}</dd>
    </div>
  );
}
