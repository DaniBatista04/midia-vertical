import { NextResponse, type NextRequest } from "next/server";

import { SESSION_COOKIE, verifySession } from "@/lib/server/session";

/**
 * Portão de acesso do painel.
 *
 * Tudo passa por aqui — inclusive /api/feed, /api/image e /api/weather. Era
 * esse o buraco da versão anterior: as rotas de proxy ficavam abertas para
 * qualquer um assim que o app subisse.
 */

/**
 * Rotas que precisam responder sem sessão.
 *
 * `/api/clima/agendar` está aqui porque quem a chama não tem cookie: o cron da
 * Vercel manda `Authorization: Bearer`, e a pessoa que acabou de aprovar o
 * criativo clica num favorito com token na URL, de dentro do portal do Kuma.
 * Ela **não** fica aberta: a própria rota confere os três caminhos de
 * autenticação e responde 401 sem nenhum deles.
 *
 * `/api/clima/publicar` entrou pelo mesmo motivo, quando o cron das 23h saiu do
 * `schedule:` do GitHub Actions e veio para cá. Também não fica aberta: o `GET`
 * exige `CRON_SECRET` e o `POST` do painel confere a sessão por conta própria.
 */
const PUBLIC_PATHS = new Set([
  "/login",
  "/api/login",
  "/api/logout",
  "/api/health",
  "/api/clima/agendar",
  "/api/clima/publicar",
  "/api/noticias/agendar",
]);

export async function proxy(req: NextRequest) {
  const { pathname } = req.nextUrl;

  if (PUBLIC_PATHS.has(pathname)) return NextResponse.next();

  if (await verifySession(req.cookies.get(SESSION_COOKIE)?.value)) {
    return NextResponse.next();
  }

  // API responde 401; página redireciona para o login guardando o destino.
  if (pathname.startsWith("/api/")) {
    return NextResponse.json({ error: "Não autenticado" }, { status: 401 });
  }

  const url = req.nextUrl.clone();
  url.pathname = "/login";
  url.search = "";
  if (pathname !== "/") url.searchParams.set("next", pathname);
  return NextResponse.redirect(url);
}

export const config = {
  matcher: [
    /*
     * Tudo, menos os internos do Next e os arquivos estáticos que a própria
     * tela de login precisa carregar (fontes, máscaras, logo).
     */
    "/((?!_next/static|_next/image|favicon.ico|fonts/|assets/|.*\\.(?:png|jpe?g|svg|ico|woff2?)$).*)",
  ],
};
