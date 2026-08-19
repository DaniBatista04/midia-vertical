import { timingSafeEqual } from "node:crypto";

import type { NextRequest } from "next/server";

import { dataEmSaoPaulo } from "@/lib/kuma/agendar";
import { SESSION_COOKIE, verifySession } from "@/lib/server/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Dispara a fase 1 do clima — pelo cron das 23h ou pelo operador, na hora.
 *
 * **Por que isto chama o GitHub Actions em vez de fazer o trabalho aqui.** A
 * fase 1 renderiza 250 frames em dois formatos com Chromium, re-embala com
 * ffmpeg e espera dez minutos para o material propagar antes de submeter. Nada
 * disso cabe numa rota da Vercel: não há Chromium, e os dois MP4 juntos passam
 * do limite de corpo de requisição. Refazer o pipeline aqui seria uma segunda
 * implementação para divergir da primeira no próximo ajuste de layout — então a
 * rota apenas aciona o workflow, com a data que o operador escolheu ou com a de
 * amanhã, quando quem chama é o cron.
 *
 * **Por que o cron das 23h mora aqui e não no `schedule:` do Actions.** O cron
 * do GitHub não é um horário, é uma fila compartilhada: ele atrasa o quanto o
 * GitHub quiser, e o atraso é fatal aqui. A previsão horária da HG é uma janela
 * móvel de 24h a partir de agora, então disparando 01h da manhã ela não alcança
 * mais o fim do dia seguinte e o job **recusa** gerar — foi o que aconteceu em
 * 19/08/2026, com 2h10 de atraso e nenhum card no ar. Um agendador pontual
 * chamando `workflow_dispatch` mantém as 23h de pé.
 *
 * O `GET` é o gatilho automático e se autentica por `CRON_SECRET`, que a
 * Vercel injeta como `Authorization: Bearer` nos crons dela. Qualquer outro
 * agendador que saiba mandar esse cabeçalho serve igual — n8n, cron-job.org,
 * uma máquina qualquer com `curl`. A escolha do agendador não está presa nesta
 * rota.
 *
 * **O que ela não faz:** criar a unidade. O criativo precisa estar aprovado para
 * receber estratégia, e aprovar é manual no portal. Depois da aprovação, o cron
 * de minuto cria plano e unidade e amarra sozinho — ou o operador clica o link.
 *
 * A rota está na lista de públicas do `src/proxy.ts` porque o cron não tem
 * cookie. Ela **não** fica aberta: o `GET` exige o segredo e o `POST` confere a
 * sessão do painel por conta própria.
 */

/** `owner/repo` de onde o workflow roda. */
const REPO = process.env.GITHUB_REPO ?? "DaniBatista04/midia-vertical";
const WORKFLOW = "clima-diario.yml";

type Corpo = {
  /** `YYYY-MM-DD`, decidida no cliente a partir da previsão que ele já buscou. */
  data?: string;
  duracao?: number;
  modo?: "dia" | "semana";
  /**
   * Dispara o workflow em modo de ensaio: ele monta o payload e para, sem
   * renderizar nem submeter nada ao Kuma.
   *
   * Serve para provar a ligação inteira — token, permissão de Actions, nome do
   * workflow, formato das entradas — sem gastar vinte minutos de runner nem
   * deixar grupo criativo para alguém aprovar. Não aparece na tela: é caminho
   * de quem está verificando a instalação.
   */
  dryRun?: boolean;
};

type Pedido = {
  data: string;
  modo: "dia" | "semana";
  duracao: number;
  dryRun: boolean;
};

function segredoConfere(recebido: string, esperado: string | undefined): boolean {
  // Segredo não configurado nunca vira "qualquer um passa".
  if (!esperado) return false;
  const a = Buffer.from(recebido, "utf8");
  const b = Buffer.from(esperado, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * Guarda contra data digitada errado: a automação só faz sentido para hoje ou
 * os próximos dois dias, e a previsão horária nem alcança mais que isso.
 *
 * A comparação é contra as datas **de São Paulo**, não contra `new Date()` do
 * servidor. A Vercel roda em UTC, e às 23h de Brasília o relógio dela já virou
 * o dia — a conta local diria que amanhã é depois de amanhã e recusaria
 * justamente o disparo do cron.
 */
function dataForaDoAlcance(data: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(data)) return "Data inválida — use YYYY-MM-DD.";
  const alcance = [dataEmSaoPaulo(0), dataEmSaoPaulo(1), dataEmSaoPaulo(2)];
  if (!alcance.includes(data)) {
    return `Data fora do alcance: ${data} — só hoje ou os dois dias seguintes.`;
  }
  return null;
}

async function disparar(pedido: Pedido, origem: "cron" | "painel"): Promise<Response> {
  const { data, modo, duracao, dryRun } = pedido;

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
          dry_run: dryRun ? "true" : "false",
        },
      }),
    },
  );

  if (!resposta.ok) {
    const detalhe = (await resposta.text()).slice(0, 300);
    console.error(`[publicar/${origem}] GitHub recusou (${resposta.status}): ${detalhe}`);
    return Response.json(
      { error: `O GitHub recusou o disparo (HTTP ${resposta.status}). ${detalhe}` },
      { status: 502 },
    );
  }

  console.log(
    `[publicar/${origem}] workflow disparado para ${data} · ${modo} · ${duracao}s` +
      (dryRun ? " · ensaio (não envia nada)" : ""),
  );
  return Response.json({
    ok: true,
    origem,
    data,
    modo,
    duracao,
    dryRun,
    acompanhar: `https://github.com/${REPO}/actions/workflows/${WORKFLOW}`,
  });
}

/**
 * O gatilho das 23h.
 *
 * Sem parâmetro nenhum de propósito: o cron sempre quer a mesma coisa — o card
 * do dia seguinte, no formato que vai às telas. Data vinda de fora aqui só
 * serviria para alguém com o segredo errar o dia.
 */
export async function GET(req: NextRequest) {
  const auth = req.headers.get("authorization") ?? "";
  const autorizado =
    auth.startsWith("Bearer ") && segredoConfere(auth.slice(7), process.env.CRON_SECRET);
  if (!autorizado) {
    return Response.json({ error: "Não autenticado" }, { status: 401 });
  }

  return disparar(
    { data: dataEmSaoPaulo(1), modo: "dia", duracao: 10, dryRun: false },
    "cron",
  );
}

export async function POST(req: NextRequest) {
  // A rota é pública no proxy por causa do cron, então a sessão é conferida
  // aqui — sem isto, o disparo manual ficaria aberto para qualquer um.
  if (!(await verifySession(req.cookies.get(SESSION_COOKIE)?.value))) {
    return Response.json({ error: "Não autenticado" }, { status: 401 });
  }

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
  const problema = dataForaDoAlcance(data);
  if (problema) return Response.json({ error: problema }, { status: 400 });

  return disparar(
    {
      data,
      modo: corpo.modo === "semana" ? "semana" : "dia",
      duracao: Number(corpo.duracao ?? 10),
      dryRun: Boolean(corpo.dryRun),
    },
    "painel",
  );
}
