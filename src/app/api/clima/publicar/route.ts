import type { NextRequest } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Dispara a automação do clima na hora, para o operador não depender das 23h.
 *
 * **Por que isto chama o GitHub Actions em vez de fazer o trabalho aqui.** A
 * fase 1 renderiza 250 frames em dois formatos com Chromium, re-embala com
 * ffmpeg e espera dez minutos para o material propagar antes de submeter. Nada
 * disso cabe numa rota da Vercel: não há Chromium, e os dois MP4 juntos passam
 * do limite de corpo de requisição. Refazer o pipeline aqui seria uma segunda
 * implementação para divergir da primeira no próximo ajuste de layout — então a
 * rota apenas aciona o mesmo workflow que roda todas as noites, com a data que o
 * operador escolheu.
 *
 * **O que ela não faz:** criar a unidade. O criativo precisa estar aprovado para
 * receber estratégia, e aprovar é manual no portal. Depois da aprovação, o cron
 * de minuto cria plano e unidade e amarra sozinho — ou o operador clica o link.
 *
 * Autenticação é a sessão do painel: esta rota **não** está na lista de públicas
 * do `src/proxy.ts`, então o portão de sessão já a protege.
 */

/** `owner/repo` de onde o workflow roda. */
const REPO = process.env.GITHUB_REPO ?? "DaniBatista04/midia-vertical";
const WORKFLOW = "clima-diario.yml";

type Corpo = {
  /** `YYYY-MM-DD`, decidida no cliente a partir da previsão que ele já buscou. */
  data?: string;
  duracao?: number;
  modo?: "dia" | "semana";
};

export async function POST(req: NextRequest) {
  // O pedido é conferido antes da configuração do servidor: requisição
  // malformada é erro de quem chamou, e responder "falta variável de ambiente"
  // para uma data inválida manda o operador caçar o problema errado.
  let corpo: Corpo;
  try {
    corpo = (await req.json()) as Corpo;
  } catch {
    return Response.json({ error: "Requisição inválida." }, { status: 400 });
  }

  const data = String(corpo.data ?? "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(data)) {
    return Response.json({ error: "Data inválida — use YYYY-MM-DD." }, { status: 400 });
  }
  // Guarda contra data digitada errado: a automação só faz sentido para hoje ou
  // os próximos dois dias, e a previsão horária nem alcança mais que isso.
  const hoje = new Date();
  hoje.setHours(0, 0, 0, 0);
  const alvo = new Date(`${data}T00:00:00`);
  const dias = Math.round((alvo.getTime() - hoje.getTime()) / 86_400_000);
  if (dias < 0 || dias > 2) {
    return Response.json(
      { error: `Data fora do alcance: ${data} — só hoje ou os dois dias seguintes.` },
      { status: 400 },
    );
  }

  const duracao = Number(corpo.duracao ?? 10);
  const modo = corpo.modo === "semana" ? "semana" : "dia";

  const token = process.env.GITHUB_DISPATCH_TOKEN;
  if (!token) {
    return Response.json(
      {
        error:
          "GITHUB_DISPATCH_TOKEN não configurado no servidor — sem ele o painel não " +
          "consegue acionar o workflow do clima.",
      },
      { status: 503 },
    );
  }

  const resposta = await fetch(
    `https://api.github.com/repos/${REPO}/actions/workflows/${WORKFLOW}/dispatches`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        ref: "main",
        inputs: {
          data,
          modo,
          duracao: String(duracao),
          // Vazio de propósito: o script decide o índice sozinho, subindo um
          // quando já existe registro para a data. Mandar "1" fixo faria o
          // reenvio repetir nome de arquivo, que o Kuma reprova com 502 e
          // feedback vazio.
          indice: "",
        },
      }),
    },
  );

  if (!resposta.ok) {
    const detalhe = (await resposta.text()).slice(0, 300);
    console.error(`[publicar] GitHub recusou (${resposta.status}): ${detalhe}`);
    return Response.json(
      { error: `O GitHub recusou o disparo (HTTP ${resposta.status}). ${detalhe}` },
      { status: 502 },
    );
  }

  console.log(`[publicar] workflow disparado para ${data} · ${modo} · ${duracao}s`);
  return Response.json({
    ok: true,
    data,
    modo,
    duracao,
    acompanhar: `https://github.com/${REPO}/actions/workflows/${WORKFLOW}`,
  });
}
