import "./globals.css";
import type { Metadata } from "next";

export const metadata: Metadata = { title: "Portfolio Agent", description: "Quant signals + news sentiment screen for your Kite holdings" };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body suppressHydrationWarning>{children}</body>
    </html>
  );
}
