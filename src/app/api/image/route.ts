import { checkTarget, jsonError } from "@/lib/server/guards";

export const runtime = "nodejs";

/**
 * Repassa a imagem do feed com CORS liberado.
 *
 * Sem isso o canvas fica "tainted" e o toBlob() do export quebra.
 */
export async function GET(req: Request) {
  const target = new URL(req.url).searchParams.get("url");
  if (!target) return jsonError(400, "Falta o parâmetro ?url=");

  const bad = checkTarget(target);
  if (bad) return jsonError(400, bad);

  try {
    const res = await fetch(target, {
      headers: { "User-Agent": "Mozilla/5.0", Accept: "image/*,*/*" },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok || !res.body) {
      return jsonError(502, `Origem respondeu HTTP ${res.status}`);
    }
    return new Response(res.body, {
      status: 200,
      headers: {
        "Content-Type": res.headers.get("content-type") ?? "image/jpeg",
        "Cache-Control": "public, max-age=3600",
        "Access-Control-Allow-Origin": "*",
        "Cross-Origin-Resource-Policy": "cross-origin",
      },
    });
  } catch (e) {
    return jsonError(502, e instanceof Error ? e.message : "Erro ao buscar a imagem");
  }
}
