import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono, Kalam } from "next/font/google";
import "./globals.css";

const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });
// Hand-written marker look for everything drawn on the whiteboard.
const kalam = Kalam({ variable: "--font-kalam", subsets: ["latin"], weight: ["400", "700"] });

export const metadata: Metadata = {
  title: { default: "Whiteboard Tutor - learn anything in two minutes", template: "%s | Whiteboard Tutor" },
  description:
    "Type any topic and get a two-minute lesson taught with a friendly voice and a live, hand-drawn whiteboard. Pause, rewind, and ask follow-up questions.",
  applicationName: "Whiteboard Tutor",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f6f4ee" },
    { media: "(prefers-color-scheme: dark)", color: "#0d0d12" },
  ],
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`${geistSans.variable} ${geistMono.variable} ${kalam.variable} h-full`}>
      <body className="flex min-h-full flex-col">{children}</body>
    </html>
  );
}
