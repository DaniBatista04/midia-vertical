/**
 * O plano do dia das notícias: **uma** unidade por data, com todas as notícias
 * daquele dia amarradas nela.
 *
 * Até aqui cada envio criava a sua própria unidade, e um dia com quatro
 * notícias virava quatro planos na lista do portal — cada um travando as mesmas
 * telas por 240 exibições/dia, quatro vezes a pressão de inventário para o
 * mesmo conteúdo. A unidade do Kuma não precisa disso, e este registro é o que
 * permite juntar as notícias do dia numa unidade só.
 *
 * O que **não** dá para fazer é deixar os grupos todos na estratégia ao mesmo
 * tempo. `createOrderStrategy` aceita uma lista, e a leitura de que a tela
 * alternaria entre eles estava errada: os grupos da estratégia tocam
 * **emendados** na mesma exibição. Medido pela operação em 01/09/2026 — quatro
 * notícias num dia deixaram a linha do plano no portal com 30s, enquanto o
 * clima, que tem um grupo criativo só, aparece com os 10s de sempre. Cada
 * notícia continua sendo um material de 10s, mas o bloco na tela crescia com a
 * quantidade delas.
 *
 * Por isso a estratégia carrega **um** grupo por vez (`noAr`), e o rodízio
 * entre as notícias do dia é nosso: o cron troca o grupo da vez a cada
 * `JANELA_RODIZIO_MINUTOS`. O bloco na tela fica em 10s independentemente de
 * quantas notícias forem selecionadas, e cada uma pega a sua fatia do dia.
 *
 * O arquivo mora ao lado dos envios, em `noticias/plano/`, e é a única memória
 * de quais grupos já estão amarrados naquele dia: não existe endpoint para ler
 * a estratégia de uma unidade, então quem chama precisa guardar a lista. E
 * precisa mesmo — `createOrderStrategy` **substitui** a estratégia inteira, que
 * é exatamente o que o rodízio usa para trocar o grupo do ar, e o que faria as
 * notícias anteriores sumirem se a lista fosse remontada errada.
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

  /** Exibições por dia por tela da unidade. Decide quantas notícias cabem. */
  frequencia: number;

  /** Grupos criativos amarrados, na ordem em que entraram. */
  grupos: string[];

  /**
   * Grupo criativo que está na estratégia da unidade **agora**.
   *
   * É sempre um só, e é o que mantém o bloco da notícia em 10s na tela. Sem
   * este campo não haveria como saber se a troca do rodízio já foi feita: o
   * Kuma não tem endpoint para ler a estratégia de uma unidade, então o que
   * está no ar é o que este registro disser que está.
   */
  noAr?: string;

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
 * Quantas notícias a operação divide num dia, com essa frequência.
 *
 * O número nasceu de uma exigência da Brato: a quantidade de grupos criativos
 * na estratégia precisa dividir `frequency/60`, e com os 240 exibições/dia da
 * operação isso dá 4. Custou caro no `focusmediapublisher` (é o
 * `padGroupIdsForFrequency` de lá) e não está em documento nenhum da API.
 *
 * Com o rodízio a exigência deixou de pesar — a estratégia leva um grupo só, e
 * 1 divide qualquer coisa. O teto de 4 fica porque continua sendo o número que
 * a operação combinou: as 240 exibições do dia repartidas entre mais notícias
 * dariam a cada uma um pedaço pequeno demais para alguém notar que passou.
 * Mudar esse teto é decisão da operação, não consequência da API.
 */
export function slotsDaFrequencia(frequencia: number): number {
  return Math.max(1, Math.floor(frequencia / 60));
}

/**
 * Por quanto tempo cada notícia fica no ar antes de passar a vez.
 *
 * Meia hora é o meio-termo entre duas coisas que puxam para lados opostos: a
 * troca custa uma chamada de `createOrderStrategy` (48 por dia no pior caso, ao
 * lado de um cron que já bate de minuto em minuto, então é barato), e uma
 * janela curta demais faria a notícia entrar e sair antes de o prédio inteiro
 * passar pelo elevador. Com 240 exibições/dia, meia hora são cerca de cinco
 * exibições por turno, e com quatro notícias cada uma volta ao ar a cada duas
 * horas.
 */
export const JANELA_RODIZIO_MINUTOS = 30;

/**
 * Qual grupo criativo deve estar no ar neste instante.
 *
 * A conta é feita a partir do relógio, e não de "quando foi a última troca", de
 * propósito: assim ela não depende de o cron ter rodado, não acumula atraso
 * quando uma volta falha, e duas execuções no mesmo minuto chegam ao mesmo
 * grupo. O registro do plano só guarda o que está no ar (`noAr`) para saber se
 * a troca já foi feita.
 *
 * Uma notícia que entra no meio do dia muda o tamanho da lista e, com ele, o
 * grupo da vez — quem estava no ar pode ceder o lugar antes de fechar a janela.
 * Isso é aceitável e até desejável: a notícia recém-aprovada estreia em minutos
 * em vez de esperar a volta inteira do rodízio.
 */
export function grupoDaVez(grupos: string[], agora: Date = new Date()): string | undefined {
  if (!grupos.length) return undefined;
  const turno = Math.floor(agora.getTime() / (JANELA_RODIZIO_MINUTOS * 60_000));
  return grupos[turno % grupos.length];
}
