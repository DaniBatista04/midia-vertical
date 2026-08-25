/**
 * O plano do dia das notícias: **uma** unidade por data, com todas as notícias
 * daquele dia amarradas nela.
 *
 * Até aqui cada envio criava a sua própria unidade, e um dia com quatro
 * notícias virava quatro planos na lista do portal — cada um travando as mesmas
 * telas por 240 exibições/dia, quatro vezes a pressão de inventário para o
 * mesmo conteúdo. A unidade do Kuma não precisa disso: `createOrderStrategy`
 * recebe uma **lista** de grupos criativos e a tela alterna entre eles. É como a
 * integração do Mural já opera em produção — as "orders persistentes" do
 * `focusmediapublisher` — e é o que este registro passa a coordenar aqui.
 *
 * O arquivo mora ao lado dos envios, em `noticias/plano/`, e é a única memória
 * de quais grupos já estão amarrados naquele dia: não existe endpoint para ler
 * a estratégia de uma unidade, então quem chama precisa guardar a lista. E
 * precisa mesmo — `createOrderStrategy` **substitui** a estratégia inteira, e
 * mandar só o grupo novo tiraria as notícias anteriores do ar.
 */

export type PlanoNoticias = {
  /** Data de veiculação, `YYYY-MM-DD`. É a identidade do plano. */
  data: string;

  /**
   * Unidade no Kuma. Ausente enquanto o plano está sendo criado: o registro é
   * gravado **antes** do `createOrder` justamente para que a segunda notícia
   * aprovada no mesmo minuto encontre algo e espere, em vez de abrir a segunda
   * unidade do dia.
   */
  unidadeId?: string;

  /**
   * Duração de exibição, em segundos.
   *
   * É campo da unidade, não da notícia: `durationInSecond` existe uma vez por
   * pedido. Duas notícias do mesmo dia com durações diferentes não caberiam no
   * mesmo plano, então a primeira fixa a duração e as outras precisam bater —
   * a recusa acontece no envio, antes de gastar índice e material.
   */
  duracao: number;

  /** Exibições por dia por tela da unidade. Decide quantos slots existem. */
  frequencia: number;

  /** Grupos criativos amarrados, na ordem em que entraram. */
  grupos: string[];

  /** Telas efetivamente travadas pela unidade. */
  telas?: number;

  criadoEm: string;
  atualizadoEm?: string;

  /**
   * Marca de "estou mexendo neste plano agora". Mesma ideia do `criandoEm` do
   * clima (ver `estado.ts`), mas aqui protege duas coisas: a criação da unidade
   * e a substituição da estratégia. Duas notícias aprovadas no mesmo minuto que
   * lessem a mesma lista de grupos mandariam duas estratégias, e a última
   * apagaria o grupo da primeira do ar.
   */
  criandoEm?: string;
};

export const PREFIXO_PLANOS = "noticias/plano";

export function caminhoPlanoNoticias(dataISO: string): string {
  return `${PREFIXO_PLANOS}/${dataISO}.json`;
}

/**
 * Quantos grupos criativos cabem numa unidade com essa frequência.
 *
 * A Brato exige que a quantidade de grupos na estratégia divida `frequency/60`
 * — o loop do dia é fatiado nesses slots. Com os 240 exibições/dia da operação
 * dá exatamente 4, que é o teto de notícias por dia. Custou caro no
 * `focusmediapublisher` (é o `padGroupIdsForFrequency` de lá) e não está em
 * documento nenhum da API.
 */
export function slotsDaFrequencia(frequencia: number): number {
  return Math.max(1, Math.floor(frequencia / 60));
}

/**
 * Ajusta a lista de grupos ao número de slots que a frequência aceita.
 *
 * Com 4 slots, 1, 2 e 4 grupos passam direto; 3 não divide 4, então o primeiro
 * grupo é repetido para fechar 4 — ele toca duas vezes por loop, o que a
 * operação prefere a uma estratégia recusada.
 *
 * Passar mais grupos que slots é erro de quem chama, não coisa para aparar em
 * silêncio: notícia sumindo da estratégia sem ninguém avisar é pior que falha.
 */
export function gruposEmSlots(grupos: string[], frequencia: number): string[] {
  const slots = slotsDaFrequencia(frequencia);
  if (!grupos.length) return grupos;
  if (grupos.length > slots) {
    throw new Error(
      `${grupos.length} grupos criativos para ${slots} slot(s) a ${frequencia} exibições/dia — ` +
        "o plano do dia não comporta.",
    );
  }
  let n = grupos.length;
  while (slots % n !== 0) n++;
  return Array.from({ length: n }, (_, i) => grupos[i % grupos.length]);
}
