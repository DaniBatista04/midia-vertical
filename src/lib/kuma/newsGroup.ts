/**
 * Grupo criativo de notícia — a versão em imagem do que `weatherGroup.ts` faz
 * para o clima.
 *
 * A estrutura é a mesma que a auditoria já aprova: cinco materiais cobrindo os
 * quatro device styles, todos com o mesmo índice e a mesma duração. O que muda
 * é o tipo: notícia é JPG do começo ao fim, então nem o 25" nem o 32" passam por
 * vídeo — e por isso nada aqui precisa de ffmpeg, de encoder ou de navegador
 * sem cabeça. O JPG que o operador vê na tela é o mesmo que sobe.
 *
 * O índice repetido entre os formatos é exigência da Brato: o material 1 do 25"
 * precisa corresponder ao material 1 do 32", senão o sistema deles não casa as
 * artes entre as telas.
 */

import { byteLength, KUMA_FILENAME_MAX_BYTES } from "./filename";
import type { KumaCreative, KumaCreativeGroupRequest, KumaMaterial } from "./client";
import { SMART19_DEFAULTS, dataCompacta } from "./weatherGroup";

export type NewsGroupInput = {
  /** Data de veiculação. */
  data: Date;
  /** Duração de exibição de cada material, em segundos. */
  duracao: number;
  /**
   * Índice do material. Diferente do clima, aqui ele separa **notícias** do
   * mesmo dia, além de servir para reenvio: nome de arquivo repetido entre
   * requisições é reprovado com 502 e feedback vazio, sem dizer o motivo.
   */
  indice: number;
  /** URL pública do JPG 1080×1920 (tela de 32"). */
  imagem32: string;
  /** URL pública do JPG 1080×2560 (tela de 25"). */
  imagem25: string;
  /** Base pública do app, para montar a URL dos materiais default do 19". */
  baseUrl: string;
};

export function nomeMaterialNoticia(
  data: Date,
  tamanho: "25" | "32" | "55" | "19" | "19P",
  indice: number,
  duracao: number,
): string {
  return `NEWS-${dataCompacta(data)}-${tamanho}-${indice}-${duracao}`;
}

export function nomeGrupoNoticia(data: Date, indice: number): string {
  return `NEWS-${dataCompacta(data)}-${indice}`;
}

function material(nome: string, url: string, duracao: number): KumaMaterial {
  const filename = `${nome}.jpg`;
  // O limite é do device, não da API: nome mais longo é aceito na submissão e
  // reprovado depois, na auditoria.
  if (byteLength(filename) > KUMA_FILENAME_MAX_BYTES) {
    throw new Error(
      `Nome de material passa de ${KUMA_FILENAME_MAX_BYTES} bytes: ${filename} (${byteLength(filename)})`,
    );
  }
  return { id: nome, iurl: url, filename, display: { duration: duracao, mime: "image/jpeg" } };
}

export function montarGrupoNoticia(input: NewsGroupInput): KumaCreativeGroupRequest {
  const { data, duracao, indice, imagem32, imagem25, baseUrl } = input;
  const base = baseUrl.replace(/\/+$/, "");
  const nome = (t: Parameters<typeof nomeMaterialNoticia>[1]) =>
    nomeMaterialNoticia(data, t, indice, duracao);

  const creatives: KumaCreative[] = [
    // A ordem dos materiais do 19" importa: índice 0 é a tela de cima.
    {
      devicestyle: "smart19",
      materials: [
        material(nome("19"), `${base}${SMART19_DEFAULTS.topo}`, duracao),
        material(nome("19P"), `${base}${SMART19_DEFAULTS.base}`, duracao),
      ],
    },
    { devicestyle: "smart25", materials: [material(nome("25"), imagem25, duracao)] },
    { devicestyle: "smart32", materials: [material(nome("32"), imagem32, duracao)] },
    // O 55" tem a mesma resolução do 32" e reaproveita o mesmo arquivo; só o
    // nome muda, porque nome repetido dentro da requisição também é recusado.
    { devicestyle: "smart55", materials: [material(nome("55"), imagem32, duracao)] },
  ];

  return { name: nomeGrupoNoticia(data, indice), duration: duracao, creatives };
}
