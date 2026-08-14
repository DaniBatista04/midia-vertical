import { jsonError } from "@/lib/server/guards";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Previsão da HG Brasil.
 *
 * A chave vive só em HG_BRASIL_KEY, nunca no código — este repositório é
 * público, e chave commitada é chave vazada. Sem a variável a rota falha
 * de forma explícita, em vez de silenciosamente devolver dado degradado.
 */
function hgKey(): string | null {
  // Trata string vazia como ausente: no .env a variável costuma existir sem valor.
  return process.env.HG_BRASIL_KEY?.trim() || null;
}

export async function GET(req: Request) {
  const params = new URL(req.url).searchParams;
  const woeid = params.get("woeid")?.trim();
  const hourly = params.get("hourly") === "true";

  if (!woeid) return jsonError(400, "Falta o parâmetro ?woeid=");
  if (!/^\d+$/.test(woeid)) return jsonError(400, "WOEID deve ser numérico");

  const key = hgKey();
  if (!key) {
    return jsonError(503, "HG_BRASIL_KEY não configurada no servidor.");
  }

  const url = new URL("https://api.hgbrasil.com/weather");
  url.searchParams.set("key", key);
  url.searchParams.set("woeid", woeid);
  if (hourly) url.searchParams.set("hourly", "true");

  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(15_000),
      cache: "no-store",
    });
    const data = await res.json();
    return Response.json(data, {
      status: res.ok ? 200 : res.status,
      headers: { "Cache-Control": "no-store" },
    });
  } catch (e) {
    return jsonError(502, e instanceof Error ? e.message : "Erro ao buscar a previsão");
  }
}
