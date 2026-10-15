import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Horizon",
  description:
    "Timestamp-aware, evidence-grounded learning assistant (MVP foundation).",
  // Served from /public. The app-directory metadata convention (src/app/icon.svg)
  // was registered by the build but not served in this Next version, which left
  // the browser logging a 404 for the tab icon.
  icons: { icon: [{ url: "/icon.svg", type: "image/svg+xml" }] },
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
