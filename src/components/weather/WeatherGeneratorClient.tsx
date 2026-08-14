"use client";

import dynamic from "next/dynamic";

/**
 * O gerador é uma aplicação de canvas: WebCodecs, requestAnimationFrame e
 * medição de fonte só existem no browser. Renderizar no servidor não traz
 * ganho e ainda abriria espaço para divergência de fuso no campo de data.
 */
const WeatherGenerator = dynamic(
  () => import("./WeatherGenerator").then((m) => m.WeatherGenerator),
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
      <span className="spinner" /> Carregando gerador de clima…
    </div>
  );
}

export default function WeatherGeneratorClient() {
  return <WeatherGenerator />;
}
