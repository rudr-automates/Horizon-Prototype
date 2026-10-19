/**
 * A small, dependency-free icon set.
 *
 * WHY INLINE SVGs
 *   The project carries no icon package, and adding one for eleven glyphs would
 *   cost a dependency and a bundle for shapes that fit in a few dozen bytes each.
 *   Every icon is stroke-based on a 24px grid, inherits `currentColor`, and is
 *   `aria-hidden` by default: an icon here is decoration beside a real label, so
 *   a screen reader should not announce it twice. When an icon stands alone, the
 *   caller passes `label`, which makes it the accessible name instead.
 */
import type { SVGProps } from "react";

const PATHS = {
  home: "M4 10.5 12 4l8 6.5V20H4v-9.5Zm5 9.5v-6h6v6",
  user: "M20 21a8 8 0 0 0-16 0m8-11a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z",
  sparkle: "M12 4l1.6 4.4L18 10l-4.4 1.6L12 16l-1.6-4.4L6 10l4.4-1.6L12 4Zm6 9.5.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8.8-2.2Z",
  learn: "M4 5.5A2.5 2.5 0 0 1 6.5 3H19v15H6.5A2.5 2.5 0 0 0 4 20.5V5.5Zm0 15A2.5 2.5 0 0 1 6.5 18H19v3H6.5A2.5 2.5 0 0 1 4 20.5Z",
  materials: "M4 4h6l2 3h8v13H4V4Zm3 9h10M7 17h6",
  notes: "M6 3h9l4 4v14H6V3Zm8 0v5h5M9 12h7M9 16h5",
  progress: "M4 19V9m5 10V5m5 14v-7m5 7V8",
  status: "M3 12h4l2-5 4 10 2-5h6",
  play: "M8 5.5v13l11-6.5-11-6.5Z",
  pause: "M9 5v14M15 5v14",
  bookmark: "M6 3h12v18l-6-4.5L6 21V3Z",
  note: "M4 4h11l5 5v11H4V4Zm4 7h8M8 15h5",
  search: "M11 4a7 7 0 1 1 0 14 7 7 0 0 1 0-14Zm5 12 5 5",
  close: "M6 6l12 12M18 6 6 18",
  check: "M4 12.5 9 18 20 6",
  clock: "M12 3a9 9 0 1 1 0 18 9 9 0 0 1 0-18Zm0 4v5l4 2",
  file: "M6 3h9l4 4v14H6V3Zm8 0v5h5",
  presentation: "M3 4h18v11H3V4Zm9 11v5m-4 0h8",
  code: "M9 7l-5 5 5 5m6-10 5 5-5 5",
  video: "M3 6h12v12H3V6Zm12 4 6-3v10l-6-3",
  chevron: "M9 6l6 6-6 6",
  arrow: "M4 12h15m-5-6 6 6-6 6",
  trash: "M4 7h16M9 7V5h6v2m-9 0 1 14h10l1-14",
  pencil: "M4 20h4l11-11-4-4L4 16v4Zm10-14 4 4",
  warning: "M12 3 2.5 20h19L12 3Zm0 6v5m0 3v.5",
  info: "M12 3a9 9 0 1 1 0 18 9 9 0 0 1 0-18Zm0 8v5m0-8v.5",
  external: "M14 4h6v6M20 4l-8 8M18 14v5H5V6h5",
  switch: "M4 8h13m-4-4 4 4-4 4M20 16H7m4-4-4 4 4 4",
  layers: "M12 3 3 8l9 5 9-5-9-5Zm-9 9 9 5 9-5",
} as const;

export type IconName = keyof typeof PATHS;

export function Icon({
  name,
  size = 18,
  label,
  className = "",
  ...rest
}: SVGProps<SVGSVGElement> & {
  name: IconName;
  size?: number;
  /** When the icon is the only content of a control, name it here. */
  label?: string;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={`shrink-0 ${className}`}
      aria-hidden={label ? undefined : true}
      role={label ? "img" : undefined}
      aria-label={label}
      focusable="false"
      {...rest}
    >
      <path d={PATHS[name]} />
    </svg>
  );
}
