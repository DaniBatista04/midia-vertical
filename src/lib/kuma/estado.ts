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
};

export function caminhoEstado(dataISO: string): string {
  return `clima/estado/${dataISO}.json`;
}
