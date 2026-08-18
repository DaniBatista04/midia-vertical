"use client";

import dynamic from "next/dynamic";

/** Mesma razão do gerador: canvas e WebCodecs só existem no browser. */
const AutoRenderer = dynamic(() => import("./AutoRenderer").then((m) => m.AutoRenderer), {
  ssr: false,
  loading: () => <p style={{ padding: 24, color: "#ccc", fontFamily: "monospace" }}>clima/auto — carregando</p>,
});

export default function AutoRendererClient() {
  return <AutoRenderer />;
}
