import type { NextRequest } from "next/server";

import { dataEmSaoPaulo, FREQUENCIA_PADRAO } from "@/lib/kuma/agendar";
import {
  caminhoGrade,
  cortesValidos,
  MAX_CAIXAS,
  vagasPorCaixa,
  type GradeNoticias,
} from "@/lib/kuma/noticiaCaixas";
import { nomeMaterialNoticia } from "@/lib/kuma/newsGroup";
import { caminhoNoticia, idNoticia, type EstadoNoticia } from "@/lib/kuma/noticiaEstado";
import { enviosDoDia } from "@/lib/kuma/publicarNoticia";
import { uploadPublico } from "@/lib/server/supabaseUpload";

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
 *
 * O que esta rota recusa, e antes não recusava, é o envio que não caberia no
 * plano do dia: as notícias de uma data dividem **uma** unidade, e ela tem um
 * número fixo de vagas e uma duração só. Recusar aqui é o único momento em que
 * a recusa é barata — depois do upload o índice já foi gasto, e índice gasto não
 * volta (nome de material repetido é reprovado com 502 e feedback vazio).
 */

type Corpo = {
  titulo?: string;
  /** Data de veiculação `YYYY-MM-DD`. Sem ela, hoje. */
  data?: string;
  duracao?: number;
  /** Caixa do dia em que a notícia entra, a partir de 1. Sem ela, a 1. */
  caixa?: number;
  /**
   * Horários de troca entre as caixas, como o painel mostra — `[16]` são duas
   * caixas trocando às 16h. Opcional: sem ele vale a divisão padrão.
   */
  cortes?: number[];
  /** JPG 1080×1920, em base64 sem prefixo. */
  imagem32?: string;
  /** JPG 1080×2560, em base64 sem prefixo. */
  imagem25?: string;
};

/** Teto por imagem. O spec do Kuma recusa JPG de 2 MB ou mais. */
const MAX_BYTES = 2 * 1024 * 1024;

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

  const caixa = Number(corpo.caixa ?? 1);
  if (!Number.isInteger(caixa) || caixa < 1 || caixa > MAX_CAIXAS) {
    return Response.json(
      { error: `Pack inválido: ${corpo.caixa} — de 1 a ${MAX_CAIXAS}.` },
      { status: 400 },
    );
  }
  if (corpo.cortes !== undefined) {
    const n = Array.isArray(corpo.cortes) ? corpo.cortes.length + 1 : 0;
    if (!cortesValidos(corpo.cortes, n) || caixa > n) {
      return Response.json(
        { error: `Horários dos packs inválidos: ${JSON.stringify(corpo.cortes)}.` },
        { status: 400 },
      );
    }
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

  const { envios, indice } = await enviosDoDia(data);

  /*
   * As notícias do dia dividem uma unidade só, em caixas: a estratégia carrega
   * uma caixa por vez, e são quatro vagas nela com as 240 exibições/dia da
   * operação — o Kuma reparte as exibições entre as notícias da caixa, uma por
   * exibição (ver `noticiaPlano.ts` e `noticiaCaixas.ts`). Mais notícias numa
   * caixa significaria menos tempo de tela para cada uma, não bloco maior; mais
   * notícias no dia vão para outra caixa. Envio parado por erro não ocupa vaga:
   * o grupo dele nunca foi amarrado.
   */
  const frequencia = Number(process.env.KUMA_CLIMA_FREQUENCIA ?? FREQUENCIA_PADRAO);
  const vagas = vagasPorCaixa(frequencia);
  const naEsteira = envios.filter((e) => !e.erro);
  const naCaixa = naEsteira.filter((e) => (e.caixa ?? 1) === caixa).length;
  if (naCaixa >= vagas) {
    return Response.json(
      {
        error:
          `O pack ${caixa} de ${data} já tem ${naCaixa} notícia(s) — é o máximo que ` +
          `${frequencia} exibições/dia comporta num pack. Use outro pack.`,
      },
      { status: 409 },
    );
  }

  /*
   * `durationInSecond` é campo da unidade, não da notícia: uma duração
   * diferente não caberia no plano do dia, e a recusa depois da aprovação
   * custaria o índice e a passagem pela Análise Criativa.
   */
  const duracaoDoDia = naEsteira[0]?.duracao;
  if (duracaoDoDia !== undefined && duracaoDoDia !== duracao) {
    return Response.json(
      {
        error:
          `As notícias de ${data} veiculam em ${duracaoDoDia}s, e esta é de ${duracao}s — ` +
          "a duração é da unidade, então o dia inteiro usa a mesma.",
      },
      { status: 409 },
    );
  }

  // A grade é do dia, não do envio: cada envio do lote traz a mesma, e a última
  // gravada vale. Grava antes do upload para que um lote interrompido no meio
  // não deixe as caixas já enviadas com o horário antigo.
  if (corpo.cortes) {
    const grade: GradeNoticias = { data, cortes: corpo.cortes, atualizadoEm: new Date().toISOString() };
    await uploadPublico({
      caminho: caminhoGrade(data),
      conteudo: Buffer.from(JSON.stringify(grade, null, 2)),
      contentType: "application/json",
    });
  }

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
    caixa,
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
    caixa,
    materiais,
    mensagem:
      "Material hospedado. O grupo criativo é submetido em cerca de 10 minutos, " +
      "e depois aparece na Análise Criativa para aprovação.",
  });
}
