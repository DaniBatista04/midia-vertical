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
 * As notícias do dia ficam **todas na estratégia ao mesmo tempo**, e quem
 * reparte as exibições entre elas é o Kuma: com 240 exibições/dia e quatro
 * notícias, cada uma pega 60, uma por exibição, espalhadas pelo dia inteiro. A
 * unidade não manda `hours`, então isso vale para todas as janelas do dia.
 *
 * ## A tentativa de rodízio, e por que ela saiu
 *
 * Entre 01/09 e 03/09/2026 a estratégia carregou **um** grupo por vez, com o
 * cron trocando o grupo do ar a cada meia hora. A leitura por trás disso era
 * que grupos juntos na estratégia tocariam emendados na mesma exibição, e a
 * medida que sustentava a leitura era a linha do plano no portal marcando 30s
 * num dia de notícias. A operação viu o resultado nas telas e recusou: uma
 * notícia ficava o turno inteiro no ar, e a troca só vinha quando a janela
 * virava.
 *
 * Os 30s do portal eram a soma dos criativos amarrados, não o bloco de uma
 * exibição. O que a `Creative Interface API` (§2.1 e §2.2, em `docs/api-kuma/`)
 * define é que o grupo criativo é **um anúncio**: `creatives` é um por tipo de
 * tela, `materials` dentro de cada um é *um* para tela cheia e *dois* só no 19",
 * que é tela dividida — o material 0 é a de cima e o 1 a de baixo, não uma fila
 * de exibição. A duração do anúncio é a `duration` do grupo, e ela não cresce
 * porque a estratégia tem vizinhos.
 *
 * ## Por que a estratégia reparte, e não emenda
 *
 * Duas evidências, já que a API não documenta isso:
 *
 *  - a exigência da Brato que o `gruposParaEstrategia` obedece — o número de
 *    grupos precisa dividir `frequency/60` — só faz sentido para quem divide a
 *    frequência entre eles; e
 *  - o `focusmediapublisher`, que faz isso em produção há mais tempo: lá vários
 *    comunicados dividem a mesma unidade, todos os grupos entram juntos na
 *    estratégia (é o `padGroupIdsForFrequency` de lá), e as telas dos prédios
 *    mostram um comunicado por exibição. Se emendassem, um prédio com cinco
 *    comunicados ativos exibiria um bloco de mais de um minuto.
 *
 * ## O registro
 *
 * O arquivo mora ao lado dos envios, em `noticias/plano/`, e é a única memória
 * de quais grupos já estão amarrados naquele dia: não existe endpoint para ler
 * a estratégia de uma unidade, então quem chama precisa guardar a lista. E
 * precisa mesmo — `createOrderStrategy` **substitui** a estratégia inteira, e é
 * remontando a lista do zero a cada notícia nova que as anteriores continuam no
 * ar.
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
   * A lista que foi mandada no último `createOrderStrategy` — já com o padding
   * do `gruposParaEstrategia`, e por isso diferente de `grupos`.
   *
   * O Kuma não tem endpoint para ler a estratégia de uma unidade: o que está no
   * ar é o que este campo disser que está. É o que permite ao cron perceber que
   * a estratégia ficou para trás — de uma volta que falhou no meio, ou de um
   * plano criado quando o rodízio ainda existia — sem gastar uma chamada por
   * minuto para reescrever o que já está certo.
   */
  estrategia?: string[];

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
 * O número nasce de uma exigência da Brato: a quantidade de grupos criativos na
 * estratégia precisa dividir `frequency/60`, e com as 240 exibições/dia da
 * operação isso dá 4. Custou caro no `focusmediapublisher` (é o
 * `padGroupIdsForFrequency` de lá) e não está em documento nenhum da API.
 *
 * O teto também é o que a operação combinou: as 240 exibições do dia repartidas
 * entre mais notícias dariam a cada uma um pedaço pequeno demais para alguém
 * notar que passou. Com quatro, cada uma fica com 60 exibições no dia.
 */
export function slotsDaFrequencia(frequencia: number): number {
  return Math.max(1, Math.floor(frequencia / 60));
}

/**
 * A lista de grupos que vai no `createOrderStrategy`.
 *
 * A Brato recusa a estratégia quando o número de grupos não divide
 * `frequency/60` — a fatia de cada grupo precisa fechar em minuto cheio. Com
 * quatro vagas, uma e duas notícias passam direto, e **três não**: a lista sobe
 * para quatro repetindo a primeira, que fica com duas fatias. É desigual de
 * propósito, e é melhor que a recusa da chamada: a alternativa seria segurar a
 * terceira notícia fora do ar até chegar uma quarta.
 *
 * A repetição de um id na lista é o mesmo recurso que o `focusmediapublisher`
 * usa em produção, e o Kuma aceita.
 */
export function gruposParaEstrategia(grupos: string[], frequencia: number): string[] {
  if (!grupos.length) return [];
  const slots = slotsDaFrequencia(frequencia);
  // Acima do teto a lista é cortada nas vagas que existem; quem chama já recusa
  // o envio antes disso, então aqui é só não mandar uma lista impossível.
  let n = Math.min(grupos.length, slots);
  while (slots % n !== 0) n++;
  return Array.from({ length: n }, (_, i) => grupos[i % grupos.length]);
}

/** As duas listas descrevem a mesma estratégia? Ordem inclusa. */
export function mesmaEstrategia(a: string[] | undefined, b: string[]): boolean {
  return Boolean(a) && a!.length === b.length && a!.every((g, i) => g === b[i]);
}
