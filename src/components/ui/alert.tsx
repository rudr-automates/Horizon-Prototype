"use client";

/**
 * An inline alert. Used for state the product must admit: a missing transcript,
 * a fixture corpus, a blocked guard, a database path that cannot be read.
 *
 * Deliberately quieter than a modal: these are conditions, not interruptions, and
 * the rest of the studio keeps working around them.
 */
import type { ReactNode } from "react";
import { Icon } from "@/components/ui/icons";

export function Alert({
  tone,
  title,
  action,
  children,
}: {
  tone: "warn" | "danger" | "info";
  title: string;
  action?: ReactNode;
  children?: ReactNode;
}) {
  const styles =
    tone === "warn"
      ? { box: "border-warn-line bg-warn-soft", ink: "text-warn", icon: "warning" as const }
      : tone === "danger"
        ? { box: "border-danger-line bg-danger-soft", ink: "text-danger", icon: "warning" as const }
        : { box: "border-brand-line bg-brand-soft", ink: "text-brand-strong", icon: "info" as const };

  return (
    <div className={`flex items-start gap-2.5 rounded-panel border px-3.5 py-2.5 ${styles.box}`} role="status">
      <Icon name={styles.icon} size={15} className={`mt-0.5 ${styles.ink}`} />
      <div className="min-w-0 flex-1">
        <p className={`text-[13px] font-semibold leading-5 ${styles.ink}`}>{title}</p>
        {children && (
          <div className="mt-0.5 text-xs leading-5 text-ink-soft">{children}</div>
        )}
      </div>
      {action && <div className={`shrink-0 text-xs ${styles.ink}`}>{action}</div>}
    </div>
  );
}
