"use client";

import {
  useEffect,
  useRef,
  useState,
  type DragEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";

import type { DiaNoticias, EnvioDoDia } from "@/app/api/noticias/dia/route";
import { proxiedImage } from "@/lib/news/draw";
import type { NewsItem } from "@/lib/news/spec";
import { caixaDaHora as caixaPedida, FIM_DIA, rotuloHora } from "@/lib/kuma/noticiaCaixas";

/**
 * A programação do dia: a linha do tempo com as janelas e, embaixo, uma caixa
 * por janela com as suas vagas.
 *
 * Mostra junto o que já foi enviado (vem do servidor, em `dia`) e o que está
 * marcado na fila e ainda não foi (`alocacao`, local). Só o que não foi enviado
 * se arrasta: o envio já tem grupo criativo com a caixa gravada.
 */

export const CORES_CAIXA = [
  "#5ce3ff", "#b18cff", "#ffb347", "#7dff9a", "#ff7ab6", "#ffe066",
  "#6f9bff", "#ff8f6b", "#4de0c0", "#d78cff", "#c6f06b", "#ffa8d0",
];

type Props = {
  items: NewsItem[];
  /** Índice do feed → caixa, para o que está na fila e não foi enviado. */
  alocacao: Map<number, number>;
  caixas: number;
  maxCaixas: number;
  vagas: number;
  cortes: number[];
  /** Hora em que o pack 1 entra; antes dela fica o último. */
  inicio: number;
  dia: DiaNoticias | null;
  carregando: boolean;
  /** Quando o dia foi lido por último (ms), para o "atualizado há". */
  lidoEm: number | null;
  /** A última leitura do dia falhou. */
  falhaLeitura: boolean;
  /** Envio em andamento: o painel mostra o progresso e a notícia que está subindo. */
  enviando: { feitas: number; total: number; item: number } | null;
  busy: boolean;
  selIdx: number | null;
  horariosPendentes: boolean;
  onMover: (item: number, caixa: number, trocarCom?: number) => void;
  onRemover: (item: number) => void;
  /** Tira do pack uma notícia já enviada. */
  onRetirar: (id: string, titulo: string) => void;
  onSelecionar: (item: number) => void;
  onCortes: (cortes: number[]) => void;
  onInicio: (inicio: number) => void;
  onNovaCaixa: () => void;
  onDuasHoras: () => void;
  onRemoverCaixa: (caixa: number) => void;
  onEnviar: () => void;
  onSalvarHorarios: () => void;
  onAtualizar: () => void;
};

/** `rotulo` cabe no selo do card; `detalhe` vai na linha de baixo (minutos, horário). */
type Selo = { rotulo: string; detalhe?: string; classe: string; dica: string; passo: number };

/**
 * O selo de uma notícia enviada: em que etapa está, em palavras de quem opera,
 * e o que falta. `passo` alimenta a barrinha de três etapas do card — subir,
 * aprovar, ir ao ar.
 */
function seloDoEnvio(
  e: EnvioDoDia,
  estadoPack: "live" | "passou" | "vem",
  entraAs: number,
  agora: number,
): Selo {
  switch (e.etapa) {
    case "propagando": {
      const faltam = e.submeteEm ? Math.ceil((Date.parse(e.submeteEm) - agora) / 60_000) : null;
      return {
        rotulo: "Subindo",
        detalhe: faltam && faltam > 0 ? `análise em ${faltam} min` : "indo para a análise",
        classe: "sub",
        dica:
          "O material está propagando no Storage. O grupo criativo vai para a Análise Criativa " +
          (faltam && faltam > 0 ? `em cerca de ${faltam} min.` : "no próximo minuto."),
        passo: 1,
      };
    }
    case "em-aprovacao":
      return {
        rotulo: "Aprovar",
        detalhe: "no portal do Kuma",
        classe: "apr",
        dica: "Está na Análise Criativa do portal do Kuma, esperando aprovação.",
        passo: 2,
      };
    case "no-plano":
      if (e.noAr) return { rotulo: "No ar", classe: "noar", dica: "Está na lista que o Kuma toca agora.", passo: 3 };
      if (estadoPack === "vem") {
        return {
          rotulo: "Aprovada",
          detalhe: `entra às ${rotuloHora(entraAs)}`,
          classe: "ok",
          dica: `Aprovada. Entra no ar com o pack, às ${rotuloHora(entraAs)}.`,
          passo: 3,
        };
      }
      if (estadoPack === "live") {
        return {
          rotulo: "Aprovada",
          detalhe: "entrando no ar…",
          classe: "ok",
          dica: "Aprovada. O sistema coloca ela na lista do Kuma no próximo minuto.",
          passo: 3,
        };
      }
      return {
        rotulo: "Aprovada",
        detalhe: "janela encerrada",
        classe: "ok",
        dica: "Aprovada. A janela do pack já passou.",
        passo: 3,
      };
    default:
      return { rotulo: "Parada", classe: "err", dica: e.erro ?? "", passo: 0 };
  }
}

/** `42` → "há 42 s"; `130` → "há 2 min". */
function ha(segundos: number): string {
  if (segundos < 60) return `há ${Math.max(0, Math.round(segundos))} s`;
  return `há ${Math.floor(segundos / 60)} min`;
}

/*
 * A linha do tempo mostra o dia inteiro, e não só a partir do início: o que vem
 * antes do pack 1 é do último, e o operador precisa ver isso para escolher o
 * início.
 */
const HORAS = FIM_DIA;
const pct = (h: number) => `${(Math.min(Math.max(h, 0), FIM_DIA) / HORAS) * 100}%`;

export function NewsBoxes(p: Props) {
  const [aberto, setAberto] = useState(true);
  const [alvo, setAlvo] = useState<number | null>(null);
  const trilho = useRef<HTMLDivElement>(null);
  const [agora, setAgora] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setAgora(Date.now()), 5_000);
    return () => clearInterval(t);
  }, []);

  const enviados = (p.dia?.envios ?? []).filter((e) => e.etapa !== "parado" && e.etapa !== "retirada");
  const retiradas = (p.dia?.envios ?? []).filter((e) => e.etapa === "retirada");
  const parados = (p.dia?.envios ?? []).filter((e) => e.etapa === "parado");
  const subindo = enviados.filter((e) => e.etapa === "propagando").length;
  const aprovar = enviados.filter((e) => e.etapa === "em-aprovacao").length;
  const aprovadas = enviados.filter((e) => e.etapa === "no-plano").length;
  const pendentes = [...p.alocacao.entries()];
  const hora = p.dia?.hora ?? null;
  const caixaDaHora = hora === null ? null : caixaPedida(p.cortes, hora, p.inicio);
  /** Madrugada: o último pack segue no ar, e os outros ainda estão por vir. */
  const antesDoInicio = hora !== null && hora < p.inicio && p.caixas > 1;
  const noAr = p.dia?.caixaNoAr ?? null;
  const volta = p.caixas > 1 && p.inicio > 0;

  const janela = (c: number) => ({
    inicio: c === 1 ? (p.caixas === 1 ? 0 : p.inicio) : p.cortes[c - 2],
    fim: c === p.caixas ? FIM_DIA : p.cortes[c - 1],
  });

  /* ── Arrastar um divisor: o início do pack 1 (`i = -1`) ou uma troca ── */
  const arrastarCorte = (i: number) => (ev: ReactPointerEvent<HTMLDivElement>) => {
    ev.preventDefault();
    const el = trilho.current;
    if (!el) return;
    const alvoEl = ev.currentTarget;
    alvoEl.setPointerCapture(ev.pointerId);
    const mover = (e: PointerEvent) => {
      const r = el.getBoundingClientRect();
      const h = ((e.clientX - r.left) / r.width) * HORAS;
      // Hora cheia, com pelo menos uma hora de janela. A faixa do Kuma vira
      // em hora par, então um corte em hora ímpar chega à tela na virada
      // seguinte — mas a escolha é da operação.
      let alvoH = Math.round(h);
      if (i < 0) {
        alvoH = Math.min(Math.max(alvoH, 0), (p.cortes[0] ?? FIM_DIA) - 1);
        if (alvoH !== p.inicio) p.onInicio(alvoH);
        return;
      }
      const min = (i === 0 ? p.inicio : p.cortes[i - 1]) + 1;
      const max = (i === p.cortes.length - 1 ? FIM_DIA : p.cortes[i + 1]) - 1;
      alvoH = Math.min(Math.max(alvoH, min), max);
      if (alvoH !== p.cortes[i]) p.onCortes(p.cortes.map((c, k) => (k === i ? alvoH : c)));
    };
    const soltar = () => {
      alvoEl.removeEventListener("pointermove", mover);
      alvoEl.removeEventListener("pointerup", soltar);
      alvoEl.removeEventListener("pointercancel", soltar);
    };
    alvoEl.addEventListener("pointermove", mover);
    alvoEl.addEventListener("pointerup", soltar);
    alvoEl.addEventListener("pointercancel", soltar);
  };

  /* ── Drag & drop das notícias pendentes ───────────────────── */
  const aoArrastar = (item: number) => (e: DragEvent) => {
    e.dataTransfer.setData("text/plain", String(item));
    e.dataTransfer.effectAllowed = "move";
  };
  const soltarEm = (caixa: number, trocarCom?: number) => (e: DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setAlvo(null);
    const item = Number(e.dataTransfer.getData("text/plain"));
    if (Number.isInteger(item)) p.onMover(item, caixa, trocarCom);
  };

  const totalPendentes = pendentes.length;
  const caixasUsadas = new Set(pendentes.map(([, c]) => c)).size;

  return (
    <section className={`boxes-dock${aberto ? "" : " fechado"}`}>
      <header className="boxes-head">
        <button className="boxes-toggle" onClick={() => setAberto((a) => !a)} title={aberto ? "Recolher" : "Abrir"}>
          <span className={`chev${aberto ? " on" : ""}`}>▸</span>
          <span className="boxes-title">Programação do dia</span>
          {p.dia && (
            <span className="boxes-date">
              {p.dia.data.split("-").reverse().join("/")}
            </span>
          )}
        </button>

        {!p.dia ? (
          <div className="boxes-resumo">
            <span className={p.falhaLeitura ? "boxes-lido err" : "boxes-lido"}>
              {p.falhaLeitura ? "não deu para ler a programação" : <><span className="spinner mini" /> lendo a programação…</>}
            </span>
          </div>
        ) : (
        <div className="boxes-resumo">
          {subindo > 0 && (
            <span className="etapa-chip sub" title="Material propagando; vai para a Análise Criativa em ~10 min">
              <i /> {subindo} subindo
            </span>
          )}
          {aprovar > 0 && (
            <span className="etapa-chip apr" title="Esperando aprovação na Análise Criativa do portal do Kuma">
              <i /> {aprovar} para aprovar no Kuma
            </span>
          )}
          <span className="etapa-chip ok" title="Aprovadas e no plano do dia">
            <i /> {aprovadas} aprovada{aprovadas === 1 ? "" : "s"}
          </span>
          <span className="sep" />
          <span><b>{totalPendentes}</b> na fila</span>
          <span className="sep" />
          <span><b>{p.caixas}</b> pack{p.caixas === 1 ? "" : "s"}</span>
          {noAr !== null && (
            <span className="boxes-noar" style={{ ["--c" as string]: CORES_CAIXA[noAr - 1] }}>
              <i /> Pack {noAr} no ar
            </span>
          )}
        </div>
        )}

        <div className="boxes-acoes">
          <button className="btn btn-ghost btn-sm" onClick={p.onDuasHoras} disabled={p.busy || !p.dia}
            title="Divide o dia em packs de 2 horas, a partir do início do pack 1">
            De 2 em 2 h
          </button>
          <span className={`boxes-lido${p.falhaLeitura ? " err" : ""}`}>
            {p.falhaLeitura
              ? "falha ao atualizar"
              : p.lidoEm !== null
                ? `atualizado ${ha((agora - p.lidoEm) / 1000)}`
                : ""}
          </span>
          <button className="btn btn-ghost btn-sm" onClick={p.onAtualizar} disabled={p.carregando}
            title="Relê o que já foi enviado hoje">
            {p.carregando ? <span className="spinner" /> : "↻"}
          </button>
          {p.horariosPendentes && !totalPendentes && (
            <button className="btn btn-ghost btn-sm" onClick={p.onSalvarHorarios} disabled={p.busy}>
              Salvar horários
            </button>
          )}
          <button className="btn btn-accent btn-sm boxes-enviar" onClick={p.onEnviar}
            disabled={!totalPendentes || p.busy}>
            {p.enviando ? (
              <><span className="spinner" /> Enviando {p.enviando.feitas + 1} de {p.enviando.total}…</>
            ) : (
              <>
                🚀 Enviar {totalPendentes || ""} {totalPendentes === 1 ? "notícia" : "notícias"}
                {caixasUsadas > 1 ? ` em ${caixasUsadas} packs` : ""}
              </>
            )}
          </button>
        </div>
      </header>

      {p.enviando && (
        <div className="boxes-progresso" title={`${p.enviando.feitas} de ${p.enviando.total} enviadas`}>
          <i style={{ width: `${(p.enviando.feitas / p.enviando.total) * 100}%` }} />
        </div>
      )}

      {aberto && !p.dia && (
        <div className="boxes-body">
          {p.falhaLeitura ? (
            <div className="boxes-falha">
              Não deu para ler a programação do dia.
              <button className="btn btn-ghost btn-sm" onClick={p.onAtualizar} disabled={p.carregando}>
                {p.carregando ? <span className="spinner" /> : "Tentar de novo"}
              </button>
            </div>
          ) : (
            <div className="boxes-skel" aria-label="Lendo a programação do dia">
              <div className="skel skel-trilho" />
              <div className="bx-row">
                {[0, 1].map((k) => (
                  <div key={k} className="bx bx-skel">
                    <div className="skel skel-line" />
                    <div className="bx-slots">
                      {[0, 1, 2, 3].map((s) => <div key={s} className="slot skel" />)}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {aberto && p.dia && (
        <div className="boxes-body">
          {/* ── Linha do tempo ───────────────────────────────── */}
          <div className="tl">
            <div className="tl-track" ref={trilho}>
              {Array.from({ length: p.caixas }, (_, k) => {
                const c = k + 1;
                const j = janela(c);
                const live = noAr === c && !(antesDoInicio && c === p.caixas);
                return (
                  <div
                    key={c}
                    className={`tl-seg${live ? " live" : ""}`}
                    style={{
                      left: pct(j.inicio),
                      width: `calc(${pct(j.fim)} - ${pct(j.inicio)})`,
                      ["--c" as string]: CORES_CAIXA[k],
                    }}
                  >
                    <span className="tl-seg-lbl">
                      Pack {c}
                      <em>{rotuloHora(j.inicio)} – {rotuloHora(j.fim)}</em>
                    </span>
                  </div>
                );
              })}

              {volta && (
                <div
                  className={`tl-seg volta${antesDoInicio && noAr === p.caixas ? " live" : ""}`}
                  style={{
                    left: pct(0),
                    width: pct(p.inicio),
                    ["--c" as string]: CORES_CAIXA[p.caixas - 1],
                  }}
                  title={`Antes do pack 1 segue o pack ${p.caixas}, da noite anterior`}
                >
                  <span className="tl-seg-lbl">
                    ↺ {p.caixas}
                    <em>{rotuloHora(0)} – {rotuloHora(p.inicio)}</em>
                  </span>
                </div>
              )}

              {p.caixas > 1 && (
                <div
                  className="tl-cut tl-ini"
                  style={{ left: pct(p.inicio) }}
                  onPointerDown={arrastarCorte(-1)}
                  title="Arraste para mudar a hora em que o pack 1 entra"
                >
                  <span className="tl-cut-knob" />
                  <span className="tl-cut-lbl">{rotuloHora(p.inicio)}</span>
                </div>
              )}

              {p.cortes.map((h, i) => (
                <div
                  key={i}
                  className="tl-cut"
                  style={{ left: pct(h) }}
                  onPointerDown={arrastarCorte(i)}
                  title="Arraste para mudar a hora da troca"
                >
                  <span className="tl-cut-knob" />
                  <span className="tl-cut-lbl">{rotuloHora(h)}</span>
                </div>
              ))}

              {hora !== null && (
                <div className="tl-now" style={{ left: pct(hora) }}>
                  <span className="tl-now-dot" />
                  <span className="tl-now-lbl">
                    agora · {String(Math.floor(hora)).padStart(2, "0")}:{String(Math.round((hora % 1) * 60)).padStart(2, "0")}
                  </span>
                </div>
              )}
            </div>
            <div className="tl-ticks">
              {Array.from({ length: HORAS / 2 + 1 }, (_, k) => k * 2).map((h) => (
                <span key={h} style={{ left: pct(h) }}>{rotuloHora(h)}</span>
              ))}
            </div>
          </div>

          {/* ── Caixas ───────────────────────────────────────── */}
          <div className="bx-row">
            {Array.from({ length: p.caixas }, (_, k) => {
              const c = k + 1;
              const j = janela(c);
              const deles = enviados.filter((e) => e.caixa === c);
              const meus = pendentes.filter(([, cx]) => cx === c).map(([i]) => i);
              const ocupadas = deles.length + meus.length;
              const livres = Math.max(0, p.vagas - ocupadas);
              const cheia = livres === 0;
              const repete = ocupadas === 3 && p.vagas === 4;
              const estado =
                noAr === c
                  ? "live"
                  : !antesDoInicio && caixaDaHora !== null && c < caixaDaHora
                    ? "passou"
                    : "vem";
              return (
                <div
                  key={c}
                  className={`bx bx-${estado}${alvo === c ? " drop" : ""}${cheia ? " cheia" : ""}`}
                  style={{ ["--c" as string]: CORES_CAIXA[k] }}
                  onDragOver={(e) => {
                    if (cheia) return;
                    e.preventDefault();
                    setAlvo(c);
                  }}
                  onDragLeave={() => setAlvo((a) => (a === c ? null : a))}
                  onDrop={soltarEm(c)}
                >
                  <div className="bx-head">
                    <span className="bx-num">{c}</span>
                    <div className="bx-tit">
                      <strong>Pack {c}</strong>
                      <span>
                        {rotuloHora(j.inicio)} → {rotuloHora(j.fim)}
                        {volta && c === p.caixas && <> · {rotuloHora(0)} → {rotuloHora(p.inicio)}</>}
                      </span>
                    </div>
                    <span className={`bx-badge ${estado}`}>
                      {estado === "live" ? <><i /> No ar</> : estado === "passou" ? "Encerrada" : "A seguir"}
                    </span>
                    {!ocupadas && p.caixas > 1 && c === p.caixas && (
                      <button className="bx-x" onClick={() => p.onRemoverCaixa(c)} title="Remover pack vazio">×</button>
                    )}
                  </div>

                  <div className="bx-slots">
                    {deles.map((e) => {
                      const selo = seloDoEnvio(e, estado, j.inicio, agora);
                      return (
                      <div key={e.id} className={`slot enviado${e.noAr ? " noar" : ""}`}
                        title={`${e.titulo}\n\n${selo.dica}`}>
                        {e.miniatura ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img src={e.miniatura} alt="" loading="lazy" />
                        ) : (
                          <div className="slot-ph">📰</div>
                        )}
                        <span className={`slot-etapa ${selo.classe}`}>
                          <i />
                          {selo.rotulo}
                        </span>
                        {selo.detalhe && <span className="slot-etapa-det">{selo.detalhe}</span>}
                        <span className="slot-tit">{e.titulo}</span>
                        <span className="slot-passos" aria-hidden>
                          {[1, 2, 3].map((n) => (
                            <i key={n} className={n < selo.passo ? "feito" : n === selo.passo ? `atual ${selo.classe}` : ""} />
                          ))}
                        </span>
                        <button
                          className="slot-x"
                          onClick={() => p.onRetirar(e.id, e.titulo)}
                          disabled={p.busy}
                          title="Tirar do pack — sai do ar e libera a vaga"
                        >
                          ×
                        </button>
                      </div>
                      );
                    })}

                    {meus.map((i) => {
                      const it = p.items[i];
                      if (!it) return null;
                      return (
                        <div
                          key={`q${i}`}
                          className={`slot pendente${p.selIdx === i ? " sel" : ""}`}
                          draggable
                          onDragStart={aoArrastar(i)}
                          onDragOver={(e) => {
                            e.preventDefault();
                            e.stopPropagation();
                          }}
                          onDrop={soltarEm(c, i)}
                          onClick={() => p.onSelecionar(i)}
                          title={`${it.title}\nArraste para outro pack`}
                        >
                          {it.imgUrl ? (
                            // eslint-disable-next-line @next/next/no-img-element
                            <img src={proxiedImage(it.imgUrl)} alt="" loading="lazy" draggable={false} />
                          ) : (
                            <div className="slot-ph">📰</div>
                          )}
                          {p.enviando?.item === i ? (
                            <span className="slot-etapa sub"><span className="spinner mini" />Enviando</span>
                          ) : (
                            <span className="slot-etapa novo">Na fila</span>
                          )}
                          <span className="slot-tit">{it.title}</span>
                          <button
                            className="slot-x"
                            onClick={(e) => {
                              e.stopPropagation();
                              p.onRemover(i);
                            }}
                            title="Tirar da fila"
                          >
                            ×
                          </button>
                        </div>
                      );
                    })}

                    {Array.from({ length: livres }, (_, s) => (
                      <div key={`v${s}`} className="slot vazio">
                        <span>+</span>
                        <em>vaga</em>
                      </div>
                    ))}
                  </div>

                  <div className="bx-foot">
                    <div className="bx-meter">
                      {Array.from({ length: p.vagas }, (_, s) => (
                        <i key={s} className={s < ocupadas ? "on" : ""} />
                      ))}
                    </div>
                    <span>
                      {ocupadas}/{p.vagas}
                      {repete && <em className="bx-aviso" title="A Brato exige que o número de notícias divida as 4 vagas"> · a 1ª repete</em>}
                    </span>
                  </div>
                </div>
              );
            })}

            {p.caixas < p.maxCaixas && (
              <button
                className={`bx bx-nova${alvo === 0 ? " drop" : ""}`}
                onClick={p.onNovaCaixa}
                onDragOver={(e) => {
                  e.preventDefault();
                  setAlvo(0);
                }}
                onDragLeave={() => setAlvo((a) => (a === 0 ? null : a))}
                onDrop={soltarEm(p.caixas + 1)}
              >
                <span className="bx-nova-plus">+</span>
                <strong>Novo pack</strong>
                <em>divide o dia em {p.caixas + 1} janelas</em>
              </button>
            )}
          </div>

          <p className="boxes-nota">
            Dentro do pack as notícias revezam <b>uma por exibição</b>, 10 s cada. Na hora da troca
            o sistema passa o próximo pack para o Kuma, que leva à tela na virada da faixa de
            programação dele.
            {volta && <> Antes das {rotuloHora(p.inicio)} segue no ar o pack {p.caixas}, o último do dia.</>}
            {retiradas.length > 0 && (
              <span>
                {" "}{retiradas.length} retirada{retiradas.length === 1 ? "" : "s"} do pack hoje.
              </span>
            )}
          </p>

          {parados.length > 0 && (
            <ul className="boxes-alertas">
              {parados.map((e) => (
                <li key={e.id}>
                  <b>⚠ Parada</b>
                  <span className="t">{e.titulo}</span>
                  <span className="m">{e.erro}</span>
                  <code>{e.id}</code>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}
