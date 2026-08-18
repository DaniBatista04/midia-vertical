/**
 * Monta o grupo criativo do clima no formato que a auditoria do Kuma já
 * aprova hoje.
 *
 * A referência não é a documentação, é um grupo real aprovado em produção,
 * que traz cinco materiais com o mesmo índice e a mesma duração:
 *
 *   RESIDENCIALPORTALDASERRA-20260817-25-2-10
 *   RESIDENCIALPORTALDASERRA-20260817-32-2-10
 *   RESIDENCIALPORTALDASERRA-20260817-19-2-10
 *   RESIDENCIALPORTALDASERRA-20260817-19P-2-10
 *   RESIDENCIALPORTALDASERRA-20260817-55-2-10
 *
 * O índice repetido entre os formatos é exigência da Brato: em campanha com
 * dois ou mais vídeos, o vídeo 1 do 25" precisa corresponder ao vídeo 1 do
 * 32", senão o sistema deles não casa os materiais entre as telas.
 */

import { byteLength, KUMA_FILENAME_MAX_BYTES } from "./filename";
import type { KumaCreative, KumaCreativeGroupRequest, KumaMaterial } from "./client";

/** Materiais default do 19", servidos publicamente pelo próprio app. */
export const SMART19_DEFAULTS = {
  topo: "/assets/kuma/smart19-default-top-1920x1080.jpg",
  base: "/assets/kuma/smart19-default-bottom-768x1366.jpg",
} as const;

export type WeatherGroupInput = {
  /** Data de veiculação (a arte é gerada na véspera). */
  data: Date;
  /** Duração dos materiais, em segundos. */
  duracao: number;
  /**
   * Índice do material dentro da campanha. Sobe para 2, 3… quando o mesmo dia
   * precisa ser reenviado — nome repetido entre requisições é reprovado com
   * 502 e feedback vazio, sem dizer o motivo.
   */
  indice: number;
  /** URL pública do MP4 1080×1920 (tela de 32"). */
  video32: string;
  /** URL pública do MP4 1080×2560 (tela de 25"). */
  video25: string;
  /** Base pública do app, para montar a URL dos materiais default do 19". */
  baseUrl: string;
};

/** `YYYYMMDD` no fuso local, sem o desvio de `toISOString()`. */
export function dataCompacta(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${y}${m}${dd}`;
}

export function nomeMaterial(
  data: Date,
  tamanho: "25" | "32" | "55" | "19" | "19P",
  indice: number,
  duracao: number,
): string {
  return `WEATHER-${dataCompacta(data)}-${tamanho}-${indice}-${duracao}`;
}

export function nomeGrupo(data: Date): string {
  return `WEATHER-${dataCompacta(data)}`;
}

function material(
  nome: string,
  url: string,
  mime: "video/mp4" | "image/jpeg",
  duracao: number,
): KumaMaterial {
  const filename = `${nome}.${mime === "video/mp4" ? "mp4" : "jpg"}`;
  // O limite é do device, não da API: nome mais longo é aceito na submissão e
  // reprovado depois, na auditoria.
  if (byteLength(filename) > KUMA_FILENAME_MAX_BYTES) {
    throw new Error(
      `Nome de material passa de ${KUMA_FILENAME_MAX_BYTES} bytes: ${filename} (${byteLength(filename)})`,
    );
  }
  return { id: nome, iurl: url, filename, display: { duration: duracao, mime } };
}

export function montarGrupoClima(input: WeatherGroupInput): KumaCreativeGroupRequest {
  const { data, duracao, indice, video32, video25, baseUrl } = input;
  const base = baseUrl.replace(/\/+$/, "");
  const nome = (t: Parameters<typeof nomeMaterial>[1]) => nomeMaterial(data, t, indice, duracao);

  const creatives: KumaCreative[] = [
    // A ordem dos materiais do 19" importa: índice 0 é a tela de cima.
    {
      devicestyle: "smart19",
      materials: [
        material(nome("19"), `${base}${SMART19_DEFAULTS.topo}`, "image/jpeg", duracao),
        material(nome("19P"), `${base}${SMART19_DEFAULTS.base}`, "image/jpeg", duracao),
      ],
    },
    { devicestyle: "smart25", materials: [material(nome("25"), video25, "video/mp4", duracao)] },
    { devicestyle: "smart32", materials: [material(nome("32"), video32, "video/mp4", duracao)] },
    // O 55" tem a mesma resolução do 32" e reaproveita o mesmo arquivo; só o
    // nome muda, porque nome repetido dentro da requisição também é recusado.
    { devicestyle: "smart55", materials: [material(nome("55"), video32, "video/mp4", duracao)] },
  ];

  return { name: nomeGrupo(data), duration: duracao, creatives };
}

/**
 * O feedback da auditoria vem em chinês. Estas são as mensagens que já vimos;
 * o resto passa direto, para ninguém perder informação por causa da tradução.
 */
const TRADUCOES: [RegExp, string][] = [
  [/通过/g, "aprovado"],
  [/分辨率不合规/g, "resolução fora do padrão"],
  [/时长/g, "duração"],
  [/不能小于/g, "não pode ser menor que"],
  [/整屏/g, "tela cheia"],
  [/上屏/g, "tela de cima"],
  [/下屏/g, "tela de baixo"],
  [/第(\d+)个素材/g, "material $1"],
  [/寸/g, " polegadas"],
];

export function traduzirFeedback(feedback: string | null | undefined): string {
  if (!feedback) return "";
  let texto = feedback;
  for (const [de, para] of TRADUCOES) texto = texto.replace(de, para);
  // Material listado com motivo vazio é a assinatura de nome de arquivo
  // repetido entre requisições — a API não diz isso, foi medido no sandbox.
  if (/材料|素材/.test(feedback) === false && /：；|:;/.test(texto)) {
    texto += " — provável nome de arquivo repetido entre requisições";
  }
  return texto;
}
