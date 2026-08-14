import net from "node:net";

/**
 * Guardas de SSRF e allowlist herdadas do proxy-server.js original.
 *
 * As rotas /api/feed e /api/image aceitam uma URL vinda do cliente, então
 * precisam recusar alvos internos antes de sair buscando qualquer coisa.
 */

/** Hosts liberados para /api/feed. */
export const ALLOWED_FEED_HOSTS = [
  "api.appnewsdelivery.net",
  "api.hgbrasil.com",
];

/** Hosts que devolvem JSON em vez de XML. */
export const JSON_HOSTS = ["api.hgbrasil.com"];

/** Bloqueia loopback, redes privadas e nomes internos. */
export function isPrivateTarget(hostname: string | null): boolean {
  if (!hostname) return true;
  const h = hostname.toLowerCase();
  if (
    h === "localhost" ||
    h.endsWith(".localhost") ||
    h.endsWith(".internal") ||
    h.endsWith(".local")
  ) {
    return true;
  }
  if (net.isIP(h) === 4) {
    const [a, b] = h.split(".").map(Number);
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127)
    );
  }
  if (net.isIP(h) === 6) {
    return h === "::1" || h.startsWith("fc") || h.startsWith("fd") || h.startsWith("fe80");
  }
  return false;
}

/** Retorna a mensagem de erro, ou null quando o alvo é aceitável. */
export function checkTarget(target: string): string | null {
  let p: URL;
  try {
    p = new URL(target);
  } catch {
    return "URL inválida";
  }
  if (p.protocol !== "http:" && p.protocol !== "https:") {
    return `Protocolo não permitido: ${p.protocol}`;
  }
  if (isPrivateTarget(p.hostname)) {
    return `Host interno não permitido: ${p.hostname}`;
  }
  return null;
}

export function jsonError(status: number, error: string, extra?: Record<string, unknown>) {
  return Response.json({ error, ...extra }, { status });
}
