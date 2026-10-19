"use client";

/**
 * Shared presentation pieces.
 *
 * These exist so the same button, chip and empty state look and behave the same
 * way on every panel. They are deliberately thin: no variant library, no theme
 * object, just class strings the design tokens in globals.css resolve.
 *
 * `ConfirmAction` is the only stateful primitive. It is used before removing a
 * note or bookmark, because a one-click delete with no undo is the kind of
 * destructive detail that makes a demo feel unfinished.
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Icon, type IconName } from "@/components/ui/icons";

type ButtonTone = "primary" | "secondary" | "ghost" | "danger";

/*
 * Contrast note: primary and danger fills are LIGHT in this theme, so their text
 * is `text-ink-inverse` (7.6:1 on brand, 6.9:1 on danger), not `text-white`,
 * which reads at about 2:1 on a periwinkle button and fails AA outright.
 */
const BUTTON_TONES: Record<ButtonTone, string> = {
  primary:
    "border-brand bg-brand text-ink-inverse hover:border-brand-strong hover:bg-brand-strong disabled:border-line-strong disabled:bg-line-strong disabled:text-ink-faint",
  secondary:
    "border-line-strong bg-surface text-ink hover:border-brand-line hover:bg-brand-soft disabled:border-line disabled:bg-surface-muted disabled:text-ink-faint",
  ghost:
    "border-transparent bg-transparent text-ink-soft hover:bg-surface-muted hover:text-ink disabled:text-ink-faint",
  danger:
    "border-danger-line bg-danger-soft text-danger hover:border-danger hover:bg-danger hover:text-ink-inverse",
};

const BUTTON_SIZES = {
  sm: "px-2.5 py-1.5 text-xs gap-1.5",
  md: "px-3.5 py-2 text-sm gap-2",
  lg: "px-4 py-2.5 text-sm gap-2",
} as const;

export function Button({
  children,
  tone = "secondary",
  size = "md",
  icon,
  className = "",
  type = "button",
  ...rest
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  tone?: ButtonTone;
  size?: keyof typeof BUTTON_SIZES;
  icon?: IconName;
}) {
  return (
    <button
      type={type}
      className={`inline-flex items-center justify-center rounded-control border font-semibold transition-[background-color,border-color,color,box-shadow] duration-150 disabled:cursor-not-allowed ${BUTTON_TONES[tone]} ${BUTTON_SIZES[size]} ${className}`}
      {...rest}
    >
      {icon && <Icon name={icon} size={size === "sm" ? 14 : 16} />}
      {children}
    </button>
  );
}

/** A square, label-less control. `label` is required and becomes the a11y name. */
export function IconButton({
  name,
  label,
  tone = "ghost",
  className = "",
  ...rest
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  name: IconName;
  label: string;
  tone?: ButtonTone;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      className={`inline-flex h-8 w-8 items-center justify-center rounded-control border transition-[background-color,border-color,color] duration-150 disabled:cursor-not-allowed ${BUTTON_TONES[tone]} ${className}`}
      {...rest}
    >
      <Icon name={name} size={16} />
    </button>
  );
}

type PillTone = "brand" | "ok" | "warn" | "danger" | "neutral" | "outline";

const PILL_TONES: Record<PillTone, string> = {
  brand: "border-brand-line bg-brand-soft text-brand-strong",
  ok: "border-ok-line bg-ok-soft text-ok",
  warn: "border-warn-line bg-warn-soft text-warn",
  danger: "border-danger-line bg-danger-soft text-danger",
  neutral: "border-line bg-neutral-soft text-ink-soft",
  outline: "border-line-strong bg-surface text-ink-soft",
};

export function Pill({
  id,
  tone = "neutral",
  children,
  className = "",
}: {
  id?: string;
  tone?: PillTone;
  children: ReactNode;
  className?: string;
}) {
  return (
    <span
      id={id}
      className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-semibold leading-5 ${PILL_TONES[tone]} ${className}`}
    >
      {children}
    </span>
  );
}

export function Panel({
  children,
  className = "",
  as: Tag = "section",
  tone = "solid",
}: {
  children: ReactNode;
  className?: string;
  as?: "section" | "div" | "aside" | "article";
  /**
   * `glass` is for chrome and the hero. It is never used for text that has to be
   * read for minutes at a time — see the reading-surface rule in globals.css.
   */
  tone?: "solid" | "glass";
}) {
  return (
    <Tag
      className={`rounded-panel border bg-surface shadow-panel ${
        tone === "glass" ? "glass border-line-strong shadow-float" : "border-line"
      } ${className}`}
    >
      {children}
    </Tag>
  );
}

export function PanelHeader({
  title,
  description,
  actions,
  eyebrow,
  id,
}: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  eyebrow?: string;
  id?: string;
}) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-3 border-b border-line px-4 py-3 sm:px-5">
      <div className="min-w-0">
        {eyebrow && (
          <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-faint">
            {eyebrow}
          </p>
        )}
        <h2 id={id} className="text-[15px] font-semibold leading-6 text-ink">
          {title}
        </h2>
        {description && (
          <p className="mt-0.5 text-xs leading-5 text-ink-soft">{description}</p>
        )}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

export function SectionHeading({
  eyebrow,
  title,
  description,
  actions,
  level = 1,
}: {
  eyebrow?: string;
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  /** 1 for a page title, 2 for a titled block inside a page. */
  level?: 1 | 2;
}) {
  const Tag = level === 1 ? "h1" : "h2";
  return (
    <div className="flex flex-wrap items-end justify-between gap-4">
      <div className="min-w-0 max-w-2xl">
        {eyebrow && (
          <p className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[0.14em] text-brand">
            {eyebrow}
          </p>
        )}
        <Tag
          className={
            level === 1
              ? "mt-2 text-balance text-2xl font-semibold leading-9 tracking-[-0.02em] text-ink sm:text-[30px] sm:leading-10"
              : "mt-1.5 text-balance text-xl font-semibold leading-7 tracking-[-0.01em] text-ink"
          }
        >
          {title}
        </Tag>
        {description && (
          <p className="mt-2 text-sm leading-6 text-ink-soft">{description}</p>
        )}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

export function EmptyState({
  icon = "info",
  title,
  children,
  action,
}: {
  icon?: IconName;
  title: string;
  children?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 px-6 py-10 text-center">
      <span className="flex h-9 w-9 items-center justify-center rounded-full bg-surface-sunken text-ink-faint">
        <Icon name={icon} size={18} />
      </span>
      <p className="text-sm font-semibold text-ink">{title}</p>
      {children && (
        <div className="max-w-sm text-xs leading-5 text-ink-soft">{children}</div>
      )}
      {action}
    </div>
  );
}

/** A pure skeleton. Used only where content is genuinely still loading. */
export function Skeleton({ className = "" }: { className?: string }) {
  return (
    <div
      aria-hidden="true"
      className={`animate-pulse rounded bg-surface-sunken ${className}`}
    />
  );
}

/**
 * Two-step destroy control.
 *
 * The confirmation replaces the control in place instead of opening a modal: it
 * is smaller, it cannot be dismissed by an accidental backdrop click, and it
 * keeps the surrounding list readable while the person decides.
 */
export function ConfirmAction({
  onConfirm,
  label = "Delete",
  confirmLabel = "Confirm delete",
  icon = "trash",
}: {
  onConfirm: () => void;
  label?: string;
  confirmLabel?: string;
  icon?: IconName;
}) {
  const [arming, setArming] = useState(false);
  const timer = useRef<number | undefined>(undefined);

  useEffect(() => {
    if (!arming) return;
    timer.current = window.setTimeout(() => setArming(false), 5000);
    return () => window.clearTimeout(timer.current);
  }, [arming]);

  if (!arming) {
    return (
      <IconButton
        name={icon}
        label={label}
        onClick={() => setArming(true)}
        className="text-ink-faint hover:text-danger"
      />
    );
  }
  return (
    <span className="inline-flex items-center gap-1">
      <Button
        tone="danger"
        size="sm"
        onClick={() => {
          setArming(false);
          onConfirm();
        }}
      >
        {confirmLabel}
      </Button>
      <Button tone="ghost" size="sm" onClick={() => setArming(false)}>
        Keep
      </Button>
    </span>
  );
}
