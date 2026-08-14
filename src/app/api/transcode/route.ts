import { MAX_UPLOAD_BYTES, TranscodeError, toKumaHevc } from "@/lib/server/transcode";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
/** libx265 em software é lento; 1080×2560 de 30s precisa de folga. */
export const maxDuration = 300;

/**
 * Recebe o MP4 gerado no browser e devolve a versão H.265 do jeito que o Kuma
 * aceita. Só é chamada quando a máquina do operador não tem encoder HEVC.
 */
export async function POST(req: Request) {
  const body = new Uint8Array(await req.arrayBuffer());

  if (body.byteLength === 0) {
    return Response.json({ error: "Corpo vazio." }, { status: 400 });
  }
  if (body.byteLength > MAX_UPLOAD_BYTES) {
    return Response.json({ error: "Arquivo grande demais." }, { status: 413 });
  }
  // Todo MP4 começa com um box `ftyp` — o tamanho ocupa os 4 primeiros bytes.
  const magic = String.fromCharCode(...body.subarray(4, 8));
  if (magic !== "ftyp") {
    return Response.json({ error: "Arquivo não parece um MP4." }, { status: 415 });
  }

  try {
    const out = await toKumaHevc(body);
    // Copia para um ArrayBuffer puro: o Uint8Array do Node vem com
    // ArrayBufferLike, que não satisfaz o BodyInit da Response.
    const payload = out.buffer.slice(
      out.byteOffset,
      out.byteOffset + out.byteLength,
    ) as ArrayBuffer;
    return new Response(payload, {
      status: 200,
      headers: {
        "Content-Type": "video/mp4",
        "Content-Length": String(out.byteLength),
        "Cache-Control": "no-store",
      },
    });
  } catch (e) {
    if (e instanceof TranscodeError) {
      console.error("[transcode]", e.message, e.detail ?? "");
      return Response.json({ error: e.message }, { status: 502 });
    }
    console.error("[transcode] erro inesperado", e);
    return Response.json({ error: "Falha ao converter." }, { status: 500 });
  }
}
