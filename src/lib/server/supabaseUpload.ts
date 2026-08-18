/**
 * Sobe um arquivo para o Storage do Supabase e devolve a URL pública.
 *
 * É a mesma conta que o Mural já usa para hospedar os criativos dos
 * comunicados — o Kuma não recebe upload, ele baixa o material pela URL do
 * campo `iurl`, então o arquivo precisa estar num endereço público.
 *
 * Sem SDK de propósito: a API de Storage é REST, e o cliente oficial traria
 * um megabyte de dependência para uma chamada só.
 */

export type UploadOptions = {
  /** Caminho dentro do bucket, ex.: `clima/WEATHER-20260818-25-1-10.mp4`. */
  caminho: string;
  conteudo: Uint8Array;
  contentType: string;
};

export function supabaseConfig() {
  const url = (process.env.SUPABASE_URL ?? "").replace(/\/+$/, "");
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
  // O bucket padrão é o mesmo do Mural; o prefixo `clima/` mantém o material
  // separado, para uma política de retenção própria não tocar em comunicado.
  const bucket = process.env.SUPABASE_BUCKET ?? "Media";
  if (!url || !key) {
    throw new Error("Defina SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY para hospedar os vídeos.");
  }
  return { url, key, bucket };
}

export async function uploadPublico({ caminho, conteudo, contentType }: UploadOptions): Promise<string> {
  const { url, key, bucket } = supabaseConfig();
  const alvo = `${url}/storage/v1/object/${bucket}/${caminho}`;

  const res = await fetch(alvo, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": contentType,
      // Reenvio do mesmo dia sobrescreve em vez de estourar 409.
      "x-upsert": "true",
    },
    body: conteudo as BodyInit,
  });

  if (!res.ok) {
    throw new Error(`upload para o Supabase falhou (HTTP ${res.status}): ${(await res.text()).slice(0, 200)}`);
  }

  const publica = `${url}/storage/v1/object/public/${bucket}/${caminho}`;
  await esperarDisponivel(publica);
  return publica;
}

/**
 * Espera a URL pública responder antes de devolvê-la.
 *
 * Isto não é zelo: o Storage do Supabase serve por CDN, e um objeto recém-subido
 * leva um instante para estar disponível na borda. O Kuma baixa o material logo
 * depois da submissão — submeter no mesmo segundo do upload fez a auditoria
 * reprovar com 502 e feedback vazio em cinco tentativas seguidas contra a
 * produção, enquanto o mesmo arquivo submetido minutos depois passou.
 */
async function esperarDisponivel(publica: string, tentativas = 10): Promise<void> {
  for (let i = 1; i <= tentativas; i++) {
    try {
      const r = await fetch(publica, { method: "GET", headers: { Range: "bytes=0-0" } });
      if (r.ok || r.status === 206) return;
    } catch {
      // rede instável na borda: trata como indisponível e tenta de novo
    }
    await new Promise((r) => setTimeout(r, 1_500 * i));
  }
  throw new Error(`o material subiu mas a URL pública não respondeu: ${publica}`);
}

/** URL pública de um caminho do bucket, sem subir nada. */
export function urlPublica(caminho: string): string {
  const { url, bucket } = supabaseConfig();
  return `${url}/storage/v1/object/public/${bucket}/${caminho}`;
}

/**
 * Lê um JSON do bucket. Devolve `null` quando o arquivo não existe — é assim
 * que a fase de agendamento descobre que ainda não há clima submetido para o
 * dia, em vez de estourar.
 *
 * Vai pelo endpoint **autenticado**, e não pela URL pública, de propósito: a URL
 * pública passa pelo CDN e serve versão velha por minutos. Medido: depois de
 * gravar o registro com a unidade criada, a leitura pública ainda devolvia o
 * registro sem unidade — o que fazia a fase de agendamento criar unidade
 * duplicada a cada execução, travando inventário de novo e de novo.
 */
/**
 * Apaga um objeto do bucket.
 *
 * Existe para o registro do dia: quando ele aponta para um estado que não vale
 * mais — uma unidade de teste já cancelada, um dia que precisa ser refeito do
 * zero — apagar devolve a data ao ponto de partida, e a fase 1 grava um registro
 * novo na próxima execução. Apagar é mais seguro que remendar campo a campo,
 * porque a fase 2 trata "sem registro" como "nada a fazer" e fica quieta.
 */
export async function apagar(caminho: string): Promise<boolean> {
  const { url, key, bucket } = supabaseConfig();
  const res = await fetch(`${url}/storage/v1/object/${bucket}/${caminho}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${key}` },
  });
  // 400 e 404 são as duas formas de "não existe" que este Storage devolve — a
  // leitura trata as duas assim há tempos, e apagar o que já não está lá não é
  // erro.
  if (res.status === 404 || res.status === 400) return false;
  if (!res.ok) throw new Error(`falha ao apagar ${caminho} (HTTP ${res.status})`);
  return true;
}

export async function lerJson<T>(caminho: string): Promise<T | null> {
  const { url, key, bucket } = supabaseConfig();
  /*
   * O parâmetro descartável não é paranoia: medido em 18/08/2026, depois de
   * apagar o registro do dia a leitura pelo endpoint autenticado continuou
   * devolvendo o conteúdo antigo por cerca de um minuto, mesmo com
   * `cache: "no-store"`. Alguma camada entre nós e o objeto guarda resposta.
   *
   * Um minuto de atraso importa porque o cron roda a cada minuto e a trava
   * contra unidade duplicada depende desta leitura ser fresca: duas execuções
   * lendo a mesma versão velha se acham as duas a primeira, e nascem duas
   * unidades travando as mesmas telas. Já aconteceu por outro caminho.
   */
  const semCache = `?_=${Date.now()}`;
  const res = await fetch(`${url}/storage/v1/object/${bucket}/${caminho}${semCache}`, {
    headers: { Authorization: `Bearer ${key}`, "Cache-Control": "no-cache" },
    cache: "no-store",
  });
  if (res.status === 404 || res.status === 400) return null;
  if (!res.ok) throw new Error(`falha ao ler ${caminho} (HTTP ${res.status})`);
  return (await res.json()) as T;
}
