import { ALLOWED_FEED_HOSTS, JSON_HOSTS, checkTarget, jsonError } from "@/lib/server/guards";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Repassa o RSS (ou JSON) do feed, contornando o CORS do publisher. */
export async function GET(req: Request) {
  const target = new URL(req.url).searchParams.get("url");
  if (!target) return jsonError(400, "Falta o parâmetro ?url=");

  const bad = checkTarget(target);
  if (bad) return jsonError(400, bad);

  const host = new URL(target).hostname;
  if (!ALLOWED_FEED_HOSTS.includes(host)) {
    return jsonError(403, `Host não permitido: ${host}`, {
      dica: `Adicione em ALLOWED_FEED_HOSTS. Liberados: ${ALLOWED_FEED_HOSTS.join(", ")}`,
    });
  }

  try {
    const res = await fetch(target, {
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; MidiaVerticalBot/1.0)",
        Accept: "application/rss+xml, application/xml, text/xml, application/json, */*",
      },
      signal: AbortSignal.timeout(15_000),
      cache: "no-store",
    });
    const body = await res.text();
    return new Response(body, {
      status: res.status,
      headers: {
        "Content-Type": JSON_HOSTS.includes(host)
          ? "application/json; charset=utf-8"
          : "application/xml; charset=utf-8",
        "Cache-Control": "no-store",
      },
    });
  } catch (e) {
    return jsonError(502, e instanceof Error ? e.message : "Erro ao buscar o feed");
  }
}
