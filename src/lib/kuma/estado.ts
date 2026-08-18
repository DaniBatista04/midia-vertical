/**
 * Registro do clima de um dia, compartilhado entre as duas fases do job.
 *
 * O projeto não tem banco, e as duas fases rodam em execuções separadas de CI:
 * a das 23h submete o grupo criativo, e a de agendamento — que só pode agir
 * depois de alguém aprovar no portal — precisa saber qual grupo é o do dia.
 * O arquivo mora no mesmo bucket dos vídeos, ao lado do material que descreve.
 */

export type EstadoDoDia = {
  /** Data de veiculação, `YYYY-MM-DD`. */
  data: string;
  /** ID do grupo criativo no Kuma. */
  grupoId: string;
  nomeGrupo: string;
  indice: number;
  duracao: number;
  submetidoEm: string;
  materiais: string[];
  /** Preenchidos pela fase de agendamento. */
  unidadeId?: string;
  agendadoEm?: string;
  telas?: number;
  /**
   * Marca de "estou criando a unidade agora", gravada antes da criação e
   * apagada depois.
   *
   * Sem ela, duas chamadas quase simultâneas leem o registro sem unidade, as
   * duas se acham a primeira, e nascem duas unidades travando as mesmas telas.
   * Aconteceu em produção com três segundos de diferença. Não é trava perfeita
   * — o Storage não tem escrita condicional — mas fecha a janela de segundos
   * para a de milissegundos, e o cron de minuto nunca mais reincide.
   */
  criandoEm?: string;
};

/**
 * Por quanto tempo uma marca de criação em andamento é respeitada.
 *
 * Precisa cobrir a criação mais lenta (criar unidade, amarrar criativo e ler o
 * detalhe, contra uma API que às vezes demora), e ser curta o bastante para um
 * processo morto no meio não bloquear o dia inteiro.
 */
export const LEASE_SEGUNDOS = 180;

export function caminhoEstado(dataISO: string): string {
  return `clima/estado/${dataISO}.json`;
}
