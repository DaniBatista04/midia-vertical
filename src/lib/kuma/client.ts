/**
 * Cliente da API do Kuma (chamada de "Brato" nos endpoints), com só o que a
 * automação do clima precisa: submeter um grupo criativo e consultar a
 * auditoria dele.
 *
 * O que NÃO está aqui é deliberado. Pedido (`createOrder`) e estratégia
 * (`createOrderStrategy`) existem na API e funcionam, mas o processo do time
 * cria a programação pelo portal — inclusive porque o tipo de unidade
 * (obrigatória × reserva preemptível) não tem campo em chamada nenhuma. A
 * automação para onde o processo manual começa: depositar o grupo criativo na
 * conta certa, para ele aparecer na Análise Criativa junto com o resto.
 *
 * Três comportamentos da API que valem lembrar ao mexer aqui:
 *
 *  1. Erro de validação vem como **HTTP 200 com `errorCode` negativo**, não
 *     como 4xx. Tratar -5 como falha de rede e repetir a chamada é gastar
 *     tentativa à toa: o parâmetro vai continuar inválido.
 *  2. Algumas respostas vêm embrulhadas em `{ success, errorCode, data }` e
 *     outras vêm cruas. O `unwrap` abaixo aceita as duas formas.
 *  3. Não existe endpoint para ler a estratégia nem para listar material de
 *     forma confiável, então quem chama precisa guardar o próprio registro do
 *     que enviou.
 */

export const KUMA_PRODUCT = "SMART_SCREEN";

export type KumaAudit = {
  /** 1 pendente · 3 aprovado · 4 reprovado · 502 falha de geração/spec. */
  status: number;
  feedback: string | null;
  lastmod: number;
};

export type KumaMaterial = {
  id: string;
  iurl: string;
  filename: string;
  display: { duration: number; mime: "video/mp4" | "image/jpeg" };
};

export type KumaCreative = {
  devicestyle: "smart19" | "smart25" | "smart32" | "smart55";
  materials: KumaMaterial[];
};

export type KumaCreativeGroupRequest = {
  name?: string;
  duration: number;
  creatives: KumaCreative[];
};

export type KumaCreativeGroup = {
  id: string;
  audit: KumaAudit;
  lastmod: number;
};

export class KumaError extends Error {
  /** `errorCode` de negócio, quando a resposta trouxe um. */
  readonly code?: number;
  readonly httpStatus?: number;

  constructor(message: string, opts: { code?: number; httpStatus?: number } = {}) {
    super(message);
    this.name = "KumaError";
    this.code = opts.code;
    this.httpStatus = opts.httpStatus;
  }
}

export type KumaConfig = { baseUrl: string; apiKey: string; bidderId: string };

/**
 * Lê a configuração do ambiente. Sem valor padrão de propósito: o repositório
 * é público, e chave commitada é chave vazada.
 */
export function kumaConfig(bidderId?: string): KumaConfig {
  const baseUrl = process.env.KUMA_API_URL ?? "";
  const apiKey = process.env.KUMA_API_KEY ?? "";
  // Cada linha de conteúdo tem a própria conta no Kuma — o clima na Weather, a
  // notícia na News. As contas já existem, criadas pela equipe da Brato.
  const conta = bidderId ?? process.env.KUMA_BIDDER_WEATHER ?? "";
  if (!baseUrl || !apiKey || !conta) {
    throw new KumaError(
      "Configuração do Kuma incompleta — defina KUMA_API_URL, KUMA_API_KEY e a conta " +
        "(KUMA_BIDDER_WEATHER para o clima, KUMA_BIDDER_NEWS para a notícia).",
    );
  }
  return { baseUrl, apiKey, bidderId: conta };
}

/** Aceita tanto `{ data: {...} }` quanto o objeto cru. */
function unwrap<T>(body: unknown, temCampo: string): T {
  const obj = body as Record<string, unknown> | null;
  if (obj && typeof obj === "object") {
    if (temCampo in obj) return obj as T;
    const inner = obj.data;
    if (inner && typeof inner === "object" && temCampo in (inner as object)) return inner as T;
  }
  throw new KumaError(`Resposta do Kuma sem campo '${temCampo}': ${JSON.stringify(body).slice(0, 300)}`);
}

async function chamadaUnica<T>(
  cfg: KumaConfig,
  method: "GET" | "POST",
  path: string,
  body?: unknown,
): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${cfg.baseUrl}${path}`, {
      method,
      headers: { "x-api-key": cfg.apiKey, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (e) {
    throw new KumaError(`Falha de rede em ${method} ${path}: ${e instanceof Error ? e.message : String(e)}`);
  }

  const texto = await res.text();
  let json: unknown;
  try {
    json = JSON.parse(texto);
  } catch {
    throw new KumaError(`Resposta não-JSON em ${method} ${path}: ${texto.slice(0, 300)}`, {
      httpStatus: res.status,
    });
  }

  const obj = (json ?? {}) as Record<string, unknown>;
  if (!res.ok) {
    throw new KumaError(`${method} ${path} devolveu HTTP ${res.status}: ${String(obj.message ?? texto).slice(0, 300)}`, {
      httpStatus: res.status,
    });
  }
  // HTTP 200 com errorCode negativo é o formato de erro de negócio da API.
  const code = Number(obj.errorCode ?? obj.code);
  if (obj.success === false || (Number.isFinite(code) && code < 0)) {
    throw new KumaError(
      `${path} recusado pelo Kuma (errorCode ${code}): ${String(obj.message || obj.msg || "sem mensagem")}`,
      { code, httpStatus: res.status },
    );
  }
  return json as T;
}

/**
 * Repete só o que pode melhorar sozinho: 5xx e falha de rede. Os serviços
 * internos do Kuma respondem 500 de vez em quando — já vi um
 * `portal-server-merlion ... failed to respond` que passou na tentativa
 * seguinte, sem mudar nada no payload.
 *
 * Erro de negócio (`errorCode`) nunca é repetido: o parâmetro vai continuar
 * inválido, e insistir só gasta tentativa e polui o log deles.
 *
 * **Criação nunca é repetida** (`tentativas = 1`). Um 5xx do Kuma não significa
 * que nada foi criado: a auditoria do time mostrou que `campaign/create`
 * devolve erro *e cria o plano*, e o Mural tem cicatriz de "pedido fantasma"
 * nascida de timeout em `createOrder`. Repetir cegamente acumula unidade
 * duplicada travando inventário — pior que falhar e avisar.
 */
async function call<T>(
  cfg: KumaConfig,
  method: "GET" | "POST",
  path: string,
  body?: unknown,
  tentativas = 3,
): Promise<T> {
  for (let i = 1; ; i++) {
    try {
      return await chamadaUnica<T>(cfg, method, path, body);
    } catch (e) {
      const err = e instanceof KumaError ? e : new KumaError(String(e));
      const transitorio = err.code === undefined && (err.httpStatus ?? 500) >= 500;
      if (!transitorio || i >= tentativas) throw err;
      console.warn(`[kuma] ${method} ${path} falhou (tentativa ${i}/${tentativas}): ${err.message}`);
      await new Promise((r) => setTimeout(r, 5_000 * i));
    }
  }
}

/** Submete um grupo criativo. Cada submissão cria um grupo novo. */
export async function submitCreativeGroup(
  req: KumaCreativeGroupRequest,
  cfg: KumaConfig = kumaConfig(),
): Promise<KumaCreativeGroup> {
  // Sem retry: submissão repetida gera grupo duplicado e, com o mesmo nome de
  // arquivo, o segundo é reprovado com 502 sem motivo.
  const body = await call<unknown>(cfg, "POST", `/management/v1/bidder/${cfg.bidderId}/creativeGroups`, req, 1);
  return unwrap<KumaCreativeGroup>(body, "id");
}

/** Consulta a auditoria de um grupo pelo ID. */
export async function getCreativeGroup(
  id: string,
  cfg: KumaConfig = kumaConfig(),
): Promise<KumaCreativeGroup> {
  const body = await call<unknown>(cfg, "GET", `/management/v1/bidder/${cfg.bidderId}/creativeGroups/${id}`);
  return unwrap<KumaCreativeGroup>(body, "audit");
}

/** Rótulo legível para o status de auditoria. */
export function descreverAuditoria(status: number): string {
  switch (status) {
    case 1:
      return "em análise";
    case 3:
      return "aprovado";
    case 4:
      return "reprovado";
    case 502:
      return "falha de geração (material fora do spec ou URL ilegível)";
    default:
      return `status ${status}`;
  }
}

/* ══════════════════════════════════════════════════════════════════════════
   Pedido e estratégia — a "unidade" do portal
   ══════════════════════════════════════════════════════════════════════════

   O time cria uma unidade por dia e amarra nela o grupo criativo daquele dia.
   É o mesmo par de chamadas que a integração do Mural usa em produção, e o
   que ela NÃO permite escolher é o tipo de unidade: por API a unidade nasce do
   tipo comum, que trava inventário. Reserva preemptível só pelo portal.        */

/**
 * Janela de veiculação, em horas cheias (`投放时段，包括哪些小时` no contrato).
 *
 * As telas da rede tocam comunicado em janelas de duas horas — 10h–12h,
 * 12h–14h, e assim por diante. Cada hora entra pelo número dela, então a
 * janela das 16h às 18h é `[16, 17]`.
 *
 * Omitir o campo deixa a decisão com o Kuma, que é como a automação do clima
 * funcionou até existir motivo para escolher.
 */
export type Horas = number[];

export type InventarioRequest = {
  cityId: string;
  /** IDs de tela (`locationId`). */
  targetIds: string[];
  /** `YYYY-MM-DD`. */
  startDate: string;
  endDate: string;
  durationInSecond: number;
  /** Exibições por dia por tela. Múltiplo de 300. */
  frequency: number;
  /**
   * Existe no contrato, mas **não use**: o gateway devolve HTTP 400 com
   * `UnsupportedOperationException` ao desserializar este campo aqui — bug do
   * lado deles, medido em 18/08/2026. No `createOrder` o mesmo campo funciona.
   */
  hours?: Horas;
};

/** Devolve o subconjunto de telas com inventário no período. */
export async function inquireSufficientTargets(
  req: InventarioRequest,
  cfg: KumaConfig = kumaConfig(),
): Promise<string[]> {
  const body = await call<Record<string, unknown>>(cfg, "POST", "/v1/inventory/inquireSufficientTargets", {
    bidderId: cfg.bidderId,
    productName: KUMA_PRODUCT,
    targetType: "LOCATION",
    ...req,
  });
  const dados = (body.data ?? body) as Record<string, unknown>;
  return (dados.targetIds ?? []) as string[];
}

export type PedidoRequest = {
  cityId: string;
  targetIds: string[];
  /** Quantas telas travar. Nunca maior que `targetIds.length`. */
  goalLocationNum: number;
  startDate: string;
  endDate: string;
  durationInSecond: number;
  frequency: number;
  /** Janela de veiculação. Ver `Horas`. */
  hours?: Horas;
};

/**
 * Cria a unidade. Erros que aparecem aqui e valem reconhecer:
 * `-8` inventário insuficiente (frequência alta demais para as telas pedidas),
 * `-6` trava de publicação, `-7` fora do prazo de operação.
 */
export async function createOrder(
  req: PedidoRequest,
  cfg: KumaConfig = kumaConfig(),
): Promise<string> {
  const { cityId, targetIds, goalLocationNum, ...resto } = req;
  const body = await call<Record<string, unknown>>(cfg, "POST", "/v1/adgroup/createOrder", {
    bidderId: cfg.bidderId,
    productName: KUMA_PRODUCT,
    dsp: false,
    ...resto,
    orderItems: [{ cityId, targetIds, goalLocationNum }],
  }, 1);
  const orderId = (body.orderId ?? (body.data as Record<string, unknown> | undefined)?.orderId) as
    | string
    | undefined;
  if (!orderId) {
    throw new KumaError(`Kuma não devolveu orderId: ${JSON.stringify(body).slice(0, 300)}`);
  }
  return orderId;
}

/**
 * Amarra grupos criativos à unidade.
 *
 * A chamada substitui a estratégia inteira, então quem chama precisa mandar
 * todos os grupos que devem tocar — omitir um o remove. Lista vazia é recusada
 * com HTTP 400: para tirar algo do ar é preciso pôr outra coisa no lugar.
 *
 * O grupo precisa estar **aprovado**; com auditoria pendente a resposta é `-12`.
 */
export async function createOrderStrategy(
  orderId: string,
  creativeGroupIds: string[],
  cfg: KumaConfig = kumaConfig(),
): Promise<void> {
  if (creativeGroupIds.length === 0) {
    throw new KumaError("createOrderStrategy exige ao menos um grupo criativo.");
  }
  await call(cfg, "POST", "/v1/adstrategy/createOrderStrategy", {
    bidderId: cfg.bidderId,
    orderId,
    creativeGroupIds,
  });
}

export type PedidoDetalhe = {
  orderId: string;
  orderStatus: "PENDING" | "WAIT" | "SHOW" | "FINISH" | "TERMINATED" | "CANCELLED";
  startDate: string;
  endDate: string;
  frequency: number;
  durationInSecond: number;
  hasDefaultAdStrategy: boolean;
  orderItems: { cityId: string; goalLocationNum: number; targetIds: string[]; reservedLocationIds?: string[] }[];
};

/** Consulta a unidade. Só devolve pedido da própria conta. */
export async function getOrderDetail(
  orderId: string,
  cfg: KumaConfig = kumaConfig(),
): Promise<PedidoDetalhe> {
  const body = await call<Record<string, unknown>>(cfg, "POST", "/v1/adgroup/getOrderDetail", {
    bidderId: cfg.bidderId,
    orderId,
  });
  const raw = (body.data ?? body) as Record<string, unknown>;
  const pedido = raw.orderResult as PedidoDetalhe | undefined;
  if (!pedido) throw new KumaError(`Kuma não devolveu orderResult: ${JSON.stringify(body).slice(0, 300)}`);
  return pedido;
}

/* ══════════════════════════════════════════════════════════════════════════
   Catálogo — só o que a automação usa para resolver telas
   ══════════════════════════════════════════════════════════════════════════ */

export type Localizacao = {
  locationId: string;
  buildingId: string;
  buildingName: string;
  deviceStyleId: string;
  deviceStyleName: string;
  locationDesc: string;
};

export type Predio = { buildingId: string; buildingName: string };

/**
 * Todos os prédios de uma cidade, paginando até o fim.
 *
 * A rota é paginada (`pageNo`/`pageSize`) e devolve `totalPage`, então quem
 * quiser a cidade inteira precisa percorrer. O teto de páginas existe para um
 * `totalPage` absurdo — ou um laço que não termina — não virar milhares de
 * chamadas sem ninguém olhando.
 */
export async function getBuildings(
  cityId: string,
  cfg: KumaConfig = kumaConfig(),
  pageSize = 200,
  maxPaginas = 100,
): Promise<Predio[]> {
  const predios: Predio[] = [];
  for (let pageNo = 1; pageNo <= maxPaginas; pageNo++) {
    const body = await call<Record<string, unknown>>(cfg, "POST", "/v1/adresource/getBuildingInfos", {
      cityId,
      productName: KUMA_PRODUCT,
      pageNo,
      pageSize,
    });
    const dados = (body.data ?? body) as Record<string, unknown>;
    const lista = ((dados.result ?? []) as Record<string, unknown>[]) ?? [];
    for (const p of lista) {
      predios.push({
        buildingId: String(p.buildingId),
        buildingName: String(p.buildingName ?? ""),
      });
    }
    const totalPage = Number(dados.totalPage ?? 1);
    if (!lista.length || pageNo >= totalPage) break;
  }
  return predios;
}

/** Telas de um ou mais prédios. `targetIds` são `buildingId`. */
export async function getValidLocations(
  cityId: string,
  buildingIds: string[],
  cfg: KumaConfig = kumaConfig(),
): Promise<Localizacao[]> {
  const body = await call<Record<string, unknown>>(cfg, "POST", "/v1/adresource/getValidLocationInfos", {
    cityId,
    productName: KUMA_PRODUCT,
    targetIds: buildingIds,
    targetType: "BUILDING",
  });
  const lista = ((body.data ?? []) as Record<string, unknown>[]) ?? [];
  return lista.map((l) => ({
    locationId: String(l.locationId),
    buildingId: String(l.buildingId),
    buildingName: String(l.buildingName ?? ""),
    deviceStyleId: String(l.deviceStyleId),
    deviceStyleName: String(l.deviceStyleName ?? ""),
    locationDesc: String(l.locationDesc ?? ""),
  }));
}

/**
 * Renomeia o plano.
 *
 * O `createOrder` não recebe nome, então o plano nasce com o rótulo que o Kuma
 * escolher — e quem opera precisa achá-lo na lista pela data de veiculação. O
 * `campaign/modify` (修改计划) aceita `adCampaignName`, e o id do plano é o
 * mesmo que o `createOrder` devolve: os dois vivem no espaço `{referId}_{n}`.
 */
export async function renomearPlano(
  adCampaignId: string,
  adCampaignName: string,
  cfg: KumaConfig = kumaConfig(),
): Promise<void> {
  await call(cfg, "POST", "/v1/adgroup/campaign/modify", { adCampaignId, adCampaignName });
}

/** Cancela a unidade. Sujeito ao prazo de operação e à trava de publicação. */
export async function cancelOrder(orderId: string, cfg: KumaConfig = kumaConfig()): Promise<void> {
  await call(cfg, "POST", "/v1/adgroup/cancelOrder", { bidderId: cfg.bidderId, orderId });
}
