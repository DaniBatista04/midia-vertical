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
};

export const PREFIXO_NOTICIAS = "noticias/estado";

export function caminhoNoticia(id: string): string {
  return `${PREFIXO_NOTICIAS}/${id}.json`;
}

/** Id do envio: a data de veiculação e o índice daquele dia. */
export function idNoticia(dataISO: string, indice: number): string {
  return `${dataISO}-${String(indice).padStart(2, "0")}`;
}
