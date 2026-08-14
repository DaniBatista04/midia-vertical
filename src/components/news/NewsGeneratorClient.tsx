"use client";

import dynamic from "next/dynamic";

/** Mesma razão do gerador de clima: tudo aqui depende do canvas do browser. */
const NewsGenerator = dynamic(
  () => import("./NewsGenerator").then((m) => m.NewsGenerator),
  { ssr: false, loading: () => <BootScreen /> },
);

function BootScreen() {
  return (
    <div
      style={{
        height: "100dvh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        color: "#cccccc",
        fontSize: 13,
        gap: 10,
      }}
    >
      <span className="spinner" /> Carregando gerador de notícias…
    </div>
  );
}

export default function NewsGeneratorClient() {
  return <NewsGenerator />;
}
