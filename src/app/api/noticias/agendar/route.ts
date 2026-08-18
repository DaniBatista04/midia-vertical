import { timingSafeEqual } from "node:crypto";

import type { NextRequest } from "next/server";

import { avancarNoticia, descreverPasso, type PassoNoticia } from "@/lib/kuma/publicarNoticia";
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

/** Envio que já está no ar ou parado não precisa de mais nenhuma volta. */
function terminado(e: EstadoNoticia): boolean {
  return Boolean(e.unidadeId) || Boolean(e.erro);
}

export async function GET(req: NextRequest) {
  const origem = await autorizar(req);
  if (!origem) return Response.json({ error: "Não autenticado" }, { status: 401 });

  const log = (m: string) => console.log(`[noticia/${origem}] ${m}`);
  const baseUrl = req.nextUrl.origin;

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

  const corpo = {
    ok: falhas.length === 0,
    abertos: passos.length,
    passos,
    ...(falhas.length ? { falhas } : {}),
  };
  return Response.json(corpo, { status: falhas.length ? 500 : 200 });
}

export const POST = GET;

/** `HEAD` não faz nada — ver a nota no `/api/clima/agendar`. */
export function HEAD() {
  return new Response(null, { status: 204 });
}
