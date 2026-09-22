/**
 * As caixas de notícia: o dia dividido em janelas, cada uma com as suas quatro
 * notícias.
 *
 * Até aqui o dia tinha uma lista só — até quatro notícias revezando do começo
 * ao fim. A operação quer escolher mais que isso sem que cada uma perca tempo
 * de tela, e o desenho é o de caixas: oito notícias viram duas caixas de
 * quatro, a primeira no ar numa janela do dia e a segunda na seguinte.
 *
 * ## Por que a troca é nossa, e não do Kuma
 *
 * A API não tem estratégia por hora — `createOrderStrategyWithDate` recorta em
 * dias, e só a *unidade* aceita `hours`. Uma unidade por caixa com `hours`
 * nunca foi testada nas telas, travaria as mesmas telas duas vezes e a consulta
 * de inventário devolve 400 quando o campo vai junto. Então a unidade continua
 * sendo uma por dia, e o que muda na virada da janela é a estratégia: o cron de
 * minuto confere qual caixa é a da hora e reescreve a lista quando ela muda.
 *
 * Isso já foi para as telas uma vez. Entre 01 e 03/09/2026 o cron trocava a
 * estratégia a cada meia hora, e a troca chegou aos players sem ninguém clicar
 * em Liberar — só que na virada da faixa de programação do Kuma, não no minuto
 * da chamada. Para rodízio de meia hora isso era defeito; para caixa, que ocupa
 * uma janela de horas, é o comportamento certo. E dentro da caixa as quatro
 * notícias continuam dividindo a estratégia, uma por exibição — o que a
 * operação recusou naquela época foi uma notícia só segurando a janela.
 *
 * Módulo puro, sem rede: quem lê e grava é o `publicarNoticia.ts`.
 */

import { gruposParaEstrategia, slotsDaFrequencia } from "./noticiaPlano";

/**
 * Quantas caixas cabem num dia.
 *
 * O Kuma programa em faixas de duas horas, e a troca só chega à tela na virada
 * de uma delas. Com o dia das telas indo das 6h à meia-noite, quatro caixas já
 * dão janelas de quatro a seis horas; mais que isso e cada caixa ficaria no ar
 * por uma ou duas faixas, com a troca atrasando uma faixa inteira por conta do
 * Kuma.
 */
export const MAX_CAIXAS = 4;

/**
 * Onde o dia começa e termina para a divisão das janelas, em horas cheias.
 *
 * As notícias passam antes e depois do horário comercial, então a divisão não
 * pode ser a das faixas de comunicado (10h–18h). A caixa 1 também cobre a
 * madrugada — o que estiver antes do primeiro corte é dela —, mas dividir a
 * partir da meia-noite daria à caixa 1 horas em que o prédio está dormindo.
 */
export const INICIO_DIA = 6;
export const FIM_DIA = 24;

/** Notícias por caixa: as vagas que uma estratégia comporta. */
export function vagasPorCaixa(frequencia: number): number {
  return slotsDaFrequencia(frequencia);
}

/**
 * Horários de troca escolhidos para um dia.
 *
 * Mora fora do plano (`noticiaPlano.ts`) porque nasce antes dele: a grade é
 * gravada no envio, e o plano só existe depois que a primeira notícia é
 * aprovada.
 */
export type GradeNoticias = {
  data: string;
  /** Hora em que cada caixa seguinte entra no ar. `[16]` = duas caixas, troca às 16h. */
  cortes: number[];
  atualizadoEm: string;
};

export const PREFIXO_GRADES = "noticias/grade";

export function caminhoGrade(dataISO: string): string {
  return `${PREFIXO_GRADES}/${dataISO}.json`;
}

/**
 * A divisão padrão do dia em `n` caixas.
 *
 * Partes iguais entre `INICIO_DIA` e `FIM_DIA`, com cada corte arredondado para
 * hora par: é onde as faixas do Kuma viram, e um corte às 15h só chegaria à
 * tela às 16h de qualquer jeito. Duas caixas trocam às 16h; três às 12h e 18h;
 * quatro às 10h, 16h e 20h.
 */
export function cortesPadrao(n: number): number[] {
  const caixas = Math.min(Math.max(1, Math.floor(n)), MAX_CAIXAS);
  const passo = (FIM_DIA - INICIO_DIA) / caixas;
  return Array.from({ length: caixas - 1 }, (_, k) =>
    Math.round((INICIO_DIA + passo * (k + 1)) / 2) * 2,
  );
}

/** Os cortes servem para `n` caixas? Horas inteiras, crescentes, dentro do dia. */
export function cortesValidos(cortes: unknown, n: number): cortes is number[] {
  if (!Array.isArray(cortes) || cortes.length !== n - 1) return false;
  return cortes.every(
    (h, i) =>
      Number.isInteger(h) &&
      h > INICIO_DIA &&
      h < FIM_DIA &&
      (i === 0 || h > cortes[i - 1]),
  );
}

/**
 * Os cortes que valem para um dia com `n` caixas: os da grade gravada, se
 * servirem, e senão a divisão padrão.
 *
 * Grade de outro tamanho não é erro. Maior que o dia é o caso comum: a grade
 * descreve as caixas que o operador montou, e as últimas ainda estão na Análise
 * Criativa — os primeiros cortes continuam valendo, e a última caixa aprovada
 * fica no ar até o fim do dia. Menor é o dia em que o operador mandou mais
 * notícias depois sem mexer nos horários, e aí a divisão padrão mantém toda
 * caixa com janela.
 */
export function cortesDoDia(grade: Pick<GradeNoticias, "cortes"> | null, n: number): number[] {
  const cortes = grade?.cortes;
  const tamanho = Array.isArray(cortes) ? cortes.length : -1;
  if (cortesValidos(cortes, tamanho + 1) && tamanho >= n - 1) return cortes.slice(0, n - 1);
  return cortesPadrao(n);
}

/**
 * Os cortes de um dia levados para `n` caixas, mexendo no mínimo.
 *
 * É o que o painel faz quando o operador abre ou fecha uma caixa depois de ter
 * arrastado os horários: a caixa nova divide a última janela ao meio, e a que
 * sai devolve a janela dela para a anterior. Recalcular tudo pela divisão
 * padrão desfaria o horário que ele acabou de escolher. Quando a última janela
 * não comporta mais um corte em hora par, cai na divisão padrão.
 */
export function ajustarCortes(cortes: number[], n: number): number[] {
  if (!cortesValidos(cortes, cortes.length + 1)) return cortesPadrao(n);
  if (cortes.length >= n - 1) return cortes.slice(0, Math.max(0, n - 1));
  const novos = [...cortes];
  while (novos.length < n - 1) {
    const ultimo = novos.at(-1) ?? INICIO_DIA;
    const meio = Math.round((ultimo + FIM_DIA) / 4) * 2;
    if (meio <= ultimo || meio >= FIM_DIA) return cortesPadrao(n);
    novos.push(meio);
  }
  return novos;
}

/** Qual caixa a hora pede. `hora` é fracionária, no fuso de São Paulo. */
export function caixaDaHora(cortes: number[], hora: number): number {
  return cortes.filter((c) => hora >= c).length + 1;
}

/** Hora do dia em São Paulo, fracionária (14h30 = 14.5). */
export function horaEmSaoPaulo(agora: Date = new Date()): number {
  const partes = new Intl.DateTimeFormat("en-GB", {
    timeZone: "America/Sao_Paulo",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(agora);
  const h = Number(partes.find((p) => p.type === "hour")?.value ?? 0);
  const m = Number(partes.find((p) => p.type === "minute")?.value ?? 0);
  return h + m / 60;
}

/** Os grupos do plano, separados por caixa. Grupo sem caixa registrada é da 1. */
export function gruposPorCaixa(
  grupos: string[],
  caixaDoGrupo: Record<string, number> | undefined,
): Map<number, string[]> {
  const mapa = new Map<number, string[]>();
  for (const g of grupos) {
    const c = caixaDoGrupo?.[g] ?? 1;
    mapa.set(c, [...(mapa.get(c) ?? []), g]);
  }
  return mapa;
}

export type EstrategiaDaHora = {
  /** A caixa que está no ar — nem sempre a que a hora pede. */
  caixa: number;
  /** A caixa que a hora pede. */
  caixaDaHora: number;
  /** Quantas caixas o dia tem com notícia amarrada. */
  caixas: number;
  cortes: number[];
  /** A lista do `createOrderStrategy`, já com o padding da Brato. */
  estrategia: string[];
};

/**
 * O que a estratégia deve carregar agora.
 *
 * A caixa da hora nem sempre tem notícia no plano: as dela podem estar ainda
 * na Análise Criativa, ou ter sido reprovadas. A estratégia **nunca** fica
 * vazia por isso — unidade sem criativo trava as telas e não exibe nada. Fica
 * no ar a caixa anterior mais próxima que tenha notícia e, se nenhuma anterior
 * tiver (a caixa 1 ainda não foi aprovada às 16h), a primeira seguinte.
 *
 * O número de caixas é o da maior caixa com notícia amarrada, e não o de
 * caixas com notícia: uma caixa 2 vazia entre a 1 e a 3 continua ocupando a
 * janela dela, preenchida pela 1, em vez de a 3 mudar de horário.
 */
export function estrategiaDaHora(
  plano: { grupos: string[]; caixaDoGrupo?: Record<string, number>; frequencia: number },
  grade: Pick<GradeNoticias, "cortes"> | null,
  hora: number,
): EstrategiaDaHora {
  const porCaixa = gruposPorCaixa(plano.grupos, plano.caixaDoGrupo);
  const caixas = Math.max(1, ...porCaixa.keys());
  const cortes = cortesDoDia(grade, caixas);
  const pedida = caixaDaHora(cortes, hora);

  const comNoticia = [...porCaixa.keys()].sort((a, b) => a - b);
  const anterior = comNoticia.filter((c) => c <= pedida).pop();
  const caixa = anterior ?? comNoticia[0] ?? pedida;

  return {
    caixa,
    caixaDaHora: pedida,
    caixas,
    cortes,
    estrategia: gruposParaEstrategia(porCaixa.get(caixa) ?? [], plano.frequencia),
  };
}

/** `16` → `"16h"`; `24` → `"24h"`. */
export function rotuloHora(h: number): string {
  return `${String(h).padStart(2, "0")}h`;
}
