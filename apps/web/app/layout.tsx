import type { Metadata } from "next";
import "./globals.css";
import "./alpha.css"; // generated: opacity modifiers on var() colours (see scripts/gen-alpha.mjs)

export const metadata: Metadata = {
  title: "zeithub.otto",
  description: "Local AI-powered development studio",
  icons: { icon: "/icon.svg" },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
