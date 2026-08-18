/**
 * Fase 2 do clima pela linha de comando.
 *
 * Em produção quem chama isto é o cron da Vercel (de minuto em minuto, das 0h
 * às 12h de Brasília) ou o link que a pessoa clica logo depois de aprovar o
 * criativo no portal. Este script existe para operar à mão: reprocessar um dia
 * específico, conferir por que um agendamento não aconteceu, ou simular sem
 * criar nada.
 *
 *   npm run clima:agendar                 agenda o clima de hoje, se aprovado
 *   npm run clima:agendar -- --data=...   um dia específico
 *   npm run clima:agendar -- --simular    faz tudo menos criar e amarrar
 *   npm run clima:agendar -- --janela=16-18   só na janela das 16h às 18h
 *
 * Sair com código 0 sem agendar é normal: significa "ainda não aprovado".
 * Código 1 é problema de verdade — criativo reprovado, inventário insuficiente
 * ou falha de chamada.
 *
 * Variáveis, além das do Kuma:
 *   KUMA_CLIMA_CIDADE     cityId; padrão 6003 (São Paulo)
 *   KUMA_CLIMA_PREDIOS    buildingIds separados por vírgula, ou
 *   KUMA_CLIMA_TELAS      locationIds separados por vírgula
 *   KUMA_CLIMA_FREQUENCIA exibições/dia por tela; padrão 240
 */

import { agendarClima, descreverResultado, horasDaJanela } from "../src/lib/kuma/agendar";

const arg = (nome: string): string | undefined =>
  process.argv.find((a) => a.startsWith(`--${nome}=`))?.slice(nome.length + 3);

function log(mensagem: string) {
  console.log(`[agendar] ${new Date().toISOString().slice(11, 19)} ${mensagem}`);
}

async function main() {
  const resultado = await agendarClima({
    data: arg("data"),
    simular: process.argv.includes("--simular"),
    horas: horasDaJanela(arg("janela")),
    log,
  });
  log(descreverResultado(resultado));
}

main().catch((e) => {
  console.error(`[agendar] FALHOU: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
