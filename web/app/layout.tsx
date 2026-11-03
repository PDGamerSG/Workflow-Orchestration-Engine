import type { Metadata } from "next";
import { Overpass, Overpass_Mono } from "next/font/google";
import "./globals.css";

const sans = Overpass({
  subsets: ["latin"],
  variable: "--font-sans",
  display: "swap",
});
const mono = Overpass_Mono({
  subsets: ["latin"],
  variable: "--font-mono",
  display: "swap",
});

export const metadata: Metadata = {
  title: "Relay | Durable agent orchestration",
  description:
    "An orchestration engine built from scratch. Plan a goal, run agents in parallel, recover from failures and inspect every step. Bring your own API key or try the demo.",
  openGraph: {
    title: "Relay | Durable agent orchestration",
    description: "Parallel agents. Persistent results. Every step in view.",
    type: "website",
  },
};

// Applies the stored theme before the first paint, so a reload never flashes the other one.
const THEME_SCRIPT = `try{var t=localStorage.getItem("relay-theme");if(t&&t!=="system")document.documentElement.dataset.theme=t}catch(e){}`;

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      className={`${sans.variable} ${mono.variable}`}
      suppressHydrationWarning
    >
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
      </head>
      <body>
        <a href="#main-content" className="skip-link">
          Skip to content
        </a>
        <div id="main-content">{children}</div>
      </body>
    </html>
  );
}
