/**
 * Sessão do painel — cookie assinado com HMAC-SHA256.
 *
 * O painel tem uma senha única, compartilhada pela equipe de operação. Não há
 * cadastro nem usuário individual: o cookie carrega apenas a data de expiração
 * e a assinatura, então nada além do segredo permite forjá-lo.
 *
 * Só usa Web Crypto, para rodar tanto no proxy quanto nas rotas de API.
 */

export const SESSION_COOKIE = "mv_session";

/** Sessão de 12 horas — cobre um turno sem obrigar login a cada aba. */
export const SESSION_TTL_SECONDS = 12 * 60 * 60;

function secret(): string {
  const s = process.env.AUTH_SECRET;
  if (!s) {
    throw new Error(
      "AUTH_SECRET não configurado. Gere um com `openssl rand -hex 32` e coloque no .env.local.",
    );
  }
  return s;
}

/** Senha do painel. Retorna null quando não está configurada. */
export function appPassword(): string | null {
  return process.env.APP_PASSWORD || null;
}

function b64url(bytes: ArrayBuffer): string {
  const bin = String.fromCharCode(...new Uint8Array(bytes));
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function hmac(message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret()),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return b64url(sig);
}

/** Comparação em tempo constante, para não vazar o segredo pelo tempo de resposta. */
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Cria o token da sessão, válido por SESSION_TTL_SECONDS. */
export async function createSession(): Promise<string> {
  const exp = Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS;
  return `${exp}.${await hmac(String(exp))}`;
}

/** Valida assinatura e expiração. */
export async function verifySession(token: string | undefined | null): Promise<boolean> {
  if (!token) return false;
  const dot = token.indexOf(".");
  if (dot < 1) return false;

  const exp = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  if (!/^\d+$/.test(exp)) return false;
  if (Number(exp) * 1000 <= Date.now()) return false;

  try {
    return safeEqual(sig, await hmac(exp));
  } catch {
    // AUTH_SECRET ausente: trata como não autenticado em vez de derrubar o proxy.
    return false;
  }
}
