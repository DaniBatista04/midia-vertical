/**
 * Registro de um envio de notícia.
 *
 * Diferente do clima, aqui o registro é por **envio**, não por dia: a escolha
 * da notícia é humana e podem sair várias no mesmo dia, cada uma com sua
 * própria unidade. O id do envio é o que separa uma da outra do começo ao fim.
 *
 * O arquivo é também a fila de trabalho. Não há banco no projeto, então o cron
 * lista este prefixo no bucket e avança cada envio um passo por vez — hospedado
 * → submetido → aprovado → no ar. Guardar o estágio no próprio registro é o que
 * permite ao cron ser interrompido a qualquer momento sem perder o fio.
 */

export type EstadoNoticia = {
  /** Identificador do envio: data + índice, único no bucket. */
  id: string;
  /** Título da notícia, só para quem for ler o registro entender o que é. */
  titulo: string;
  /** Data de veiculação, `YYYY-MM-DD`. */
  data: string;
  /** Separa notícias do mesmo dia e serve para reenvio. */
  indice: number;
  /** Segundos de exibição de cada material. */
  duracao: number;
  /**
   * Caixa do dia em que a notícia entra, a partir de 1 (ver `noticiaCaixas.ts`).
   * Envio de antes das caixas não tem, e conta como caixa 1.
   */
  caixa?: number;

  /** Quando os JPGs terminaram de subir para o Storage. */
  hospedadoEm: string;
  materiais: string[];

  /** Preenchidos quando o grupo criativo é submetido. */
  grupoId?: string;
  nomeGrupo?: string;
  submetidoEm?: string;

  /** Preenchidos quando a unidade é criada e o criativo amarrado. */
  unidadeId?: string;
  agendadoEm?: string;
  telas?: number;

  /** Trava contra duas execuções criando a mesma unidade. Ver `estado.ts`. */
  criandoEm?: string;
  recriacoes?: number;

  /**
   * Último erro definitivo deste envio.
   *
   * Preenchido quando não adianta tentar de novo — criativo reprovado, por
   * exemplo. Enquanto estiver aqui, o cron para de mexer neste envio, para não
   * repetir a mesma falha a cada minuto; quem opera vê o motivo e decide.
   */
  erro?: string;

  /**
   * Quando a operação tirou a notícia do pack pelo painel.
   *
   * É o fim do envio, como `erro`: o grupo sai do plano, e o cron para de mexer
   * nele — se o criativo ainda estava na Análise Criativa, aprovar depois não o
   * leva ao ar. Libera a vaga do pack para outra notícia.
   */
  retiradaEm?: string;

  /**
   * Envio de teste do `ignoreLock` (ver `testeIgnoreLock.ts`). Não entra no plano
   * do dia nem ocupa vaga de pack: depois de aprovado, ganha um plano e uma
   * unidade só dele, nas telas de um prédio. `unidadeId` do envio guarda o id
   * desse plano, que é o que a estratégia usa.
   */
  teste?: TesteIgnoreLock;
};

export type PassoDoTeste = { em: string; passo: string; ok: boolean; detalhe: string };

export type TesteIgnoreLock = {
  predioId: string;
  predioNome: string;
  cidadeId?: string;
  /** Plano criado para o teste — também é o `orderId` da estratégia. */
  planoId?: string;
  /** Unidade criada com `ignoreLock: true` dentro do plano. */
  adUnitId?: string;
  telas?: number;
  canceladoEm?: string;
  /** Cada chamada ao Kuma, com o que ele respondeu. */
  log: PassoDoTeste[];
};

export const PREFIXO_NOTICIAS = "noticias/estado";

export function caminhoNoticia(id: string): string {
  return `${PREFIXO_NOTICIAS}/${id}.json`;
}

/** Id do envio: a data de veiculação e o índice daquele dia. */
export function idNoticia(dataISO: string, indice: number): string {
  return `${dataISO}-${String(indice).padStart(2, "0")}`;
}
