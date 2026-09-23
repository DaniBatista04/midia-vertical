import type { NextRequest } from "next/server";

import { retirarNoticia } from "@/lib/kuma/publicarNoticia";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Tira uma notícia do pack, pelo painel. Ver `retirarNoticia`.
 *
 * Só com sessão: a rota não está nas públicas do `proxy.ts`.
 */
export async function POST(req: NextRequest) {
  let id: string;
  try {
    id = String(((await req.json()) as { id?: unknown }).id ?? "");
  } catch {
    return Response.json({ error: "Requisição inválida." }, { status: 400 });
  }
  if (!/^\d{4}-\d{2}-\d{2}-\d{2}$/.test(id)) {
    return Response.json({ error: `Envio inválido: ${id}.` }, { status: 400 });
  }

  try {
    const r = await retirarNoticia(id, { log: (m) => console.log(`[noticia/retirar] ${m}`) });
    if (r.estado === "recusada") return Response.json({ error: r.motivo }, { status: r.status });
    return Response.json({ ok: true, ...r });
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
