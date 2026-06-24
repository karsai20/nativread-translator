import type { Metadata } from "next";
import { Fraunces, Inter } from "next/font/google";
import { ThemeProvider } from "@/components/shell/ThemeToggle";
import { Toaster } from "@/components/ui/sonner";
import "./globals.css";

// Characterful high-contrast serif for display + a clean grotesk for UI. latin-ext
// carries the Hungarian glyphs (ő ű). Self-hosted by next/font, so it works offline.
const fraunces = Fraunces({
  subsets: ["latin", "latin-ext"],
  variable: "--font-fraunces",
  style: ["normal", "italic"],
  display: "swap",
});
const inter = Inter({
  subsets: ["latin", "latin-ext"],
  variable: "--font-inter",
  display: "swap",
});

export const metadata: Metadata = {
  title: "Verzió — fordítóműhely",
  description: "Helyi könyvfordító műhely. Tölts fel egy könyvet, és kövesd a fordítás állapotát.",
};

// Set the theme class before paint so there is no light/dark flash. Default: dark.
const noFlash = `(function(){try{var t=localStorage.getItem('theme');var d=t?t==='dark':true;document.documentElement.classList.toggle('dark',d);}catch(e){document.documentElement.classList.add('dark');}})();`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="hu" className={`${fraunces.variable} ${inter.variable}`} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: noFlash }} />
      </head>
      <body>
        <ThemeProvider>
          {children}
          <Toaster />
        </ThemeProvider>
      </body>
    </html>
  );
}
