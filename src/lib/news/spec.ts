/**
 * Especificação do layout do NewsCard.
 *
 * Todas as medidas estão em pixels do arquivo final (export 1:1),
 * extraídas do PDF de especificação e conferidas contra os modelos PNG.
 * O preview usa as mesmas medidas × escala.
 */

export const SPEC = {
  colors: { bg: "#000000" },

  /** Editoria — Inter Bold 46,2475px, tracking +31/1000, caixa alta */
  ed: { size: 46.2475, track: 31, weight: 700 },
  /** Título — Inter Medium, tracking -30/1000 */
  ttl: { track: -30, weight: 500 },
  /** Crédito da foto — Inter Bold, tracking +31, rotacionado -90° */
  cred: { track: 31, weight: 700, insetX: 30, insetY: 48 },
  /** "continue no appnews" — Inter Medium 21px, tracking -30, ancorado no QR */
  cap: { text: "continue no appnews", size: 21, track: -30, weight: 500, x: 110, gap: 33 },

  /** Folga mínima entre a última linha do título e a barra do rodapé */
  bottomGap: 24,
} as const;

export type NewsFormat = {
  label: string;
  w: number;
  h: number;
  /** Escala do preview em relação ao arquivo final */
  sc: number;
  /** Moldura preta com o furo da foto (alpha 0 no furo) */
  mask: string;
  /** Linha separadora + QR + logo appnews, 1080px de largura */
  barra: string;
  hole: { x: number; y: number; w: number; h: number };
  /** Baseline da editoria */
  edBaseline: number;
  /** Baseline da 1ª linha do título */
  ttlBaseline: number;
  /** Fim do QR, medido do topo da barra */
  qrBottom: number;
  chip: "chip-a" | "chip-b";
};

export const NEWS_FORMATS: NewsFormat[] = [
  {
    label: 'Tela 32"',
    w: 1080,
    h: 1920,
    sc: 300 / 1080,
    mask: "/assets/news/mask-1920.png",
    barra: "/assets/news/barra-1920.png",
    hole: { x: 38, y: 36.25, w: 1007, h: 712.25 },
    edBaseline: 854,
    ttlBaseline: 972,
    qrBottom: 247,
    chip: "chip-a",
  },
  {
    label: 'Tela 25"',
    w: 1080,
    h: 2560,
    sc: 300 / 1080,
    mask: "/assets/news/mask-2560.png",
    barra: "/assets/news/barra-2560.png",
    hole: { x: 34.75, y: 40.25, w: 1010.75, h: 951.75 },
    edBaseline: 1109,
    ttlBaseline: 1264,
    qrBottom: 287,
    chip: "chip-b",
  },
];

export const CHAR_LIMIT = 120;

/** Valores de fábrica dos controles, iguais aos do template. */
export const NEWS_DEFAULTS = {
  tSize1: 86,
  tLead1: 112,
  tSize2: 115,
  tLead2: 138,
  marginX: 100,
  boxW: 903,
  imgX: 0,
  credSize: 20.7,
  glowBlur: 60,
  glowOp: 32,
  jpgQ: 95,
  edColor: "#5ce3ff",
  titleColor: "#ffffff",
  credColor: "#ffffff",
  autoFit: true,
  credOn: true,
  glowOn: true,
};

export type NewsControls = typeof NEWS_DEFAULTS;

export type NewsItem = {
  title: string;
  editoria: string;
  imageCredits: string;
  imgUrl: string | null;
  orig: { title: string; editoria: string; imageCredits: string };
};
