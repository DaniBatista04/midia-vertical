import { timingSafeEqual } from "node:crypto";

import type { NextRequest } from "next/server";

import { dataEmSaoPaulo } from "@/lib/kuma/agendar";
import {
  avancarNoticia,
  descreverPasso,
  rodarRodizio,
  type PassoNoticia,
  type PassoRodizio,
} from "@/lib/kuma/publicarNoticia";
import { PREFIXO_NOTICIAS, type EstadoNoticia } from "@/lib/kuma/noticiaEstado";
import { lerJson, listar } from "@/lib/server/supabaseUpload";
import { SESSION_COOKIE, verifySession } from "@/lib/server/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * Empurra os envios de notícia, um passo por vez.
 *
 * O clima tem um cron que decide sozinho o que gerar; este aqui **não decide
 * nada** — ele só continua o que alguém já começou no painel. É a diferença que
 * a operação pediu: a notícia é escolhida por gente, e a automação cuida da
 * burocracia depois do clique.
 *
 * Cada execução varre os envios abertos e avança cada um em um passo. Um envio
 * que não tem o que fazer (propagando, esperando aprovação) sai em silêncio, e
 * um que terminou deixa de aparecer na varredura.
 *
 * Autenticação igual à do clima: Bearer do cron, token no link, ou sessão.
 */

type Origem = "cron" | "link" | "painel";

function segredoConfere(recebido: string, esperado: string | undefined): boolean {
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

/**
 * Base pública de onde o Kuma baixa os materiais default do 19".
 *
 * **Não** pode ser a origem da requisição. O cron da Vercel chama esta rota pela
 * URL do deploy (`*.vercel.app`), que está sob Deployment Protection: um GET nos
 * assets responde 302 para `vercel.com/sso-api`. O Kuma baixa o material pela URL
 * do `iurl`, então ele recebe uma página de login em vez de JPG — e a auditoria
 * reprova o grupo inteiro com 502 e feedback vazio, sem dizer qual dos cinco
 * materiais falhou. Foi o que aconteceu com o envio `2026-08-20-01`, o primeiro a
 * atravessar o cron: os dois JPGs da notícia estavam certos, no Supabase, e o
 * que o Kuma não conseguiu baixar foram os defaults do 19".
 *
 * O clima nunca caiu nisso porque roda por script, com `APP_URL`/`ASSETS_URL`
 * apontando para o domínio público. Aqui as variáveis valem o mesmo. Sem elas, e
 * com a origem sendo a URL do deploy, é melhor falhar: submeter material que
 * ninguém consegue baixar queima o nome do grupo criativo, e o reenvio precisa de
 * um índice novo.
 */
function basePublica(req: NextRequest): string {
  const configurada = (process.env.ASSETS_URL ?? process.env.APP_URL ?? "").trim();
  if (configurada) return configurada.replace(/\/+$/, "");

  const daRequisicao = req.nextUrl.origin;
  if (new URL(daRequisicao).hostname.endsWith(".vercel.app")) {
    throw new Error(
      "APP_URL não configurada — a URL do deploy é protegida e o Kuma não " +
        'baixaria os materiais default do 19".',
    );
  }
  return daRequisicao;
}

/** Envio que já está no ar ou parado não precisa de mais nenhuma volta. */
function terminado(e: EstadoNoticia): boolean {
  return Boolean(e.unidadeId) || Boolean(e.erro);
}

export async function GET(req: NextRequest) {
  const origem = await autorizar(req);
  if (!origem) return Response.json({ error: "Não autenticado" }, { status: 401 });

  const log = (m: string) => console.log(`[noticia/${origem}] ${m}`);

  let baseUrl: string;
  try {
    baseUrl = basePublica(req);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`[noticia/${origem}] ${msg}`);
    return Response.json({ ok: false, error: msg }, { status: 500 });
  }

  let caminhos: string[];
  try {
    caminhos = await listar(PREFIXO_NOTICIAS);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`[noticia/${origem}] falha ao listar envios: ${msg}`);
    return Response.json({ ok: false, error: msg }, { status: 500 });
  }

  const passos: PassoNoticia[] = [];
  const falhas: { id: string; erro: string }[] = [];

  for (const caminho of caminhos) {
    const estado = await lerJson<EstadoNoticia>(caminho);
    if (!estado || terminado(estado)) continue;
    try {
      const passo = await avancarNoticia(estado, { baseUrl, log });
      passos.push(passo);
      log(descreverPasso(passo));
    } catch (e) {
      // Um envio com problema não pode impedir os outros de andar.
      const erro = e instanceof Error ? e.message : String(e);
      console.error(`[noticia/${origem}] ${estado.id} falhou: ${erro}`);
      falhas.push({ id: estado.id, erro });
    }
  }

  /*
   * O rodízio do dia, depois dos envios.
   *
   * Ele não pertence a envio nenhum: a estratégia da unidade carrega um grupo
   * criativo por vez — senão as notícias tocam emendadas e o bloco de 10s cresce
   * com a quantidade delas — e alguém precisa passar a vez ao longo do dia.
   * Envio que já está no ar é `terminado` e sai da varredura acima, então sem
   * este passo a primeira notícia do dia ficaria com o ar até a meia-noite.
   *
   * Só o plano de hoje é revezado. O de ontem tem `startDate` e `endDate` na
   * data dele e já não exibe nada — trocar a estratégia de um pedido encerrado
   * seria chamada à toa.
   */
  let rodizio: PassoRodizio | null = null;
  try {
    rodizio = await rodarRodizio(dataEmSaoPaulo(0), { log });
  } catch (e) {
    const erro = e instanceof Error ? e.message : String(e);
    console.error(`[noticia/${origem}] rodízio falhou: ${erro}`);
    falhas.push({ id: `rodizio ${dataEmSaoPaulo(0)}`, erro });
  }

  const corpo = {
    ok: falhas.length === 0,
    abertos: passos.length,
    passos,
    ...(rodizio ? { rodizio } : {}),
    ...(falhas.length ? { falhas } : {}),
  };
  return Response.json(corpo, { status: falhas.length ? 500 : 200 });
}

export const POST = GET;

/** `HEAD` não faz nada — ver a nota no `/api/clima/agendar`. */
export function HEAD() {
  return new Response(null, { status: 204 });
}
