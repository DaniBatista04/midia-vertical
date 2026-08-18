import type { NextRequest } from "next/server";

import { dataEmSaoPaulo } from "@/lib/kuma/agendar";
import { nomeMaterialNoticia } from "@/lib/kuma/newsGroup";
import { caminhoNoticia, idNoticia, type EstadoNoticia } from "@/lib/kuma/noticiaEstado";
import { lerJson, uploadPublico } from "@/lib/server/supabaseUpload";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

/**
 * Recebe a notícia escolhida no painel e a coloca na esteira.
 *
 * Diferente do clima, aqui **nada** roda sozinho: a notícia é escolhida por uma
 * pessoa, e é o clique dela que cria o envio. Esta rota faz só a parte que
 * precisa acontecer na hora — guardar os JPGs e registrar o envio — e devolve
 * o controle. A submissão ao Kuma vem depois, pelo cron, porque entre hospedar
 * e submeter existe uma folga de propagação de dez minutos que ninguém deve
 * ficar esperando de tela aberta.
 *
 * Os JPGs chegam pelo corpo da requisição, em base64, e isso é viável
 * justamente porque notícia é imagem: o spec do Kuma limita JPG a 2 MB, então
 * os dois formatos juntos cabem folgados. É o que dispensa Chromium, ffmpeg e
 * runner de CI — o arquivo que o operador vê na tela é o mesmo que sobe.
 */

type Corpo = {
  titulo?: string;
  /** Data de veiculação `YYYY-MM-DD`. Sem ela, hoje. */
  data?: string;
  duracao?: number;
  /** JPG 1080×1920, em base64 sem prefixo. */
  imagem32?: string;
  /** JPG 1080×2560, em base64 sem prefixo. */
  imagem25?: string;
};

/** Teto por imagem. O spec do Kuma recusa JPG de 2 MB ou mais. */
const MAX_BYTES = 2 * 1024 * 1024;

/**
 * Próximo índice livre do dia.
 *
 * O índice separa as notícias de um mesmo dia e entra no nome do arquivo — e
 * nome repetido entre requisições é reprovado pelo Kuma com 502 e feedback
 * vazio. Procurar o primeiro id livre é o que garante que dois envios no mesmo
 * dia não colidam.
 */
async function proximoIndice(dataISO: string): Promise<number> {
  for (let i = 1; i <= 50; i++) {
    const existe = await lerJson<EstadoNoticia>(caminhoNoticia(idNoticia(dataISO, i)));
    if (!existe) return i;
  }
  throw new Error(`já existem 50 envios para ${dataISO} — algo está errado`);
}

export async function POST(req: NextRequest) {
  let corpo: Corpo;
  try {
    corpo = (await req.json()) as Corpo;
  } catch {
    return Response.json({ error: "Requisição inválida." }, { status: 400 });
  }

  const titulo = String(corpo.titulo ?? "").trim();
  if (!titulo) return Response.json({ error: "Falta o título da notícia." }, { status: 400 });

  const data = corpo.data ?? dataEmSaoPaulo(0);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(data)) {
    return Response.json({ error: "Data inválida — use YYYY-MM-DD." }, { status: 400 });
  }

  const duracao = Number(corpo.duracao ?? 10);
  if (!Number.isInteger(duracao) || duracao < 10 || duracao % 5 !== 0) {
    // Medido contra a API: múltiplo de 5 com mínimo 10, e não o múltiplo de 15
    // que o PDF da Brato diz.
    return Response.json(
      { error: `Duração inválida: ${duracao} — múltiplo de 5, mínimo 10.` },
      { status: 400 },
    );
  }

  const imagens = [corpo.imagem32, corpo.imagem25];
  if (imagens.some((i) => !i)) {
    return Response.json({ error: "Faltam as imagens dos dois formatos." }, { status: 400 });
  }

  const buffers = imagens.map((b64) => Buffer.from(String(b64), "base64"));
  for (const [i, buf] of buffers.entries()) {
    if (!buf.byteLength) {
      return Response.json({ error: `Imagem ${i + 1} veio vazia.` }, { status: 400 });
    }
    if (buf.byteLength >= MAX_BYTES) {
      return Response.json(
        {
          error:
            `Imagem ${i + 1} tem ${(buf.byteLength / 1024 / 1024).toFixed(2)} MB — ` +
            "o Kuma recusa JPG de 2 MB ou mais.",
        },
        { status: 413 },
      );
    }
  }

  const indice = await proximoIndice(data);
  const quando = new Date(`${data}T00:00:00`);
  const tamanhos = ["32", "25"] as const;

  const materiais: string[] = [];
  for (const [i, buf] of buffers.entries()) {
    const nome = `${nomeMaterialNoticia(quando, tamanhos[i], indice, duracao)}.jpg`;
    materiais.push(
      await uploadPublico({
        caminho: `noticias/${nome}`,
        conteudo: buf,
        contentType: "image/jpeg",
      }),
    );
  }

  const estado: EstadoNoticia = {
    id: idNoticia(data, indice),
    titulo,
    data,
    indice,
    duracao,
    hospedadoEm: new Date().toISOString(),
    materiais,
  };
  await uploadPublico({
    caminho: caminhoNoticia(estado.id),
    conteudo: Buffer.from(JSON.stringify(estado, null, 2)),
    contentType: "application/json",
  });

  console.log(`[noticia] envio ${estado.id} hospedado — "${titulo}"`);
  return Response.json({
    ok: true,
    id: estado.id,
    indice,
    data,
    materiais,
    mensagem:
      "Material hospedado. O grupo criativo é submetido em cerca de 10 minutos, " +
      "e depois aparece na Análise Criativa para aprovação.",
  });
}
