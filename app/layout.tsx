import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Könyvfordító — magyarra",
  description: "Tölts fel egy könyvet, és magyarul olvasd tovább.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="hu">
      <body>{children}</body>
    </html>
  );
}
