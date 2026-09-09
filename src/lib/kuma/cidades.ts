/**
 * As cidades em que a automação veicula, e como cada uma aparece nos nomes.
 *
 * Existe como módulo próprio porque três camadas precisam da mesma resposta e
 * não podem depender umas das outras: o registro do dia (`estado.ts`), o
 * agendamento (`agendar.ts`) e o job da véspera (`scripts/clima-diario.mts`).
 * Deixar isso em `agendar.ts` faria `estado.ts` importar de quem importa
 * `estado.ts`.
 *
 * Os códigos são os `cityId` do Kuma, lidos de `GET
 * /v1/adresource/getAllStandardCities?productName=SMART_SCREEN` em 09/09/2026.
 * A lista inteira da conta são duas cidades — não há uma terceira esperando.
 */

/** São Paulo. */
export const CIDADE_SP = "6003";

/** Rio de Janeiro. */
export const CIDADE_RJ = "6200";

/**
 * A cidade que vale quando ninguém disse qual.
 *
 * É São Paulo porque foi a única praça até 09/09/2026, e porque manter o padrão
 * é o que deixa a chegada do Rio ser aditiva: nenhum caminho de São Paulo muda
 * de nome, de arquivo ou de comportamento por causa dela.
 */
export const CIDADE_PADRAO = CIDADE_SP;

/**
 * A sigla que entra em nome de plano, de grupo criativo e de arquivo de estado.
 *
 * Precisa ser curta por causa do teto de 60 bytes do `filename` do Kuma (ver
 * `filename.ts`), e precisa ser estável porque é ela que quem opera lê na lista
 * do portal para saber de qual praça é aquele plano.
 */
const SIGLAS: Record<string, string> = {
  [CIDADE_SP]: "SP",
  [CIDADE_RJ]: "RJ",
};

/**
 * Sigla de uma cidade. Cidade desconhecida vira o próprio `cityId`.
 *
 * Não lança: um `cityId` novo que a Brato cadastre depois deve produzir nome
 * feio, não derrubar a veiculação do dia. Feio aparece na lista do portal e
 * alguém corrige; exceção aqui apagaria o clima das telas.
 */
export function siglaCidade(cityId: string): string {
  return SIGLAS[cityId] ?? cityId;
}

/**
 * Sufixo de nome para uma cidade: vazio na cidade padrão, `-RJ` nas outras.
 *
 * A assimetria é deliberada. São Paulo já tem planos, grupos e arquivos de
 * estado nomeados sem sigla, e renomear tudo para `-SP` significaria: mudar o
 * que a operação procura na lista do portal, e — o que é pior — mudar o caminho
 * do registro do dia, fazendo a fase 2 não encontrar o registro da fase 1 e
 * criar uma segunda unidade travando as mesmas telas. O sufixo só nasce onde
 * ainda não há nada a preservar.
 */
export function sufixoDaCidade(cityId: string): string {
  return cityId === CIDADE_PADRAO ? "" : `-${siglaCidade(cityId)}`;
}

/**
 * Lê uma lista de `cityId` de variável de ambiente.
 *
 * Aceita `"6003"` e `"6003,6200"`, então a variável que hoje guarda uma cidade
 * só continua válida sem ninguém tocar nela. Sem valor, devolve a cidade padrão
 * — nunca lista vazia, porque lista vazia viraria "não veicular em lugar
 * nenhum" em silêncio.
 */
export function cidadesConfiguradas(valor: string | undefined): string[] {
  const lista = (valor ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return lista.length ? Array.from(new Set(lista)) : [CIDADE_PADRAO];
}

/**
 * Variável de ambiente com recorte por cidade, caindo na global.
 *
 * `KUMA_CLIMA_PREDIOS_RJ` vence para o Rio; sem ela vale `KUMA_CLIMA_PREDIOS`.
 * O sufixo é a sigla, e não o `cityId`, porque quem digita isso é gente na
 * interface da Vercel — `_RJ` se lê, `_6200` se erra.
 *
 * A cidade padrão também aceita o sufixo (`KUMA_CLIMA_PREDIOS_SP`), ainda que
 * hoje ninguém use: sem isso, configurar o Rio separadamente obrigaria a
 * global a significar "São Paulo", que é justamente a confusão que o recorte
 * existe para evitar.
 */
export function envDaCidade(base: string, cityId: string): string | undefined {
  const especifica = process.env[`${base}_${siglaCidade(cityId)}`];
  if (especifica !== undefined && especifica.trim()) return especifica;
  return process.env[base];
}

/**
 * O WOEID da HG Brasil para cada praça — de onde sai a previsão do card.
 *
 * Mora aqui, junto do `cityId`, de propósito: são dois identificadores da mesma
 * cidade em sistemas diferentes, e mantê-los separados é como se renderiza o
 * card de São Paulo e se publica com o nome do Rio. O erro seria silencioso —
 * arte plausível, praça errada — e só apareceria numa tela, para um morador.
 *
 * Conferidos contra a HG em 09/09/2026: 455827 devolve "São Paulo, SP" e
 * 455825 devolve "Rio de Janeiro, RJ".
 */
const WOEIDS: Record<string, string> = {
  [CIDADE_SP]: "455827",
  [CIDADE_RJ]: "455825",
};

export function woeidDaCidade(cityId: string): string | undefined {
  return WOEIDS[cityId];
}

/**
 * Aceita o que uma pessoa digita na linha de comando: `RJ`, `rj`, ou o `6200`.
 *
 * Sigla desconhecida vira erro em vez de passar adiante: `--cidade=RG` seguir
 * como se fosse um `cityId` faria o Kuma recusar o pedido com uma mensagem que
 * não menciona o argumento errado.
 */
export function resolverCidade(entrada: string): string {
  const cru = entrada.trim();
  if (WOEIDS[cru]) return cru;
  const porSigla = Object.keys(WOEIDS).find(
    (id) => siglaCidade(id).toLowerCase() === cru.toLowerCase(),
  );
  if (porSigla) return porSigla;
  throw new Error(
    `cidade desconhecida: "${entrada}" — use ${Object.keys(WOEIDS)
      .map((id) => `${siglaCidade(id)} (${id})`)
      .join(" ou ")}`,
  );
}
