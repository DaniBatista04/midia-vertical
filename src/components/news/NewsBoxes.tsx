"use client";

import { useEffect, useRef, useState, type DragEvent, type PointerEvent as ReactPointerEvent } from "react";

import type { DiaNoticias, EnvioDoDia } from "@/app/api/noticias/dia/route";
import { proxiedImage } from "@/lib/news/draw";
import type { NewsItem } from "@/lib/news/spec";
import { FIM_DIA, INICIO_DIA, rotuloHora } from "@/lib/kuma/noticiaCaixas";

/**
 * A programação do dia: a linha do tempo com as janelas e, embaixo, uma caixa
 * por janela com as suas vagas.
 *
 * Mostra junto o que já foi enviado (vem do servidor, em `dia`) e o que está
 * marcado na fila e ainda não foi (`alocacao`, local). Só o que não foi enviado
 * se arrasta: o envio já tem grupo criativo com a caixa gravada.
 */

export const CORES_CAIXA = ["#00f0ff", "#ff2bd6", "#ffd000", "#39ff88"];

type Props = {
  items: NewsItem[];
  /** Índice do feed → caixa, para o que está na fila e não foi enviado. */
  alocacao: Map<number, number>;
  caixas: number;
  maxCaixas: number;
  vagas: number;
  cortes: number[];
  dia: DiaNoticias | null;
  carregando: boolean;
  busy: boolean;
  selIdx: number | null;
  horariosPendentes: boolean;
  onMover: (item: number, caixa: number, trocarCom?: number) => void;
  onRemover: (item: number) => void;
  onSelecionar: (item: number) => void;
  onCortes: (cortes: number[]) => void;
  onNovaCaixa: () => void;
  onRemoverCaixa: (caixa: number) => void;
  onEnviar: () => void;
  onSalvarHorarios: () => void;
  onAtualizar: () => void;
};

const ETAPA: Record<EnvioDoDia["etapa"], { rotulo: string; classe: string }> = {
  propagando: { rotulo: "SUBINDO", classe: "sub" },
  "em-aprovacao": { rotulo: "AGUARDA", classe: "apr" },
  "no-plano": { rotulo: "APROVADA", classe: "ok" },
  parado: { rotulo: "PARADA", classe: "err" },
};

const HORAS = FIM_DIA - INICIO_DIA;
const pct = (h: number) => `${((Math.min(Math.max(h, INICIO_DIA), FIM_DIA) - INICIO_DIA) / HORAS) * 100}%`;

export function NewsBoxes(p: Props) {
  const [aberto, setAberto] = useState(true);
  const [alvo, setAlvo] = useState<number | null>(null);
  /** Caixa que a tela simulada está mostrando; `null` segue a que está no ar. */
  const [telaCaixa, setTelaCaixa] = useState<number | null>(null);
  const [tique, setTique] = useState(0);
  const trilho = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const t = setInterval(() => setTique((n) => n + 1), 1_000);
    return () => clearInterval(t);
  }, []);

  const enviados = (p.dia?.envios ?? []).filter((e) => e.etapa !== "parado");
  const parados = (p.dia?.envios ?? []).filter((e) => e.etapa === "parado");
  const pendentes = [...p.alocacao.entries()];
  const hora = p.dia?.hora ?? null;
  const caixaDaHora = hora === null ? null : p.cortes.filter((c) => hora >= c).length + 1;
  const noAr = p.dia?.caixaNoAr ?? null;

  const janela = (c: number) => ({
    inicio: c === 1 ? INICIO_DIA : p.cortes[c - 2],
    fim: c === p.caixas ? FIM_DIA : p.cortes[c - 1],
  });

  /* ── Arrastar o divisor entre duas janelas ───────────────── */
  const arrastarCorte = (i: number) => (ev: ReactPointerEvent<HTMLDivElement>) => {
    ev.preventDefault();
    const el = trilho.current;
    if (!el) return;
    const alvoEl = ev.currentTarget;
    alvoEl.setPointerCapture(ev.pointerId);
    const mover = (e: PointerEvent) => {
      const r = el.getBoundingClientRect();
      const h = INICIO_DIA + ((e.clientX - r.left) / r.width) * HORAS;
      // Hora par: é onde a faixa do Kuma vira, e um corte fora dela só
      // chegaria à tela na próxima de qualquer jeito.
      let alvoH = Math.round(h / 2) * 2;
      const min = (i === 0 ? INICIO_DIA : p.cortes[i - 1]) + 2;
      const max = (i === p.cortes.length - 1 ? FIM_DIA : p.cortes[i + 1]) - 2;
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

  /*
   * A tela simulada. Passa as notícias da caixa como a estratégia as reparte —
   * uma por exibição, 10 s cada — mas quem decide a ordem real é o Kuma, e a
   * API não diz o que o player tocou: é o que mandamos estar no ar, não uma
   * transmissão do prédio.
   */
  const caixaTela = telaCaixa ?? noAr ?? caixaDaHora ?? 1;
  const naTela: { titulo: string; img?: string; card: boolean }[] = [
    ...enviados
      .filter((e) => e.caixa === caixaTela)
      .map((e) => ({ titulo: e.titulo, img: e.miniatura, card: true })),
    ...pendentes
      .filter(([, c]) => c === caixaTela)
      .map(([i]) => ({
        titulo: p.items[i]?.title ?? "",
        img: p.items[i]?.imgUrl ? proxiedImage(p.items[i].imgUrl) : undefined,
        card: false,
      })),
  ];
  const EXIBICAO = 10;
  const atual = naTela.length ? Math.floor(tique / EXIBICAO) % naTela.length : 0;
  const restante = EXIBICAO - (tique % EXIBICAO);
  const telaAoVivo = telaCaixa === null && noAr !== null;

  const totalPendentes = pendentes.length;
  const caixasUsadas = new Set(pendentes.map(([, c]) => c)).size;

  return (
    <section className={`gm-dock${aberto ? "" : " fechado"}`}>
      <div className="gm-scan" aria-hidden />

      <header className="gm-head">
        <button className="gm-toggle" onClick={() => setAberto((a) => !a)} title={aberto ? "Recolher" : "Abrir"}>
          <span className={`gm-chev${aberto ? " on" : ""}`}>▶</span>
          <span className="gm-title" data-text="PROGRAMAÇÃO DO DIA">PROGRAMAÇÃO DO DIA</span>
          {p.dia && <span className="gm-date">{p.dia.data.split("-").reverse().slice(0, 2).join(".")}</span>}
        </button>

        <div className="gm-stats">
          <div className="gm-stat">
            <em>Enviadas</em>
            <b>{String(enviados.length).padStart(2, "0")}</b>
          </div>
          <div className="gm-stat">
            <em>Na fila</em>
            <b>{String(totalPendentes).padStart(2, "0")}</b>
          </div>
          <div className="gm-stat">
            <em>Caixas</em>
            <b>
              {p.caixas}
              <small>/{p.maxCaixas}</small>
            </b>
          </div>
          {noAr !== null && (
            <div className="gm-aovivo" style={{ ["--c" as string]: CORES_CAIXA[noAr - 1] }}>
              <i /> AO VIVO <span>· CAIXA {noAr}</span>
            </div>
          )}
        </div>

        <div className="gm-acoes">
          <button className="gm-icon" onClick={p.onAtualizar} disabled={p.carregando}
            title="Relê o que já foi enviado hoje">
            {p.carregando ? <span className="spinner" /> : "⟳"}
          </button>
          {p.horariosPendentes && !totalPendentes && (
            <button className="gm-btn gm-btn-ghost" onClick={p.onSalvarHorarios} disabled={p.busy}>
              Salvar horários
            </button>
          )}
          <button className="gm-btn gm-start" onClick={p.onEnviar} disabled={!totalPendentes || p.busy}>
            <span>▶ Enviar{totalPendentes ? ` ${totalPendentes}` : ""}</span>
            {caixasUsadas > 1 && <small>em {caixasUsadas} caixas</small>}
          </button>
        </div>
      </header>

      {aberto && (
        <div className="gm-body">
          {/* ── Mapa do dia ──────────────────────────────────── */}
          <div className="gm-map">
            <div className="gm-track" ref={trilho}>
              {Array.from({ length: p.caixas }, (_, k) => {
                const c = k + 1;
                const j = janela(c);
                const est = noAr === c ? " live" : caixaDaHora !== null && c < caixaDaHora ? " passou" : "";
                return (
                  <div
                    key={c}
                    className={`gm-seg${est}`}
                    style={{
                      left: pct(j.inicio),
                      width: `calc(${pct(j.fim)} - ${pct(j.inicio)})`,
                      ["--c" as string]: CORES_CAIXA[k],
                    }}
                  >
                    <span className="gm-seg-lbl">
                      <b>CX{c}</b>
                      <em>{rotuloHora(j.inicio)}–{rotuloHora(j.fim)}</em>
                    </span>
                  </div>
                );
              })}

              {p.cortes.map((h, i) => (
                <div
                  key={i}
                  className="gm-cut"
                  style={{ left: pct(h) }}
                  onPointerDown={arrastarCorte(i)}
                  title="Arraste para mudar a hora da troca"
                >
                  <span className="gm-cut-knob" />
                  <span className="gm-cut-lbl">{rotuloHora(h)}</span>
                </div>
              ))}

              {hora !== null && hora >= INICIO_DIA && (
                <div className="gm-now" style={{ left: pct(hora) }}>
                  <span className="gm-now-tag">
                    AGORA {String(Math.floor(hora)).padStart(2, "0")}:{String(Math.round((hora % 1) * 60)).padStart(2, "0")}
                  </span>
                  <span className="gm-now-arrow" />
                </div>
              )}
            </div>
            <div className="gm-ticks">
              {Array.from({ length: HORAS / 2 + 1 }, (_, k) => INICIO_DIA + k * 2).map((h) => (
                <span key={h} style={{ left: pct(h) }}>{rotuloHora(h)}</span>
              ))}
            </div>
          </div>

          <div className="gm-arena">
          {/* ── Tela simulada ────────────────────────────────── */}
          <div className="gm-tela" style={{ ["--c" as string]: CORES_CAIXA[caixaTela - 1] }}>
            <div className="gm-tela-head">
              <span className={`gm-tela-rec${telaAoVivo ? " on" : ""}`}>
                <i /> {telaAoVivo ? "NO AR" : `PRÉVIA CX${caixaTela}`}
              </span>
              {telaCaixa !== null && (
                <button className="gm-tela-volta" onClick={() => setTelaCaixa(null)} title="Voltar para a caixa no ar">
                  ↺ no ar
                </button>
              )}
            </div>
            <div className="gm-monitor">
              <div className="gm-monitor-scr">
                {naTela.length ? (
                  naTela.map((n, i) => (
                    <div key={i} className={`gm-frame${i === atual ? " on" : ""}${n.card ? " card" : ""}`}>
                      {n.img ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={n.img} alt="" draggable={false} />
                      ) : (
                        <div className="gm-ph">📰</div>
                      )}
                      {!n.card && <span className="gm-frame-tit">{n.titulo}</span>}
                    </div>
                  ))
                ) : (
                  <div className="gm-nosignal">
                    <b>SEM SINAL</b>
                    <em>caixa {caixaTela} sem notícia</em>
                  </div>
                )}
                <div className="gm-monitor-glare" />
              </div>
              <div className="gm-monitor-base" />
            </div>
            {naTela.length > 0 && (
              <div className="gm-tela-foot">
                <div className="gm-tela-dots">
                  {naTela.map((_, i) => (
                    <i key={i} className={i === atual ? "on" : ""} />
                  ))}
                </div>
                <div className="gm-tela-prog">
                  <i key={`${caixaTela}-${atual}-${Math.floor(tique / EXIBICAO)}`} style={{ animationDelay: `-${EXIBICAO - restante}s` }} />
                </div>
                <span>
                  {atual + 1}/{naTela.length} · próxima em {restante}s
                </span>
              </div>
            )}
            <p className="gm-tela-nota">
              Simulação: o que mandamos ao Kuma para esta caixa. A ordem real das exibições é do
              Kuma — a API não informa o que o player tocou.
            </p>
          </div>

          {/* ── Caixas ───────────────────────────────────────── */}
          <div className="gm-row">
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
                noAr === c ? "live" : caixaDaHora !== null && c < caixaDaHora ? "passou" : "vem";
              return (
                <div
                  key={c}
                  className={`gm-box gm-${estado}${alvo === c ? " drop" : ""}${cheia ? " cheia" : ""}`}
                  style={{ ["--c" as string]: CORES_CAIXA[k] }}
                  onDragOver={(e) => {
                    if (cheia) return;
                    e.preventDefault();
                    setAlvo(c);
                  }}
                  onDragLeave={() => setAlvo((a) => (a === c ? null : a))}
                  onDrop={soltarEm(c)}
                >
                  <div className="gm-box-in">
                    <div className="gm-box-head">
                      <button
                        className={`gm-hex${caixaTela === c ? " vendo" : ""}`}
                        onClick={() => setTelaCaixa(c === noAr ? null : c)}
                        title="Ver esta caixa na tela"
                      >
                        {c}
                      </button>
                      <div className="gm-box-tit">
                        <strong>CAIXA {c}</strong>
                        <span>{rotuloHora(j.inicio)} → {rotuloHora(j.fim)}</span>
                      </div>
                      <button
                        className={`gm-ver${caixaTela === c ? " on" : ""}`}
                        onClick={() => setTelaCaixa(c === noAr ? null : c)}
                        title="Ver esta caixa na tela simulada"
                      >
                        👁
                      </button>
                      <span className={`gm-tag ${estado}`}>
                        {estado === "live" ? <><i /> AO VIVO</> : estado === "passou" ? "✓ CONCLUÍDA" : "PRÓXIMA"}
                      </span>
                      {!ocupadas && p.caixas > 1 && c === p.caixas && (
                        <button className="gm-x" onClick={() => p.onRemoverCaixa(c)} title="Remover caixa vazia">✕</button>
                      )}
                    </div>

                    <div className="gm-slots">
                      {deles.map((e) => (
                        <div key={e.id} className={`gm-item enviado${e.noAr ? " noar" : ""}`} title={e.titulo}>
                          {e.miniatura ? (
                            // eslint-disable-next-line @next/next/no-img-element
                            <img src={e.miniatura} alt="" loading="lazy" />
                          ) : (
                            <div className="gm-ph">📰</div>
                          )}
                          <span className={`gm-st ${e.noAr ? "noar" : ETAPA[e.etapa].classe}`}>
                            {e.noAr ? "NO AR" : ETAPA[e.etapa].rotulo}
                          </span>
                          <span className="gm-item-tit">{e.titulo}</span>
                        </div>
                      ))}

                      {meus.map((i) => {
                        const it = p.items[i];
                        if (!it) return null;
                        return (
                          <div
                            key={`q${i}`}
                            className={`gm-item pendente${p.selIdx === i ? " sel" : ""}`}
                            draggable
                            onDragStart={aoArrastar(i)}
                            onDragOver={(e) => {
                              e.preventDefault();
                              e.stopPropagation();
                            }}
                            onDrop={soltarEm(c, i)}
                            onClick={() => p.onSelecionar(i)}
                            title={`${it.title}\nArraste para outra caixa`}
                          >
                            {it.imgUrl ? (
                              // eslint-disable-next-line @next/next/no-img-element
                              <img src={proxiedImage(it.imgUrl)} alt="" loading="lazy" draggable={false} />
                            ) : (
                              <div className="gm-ph">📰</div>
                            )}
                            <span className="gm-st novo">NOVA</span>
                            <span className="gm-item-tit">{it.title}</span>
                            <button
                              className="gm-item-x"
                              onClick={(e) => {
                                e.stopPropagation();
                                p.onRemover(i);
                              }}
                              title="Tirar da fila"
                            >
                              ✕
                            </button>
                          </div>
                        );
                      })}

                      {Array.from({ length: livres }, (_, s) => (
                        <div key={`v${s}`} className="gm-item vazio">
                          <span>+</span>
                          <em>Slot livre</em>
                        </div>
                      ))}
                    </div>

                    <div className="gm-power">
                      <span className="gm-power-lbl">CARGA</span>
                      <div className="gm-power-bar">
                        {Array.from({ length: p.vagas }, (_, s) => (
                          <i key={s} className={s < ocupadas ? "on" : ""} />
                        ))}
                      </div>
                      <span className={`gm-power-val${cheia ? " max" : ""}`}>
                        {cheia ? "MAX" : `${ocupadas}/${p.vagas}`}
                      </span>
                    </div>
                    {repete && (
                      <div className="gm-aviso" title="A Brato exige que o número de notícias divida as 4 vagas">
                        ⚠ Com 3, a 1ª notícia repete para fechar as 4 vagas
                      </div>
                    )}
                  </div>
                </div>
              );
            })}

            {p.caixas < p.maxCaixas && (
              <button
                className={`gm-box gm-nova${alvo === 0 ? " drop" : ""}`}
                onClick={p.onNovaCaixa}
                onDragOver={(e) => {
                  e.preventDefault();
                  setAlvo(0);
                }}
                onDragLeave={() => setAlvo((a) => (a === 0 ? null : a))}
                onDrop={soltarEm(p.caixas + 1)}
              >
                <span className="gm-box-in">
                  <span className="gm-lock">🔒</span>
                  <strong>NOVA CAIXA</strong>
                  <em>divide o dia em {p.caixas + 1}</em>
                </span>
              </button>
            )}
          </div>
          </div>

          <p className="gm-dica">
            <b>DICA</b> Dentro da caixa as notícias revezam uma por exibição, 10 s cada. Na hora da
            troca o sistema passa a próxima caixa para o Kuma, que leva à tela na virada da faixa de
            programação dele.
            {parados.length > 0 && (
              <span className="gm-parados">
                {" "}⚠ {parados.length} envio{parados.length === 1 ? "" : "s"} parado{parados.length === 1 ? "" : "s"}:{" "}
                {parados.map((e) => `${e.id} (${e.erro})`).join(" · ")}
              </span>
            )}
          </p>
        </div>
      )}
    </section>
  );
}
