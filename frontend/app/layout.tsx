import type { Metadata, Viewport } from "next";
import { Hanken_Grotesk, JetBrains_Mono, Newsreader } from "next/font/google";
import "./globals.css";

const sans = Hanken_Grotesk({ variable: "--font-sans-face", subsets: ["latin"] });
const mono = JetBrains_Mono({ variable: "--font-mono-face", subsets: ["latin"] });
const serif = Newsreader({ variable: "--font-serif-face", subsets: ["latin"], style: ["normal", "italic"] });

export const metadata: Metadata = {
  title: "Twin",
  description: "Talk to your digital twin, or let it run your day.",
};

export const viewport: Viewport = { themeColor: "#171512" };

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className={`${sans.variable} ${mono.variable} ${serif.variable}`}>
      <body>{children}</body>
    </html>
  );
}
