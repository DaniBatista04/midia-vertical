import type { NextRequest } from "next/server";

import { cancelarPlanoDuplicado } from "@/lib/kuma/publicarNoticia";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Cancela um plano a mais do dia e devolve as notícias dele ao plano do
 * registro. Ver `cancelarPlanoDuplicado`.
 *
 *   POST { data: "2026-10-02", unidadeId: "101149_60323" }
 *
 * Só com sessão: a rota não está nas públicas do `proxy.ts`.
 */
export async function POST(req: NextRequest) {
  let data = "";
  let unidadeId = "";
  try {
    ({ data = "", unidadeId = "" } = (await req.json()) as { data?: string; unidadeId?: string });
  } catch {
    return Response.json({ error: "Requisição inválida." }, { status: 400 });
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(data)) {
    return Response.json({ error: `Data inválida: ${data}.` }, { status: 400 });
  }
  if (!/^\d+_\d+$/.test(unidadeId)) {
    return Response.json({ error: `Plano inválido: ${unidadeId}.` }, { status: 400 });
  }

  try {
    const r = await cancelarPlanoDuplicado(data, unidadeId, {
      log: (m) => console.log(`[noticia/plano] ${m}`),
    });
    return Response.json({ ok: true, ...r });
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
