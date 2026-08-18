import AutoRendererClient from "@/components/weather/AutoRendererClient";

export const metadata = { title: "Clima automático — Mídia Vertical" };

/**
 * Superfície de automação do clima. Fica atrás do mesmo portão de sessão do
 * resto do painel — o runner faz login por `/api/login` antes de abrir aqui.
 */
export default function ClimaAutoPage() {
  return <AutoRendererClient />;
}
