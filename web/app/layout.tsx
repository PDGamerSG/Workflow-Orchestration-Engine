import type { Metadata } from "next";
import { Overpass, Overpass_Mono } from "next/font/google";
import "./globals.css";

const sans = Overpass({ subsets: ["latin"], variable: "--font-sans", display: "swap" });
const mono = Overpass_Mono({ subsets: ["latin"], variable: "--font-mono", display: "swap" });

export const metadata: Metadata = {
  title: "Relay",
  description: "Plan, run and watch durable LLM workflows.",
};

// Applies the stored theme before the first paint, so a reload never flashes the other one.
const THEME_SCRIPT = `try{var t=localStorage.getItem("relay-theme");if(t&&t!=="system")document.documentElement.dataset.theme=t}catch(e){}`;

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`${sans.variable} ${mono.variable}`} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
