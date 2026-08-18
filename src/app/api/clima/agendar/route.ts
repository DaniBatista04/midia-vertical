import { timingSafeEqual } from "node:crypto";

import type { NextRequest } from "next/server";

import {
  AgendamentoError,
  agendarClima,
  descreverResultado,
  horasDaJanela,
  type ResultadoAgendamento,
} from "@/lib/kuma/agendar";
import { SESSION_COOKIE, verifySession } from "@/lib/server/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
/**
 * Consultar inventário de mais de cem telas e criar a unidade são várias
 * chamadas em sequência contra a API do Kuma, que responde devagar quando o
 * portal está em uso.
 */
export const maxDuration = 120;

/**
 * Fase 2 do clima, como rota — o que antes era um job do GitHub Actions.
 *
 * Existe assim por causa de quem opera: a aprovação do criativo é manual no
 * portal do Kuma, e logo depois de aprovar a pessoa precisa da unidade já
 * criada para terminar a configuração dela. Cron de 5 minutos no Actions
 * deixava ela esperando; aqui o cron da Vercel roda de minuto em minuto, e o
 * link com token deixa ela mesma disparar na hora, sem sair do portal.
 *
 * Três chamadores, três formas de se identificar:
 *
 *  - **cron da Vercel** — `Authorization: Bearer $CRON_SECRET`, que a própria
 *    plataforma injeta quando a variável existe;
 *  - **o link que a pessoa clica** — `?t=$CLIMA_TOKEN`, porque um favorito do
 *    navegador só sabe fazer GET e não carrega sessão do painel;
 *  - **o painel** — cookie de sessão, como qualquer outra rota.
 *
 * A rota está na lista de públicas do `src/proxy.ts` justamente porque ela
 * autentica sozinha: sem nenhuma das três, responde 401 e não toca em nada.
 */

type Origem = "cron" | "link" | "painel";

function segredoConfere(recebido: string, esperado: string | undefined): boolean {
  // Segredo não configurado nunca vira "qualquer um passa".
  if (!esperado) return false;
  const a = Buffer.from(recebido, "utf8");
  const b = Buffer.from(esperado, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

async function autorizar(req: NextRequest): Promise<Origem | null> {
  const auth = req.headers.get("authorization") ?? "";
  if (auth.startsWith("Bearer ") && segredoConfere(auth.slice(7), process.env.CRON_SECRET)) {
    return "cron";
  }

  const token = req.nextUrl.searchParams.get("t");
  if (token && segredoConfere(token, process.env.CLIMA_TOKEN)) return "link";

  if (await verifySession(req.cookies.get(SESSION_COOKIE)?.value)) return "painel";

  return null;
}

/** Um clique num favorito espera uma página, não um JSON. */
function querHtml(req: NextRequest): boolean {
  if (req.nextUrl.searchParams.get("formato") === "json") return false;
  return (req.headers.get("accept") ?? "").includes("text/html");
}

function pagina(
  titulo: string,
  mensagem: string,
  detalhe: string,
  cor: string,
  status = 200,
): Response {
  const escapar = (s: string) =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return new Response(
    `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapar(titulo)}</title>
<style>
  :root { color-scheme: light dark; }
  body { margin:0; min-height:100vh; display:grid; place-items:center;
         font:16px/1.5 ui-sans-serif,system-ui,sans-serif; padding:24px; }
  .cartao { max-width:34rem; border-left:4px solid ${cor}; padding:20px 24px;
            background:color-mix(in srgb, ${cor} 8%, transparent); border-radius:8px; }
  h1 { margin:0 0 8px; font-size:1.1rem; }
  p { margin:0; }
  .detalhe { margin-top:12px; font-size:.85rem; opacity:.7; }
</style></head><body><div class="cartao">
<h1>${escapar(titulo)}</h1><p>${escapar(mensagem)}</p>
<p class="detalhe">${escapar(detalhe)}</p>
</div></body></html>`,
    { status, headers: { "Content-Type": "text/html; charset=utf-8" } },
  );
}

/** Título curto por situação, para a pessoa entender sem ler o resto. */
function titulo(r: ResultadoAgendamento): { texto: string; cor: string; detalhe: string } {
  switch (r.estado) {
    case "agendado":
      return {
        texto: "Agendado",
        cor: "#16a34a",
        detalhe: `Unidade ${r.unidadeId} · grupo criativo ${r.grupoId} · já pode configurar no portal.`,
      };
    case "ja-agendado":
      return {
        texto: "Já estava agendado",
        cor: "#16a34a",
        detalhe: `Unidade ${r.unidadeId}. Nada foi criado agora.`,
      };
    case "pendente":
      return {
        texto: "Ainda não aprovado",
        cor: "#ca8a04",
        detalhe: "Aprove o grupo na Análise Criativa e clique de novo — ou espere o próximo minuto.",
      };
    case "simulado":
      return { texto: "Simulação", cor: "#0284c7", detalhe: "Nada foi criado." };
    case "sem-registro":
      return {
        texto: "Nada para agendar",
        cor: "#64748b",
        detalhe: "O job das 23h não deixou registro para estas datas.",
      };
  }
}

export async function GET(req: NextRequest) {
  const origem = await autorizar(req);
  if (!origem) {
    return Response.json({ error: "Não autenticado" }, { status: 401 });
  }

  const params = req.nextUrl.searchParams;
  const opcoes = {
    data: params.get("data") ?? undefined,
    simular: params.get("simular") === "true",
    // `?janela=16-18` para veicular só naquela faixa; sem ela vale o padrão do
    // ambiente, e sem ambiente o Kuma decide.
    horas: horasDaJanela(params.get("janela") ?? undefined),
    log: (m: string) => console.log(`[agendar/${origem}] ${m}`),
  };

  try {
    const resultado = await agendarClima(opcoes);
    const mensagem = descreverResultado(resultado);
    console.log(`[agendar/${origem}] ${mensagem}`);

    if (querHtml(req)) {
      const t = titulo(resultado);
      return pagina(t.texto, mensagem, t.detalhe, t.cor);
    }
    return Response.json({ ok: true, origem, ...resultado, mensagem });
  } catch (e) {
    const mensagem = e instanceof Error ? e.message : String(e);
    console.error(`[agendar/${origem}] FALHOU: ${mensagem}`);

    // Erro de agendamento é definitivo e acionável (criativo reprovado, sem
    // inventário); o resto é falha inesperada. Os dois saem não-2xx de
    // propósito, para o cron aparecer como falha no painel da Vercel.
    const status = e instanceof AgendamentoError ? 409 : 500;
    if (querHtml(req)) {
      return pagina("Falhou", mensagem, "Nada foi agendado. Verifique no portal.", "#dc2626", status);
    }
    return Response.json({ ok: false, error: mensagem }, { status });
  }
}

/** Mesmo comportamento por POST, para quem preferir chamar de script. */
export const POST = GET;
