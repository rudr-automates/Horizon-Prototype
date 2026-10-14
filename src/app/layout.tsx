import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Horizon",
  description:
    "Timestamp-aware, evidence-grounded learning assistant (MVP foundation).",
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
