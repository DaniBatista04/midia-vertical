import { timingSafeEqual } from "node:crypto";

import {
  SESSION_COOKIE,
  SESSION_TTL_SECONDS,
  appPassword,
  createSession,
} from "@/lib/server/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Atraso fixo para não transformar a rota num oráculo de senha rápido. */
const THROTTLE_MS = 400;

function equal(a: string, b: string): boolean {
  const ba = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

export async function POST(req: Request) {
  const expected = appPassword();
  await new Promise((r) => setTimeout(r, THROTTLE_MS));

  if (!expected) {
    return Response.json(
      { error: "APP_PASSWORD não configurado no servidor." },
      { status: 503 },
    );
  }

  let password = "";
  try {
    password = String(((await req.json()) as { password?: unknown })?.password ?? "");
  } catch {
    return Response.json({ error: "Requisição inválida." }, { status: 400 });
  }

  if (!equal(password, expected)) {
    return Response.json({ error: "Senha incorreta." }, { status: 401 });
  }

  const res = Response.json({ ok: true });
  res.headers.append(
    "Set-Cookie",
    [
      `${SESSION_COOKIE}=${await createSession()}`,
      "Path=/",
      "HttpOnly",
      "SameSite=Lax",
      `Max-Age=${SESSION_TTL_SECONDS}`,
      process.env.NODE_ENV === "production" ? "Secure" : "",
    ]
      .filter(Boolean)
      .join("; "),
  );
  return res;
}
