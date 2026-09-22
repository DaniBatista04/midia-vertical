import type { Metadata } from "next";

// Mesmos pesos que os geradores originais carregavam do Google Fonts,
// agora self-hosted: sem requisição externa e determinístico no headless.
import "@fontsource/inter/300.css";
import "@fontsource/inter/400.css";
import "@fontsource/inter/500.css";
import "@fontsource/inter/700.css";
import "@fontsource/dm-sans/300.css";
import "@fontsource/dm-sans/400.css";
import "@fontsource/dm-sans/700.css";
import "@fontsource/bebas-neue/400.css";

import "./globals.css";

export const metadata: Metadata = {
  title: "Mídia Vertical — Focus Media",
  description:
    "Geradores de criativo para as telas verticais: cards de notícia e previsão do tempo, nos formatos 1080×1920 e 1080×2560.",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="pt-BR">
      <body>{children}</body>
    </html>
  );
}
