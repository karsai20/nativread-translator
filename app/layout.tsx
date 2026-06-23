import type { Metadata } from "next";
import { Fraunces, Inter } from "next/font/google";
import { Backdrop } from "@/components/app/Backdrop";
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
  title: "Verzió — könyvfordító",
  description: "Tölts fel egy könyvet, és olvasd tovább magyarul. Helyi, házi fordítóműhely.",
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
        <Backdrop />
        {children}
      </body>
    </html>
  );
}
