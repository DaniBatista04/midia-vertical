import type { NextRequest } from "next/server";

import { cidadesConfiguradas } from "@/lib/kuma/cidades";
import { getBuildings, kumaConfig } from "@/lib/kuma/client";
import { cancelarTeste, lerTeste, retomarTeste } from "@/lib/kuma/testeIgnoreLock";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
/** A busca de prédio pagina a cidade inteira. */
export const maxDuration = 120;

/**
 * O teste do `ignoreLock` pelo painel (ver `testeIgnoreLock.ts`). Só com sessão:
 * a rota não está nas públicas do `proxy.ts`.
 *
 *   GET  ?predio=<nome>              prédios da cidade que casam com o nome
 *   POST { id, acao: "ler" }         relê a unidade do teste (unit/get + inquire)
 *   POST { id, acao: "cancelar" }    cancela a unidade do teste
 *   POST { id, acao: "retomar" }     tira o erro, e o cron tenta de novo do passo que faltou
 */

/** Compara nome de prédio sem acento e sem caixa. */
function normalizar(s: string): string {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();
}

export async function GET(req: NextRequest) {
  const busca = req.nextUrl.searchParams.get("predio")?.trim() ?? "";
  if (busca.length < 3) {
    return Response.json({ error: "Digite ao menos 3 letras do nome do prédio." }, { status: 400 });
  }
  const conta = process.env.KUMA_BIDDER_NEWS?.trim();
  if (!conta) return Response.json({ error: "KUMA_BIDDER_NEWS não configurada." }, { status: 500 });
  try {
    const cidade = cidadesConfiguradas(process.env.KUMA_CLIMA_CIDADE)[0];
    const todos = await getBuildings(cidade, kumaConfig(conta));
    const alvo = normalizar(busca);
    const predios = todos.filter((p) => normalizar(p.buildingName).includes(alvo)).slice(0, 20);
    return Response.json({ cidade, predios });
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  let id = "";
  let acao = "";
  try {
    ({ id = "", acao = "" } = (await req.json()) as { id?: string; acao?: string });
  } catch {
    return Response.json({ error: "Requisição inválida." }, { status: 400 });
  }
  if (!/^\d{4}-\d{2}-\d{2}-\d{2}$/.test(id)) {
    return Response.json({ error: `Envio inválido: ${id}.` }, { status: 400 });
  }
  try {
    if (acao === "ler") return Response.json({ ok: true, estado: await lerTeste(id) });
    if (acao === "retomar") return Response.json({ ok: true, estado: await retomarTeste(id) });
    if (acao === "cancelar") return Response.json({ ok: true, estado: await cancelarTeste(id) });
    return Response.json({ error: `Ação desconhecida: ${acao}.` }, { status: 400 });
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
