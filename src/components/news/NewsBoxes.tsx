"use client";

import { useRef, useState, type DragEvent, type PointerEvent as ReactPointerEvent } from "react";

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

export const CORES_CAIXA = ["#5ce3ff", "#b18cff", "#ffb347", "#7dff9a"];

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
  propagando: { rotulo: "Subindo", classe: "sub" },
  "em-aprovacao": { rotulo: "Em aprovação", classe: "apr" },
  "no-plano": { rotulo: "Aprovada", classe: "ok" },
  parado: { rotulo: "Parada", classe: "err" },
};

const HORAS = FIM_DIA - INICIO_DIA;
const pct = (h: number) => `${((Math.min(Math.max(h, INICIO_DIA), FIM_DIA) - INICIO_DIA) / HORAS) * 100}%`;

export function NewsBoxes(p: Props) {
  const [aberto, setAberto] = useState(true);
  const [alvo, setAlvo] = useState<number | null>(null);
  const trilho = useRef<HTMLDivElement>(null);

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

        <div className="boxes-resumo">
          <span><b>{enviados.length}</b> enviada{enviados.length === 1 ? "" : "s"}</span>
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

        <div className="boxes-acoes">
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
            🚀 Enviar {totalPendentes || ""} {totalPendentes === 1 ? "notícia" : "notícias"}
            {caixasUsadas > 1 ? ` em ${caixasUsadas} packs` : ""}
          </button>
        </div>
      </header>

      {aberto && (
        <div className="boxes-body">
          {/* ── Linha do tempo ───────────────────────────────── */}
          <div className="tl">
            <div className="tl-track" ref={trilho}>
              {Array.from({ length: p.caixas }, (_, k) => {
                const c = k + 1;
                const j = janela(c);
                return (
                  <div
                    key={c}
                    className={`tl-seg${noAr === c ? " live" : ""}`}
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

              {hora !== null && hora >= INICIO_DIA && (
                <div className="tl-now" style={{ left: pct(hora) }}>
                  <span className="tl-now-dot" />
                  <span className="tl-now-lbl">
                    agora · {String(Math.floor(hora)).padStart(2, "0")}:{String(Math.round((hora % 1) * 60)).padStart(2, "0")}
                  </span>
                </div>
              )}
            </div>
            <div className="tl-ticks">
              {Array.from({ length: HORAS / 2 + 1 }, (_, k) => INICIO_DIA + k * 2).map((h) => (
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
                noAr === c ? "live" : caixaDaHora !== null && c < caixaDaHora ? "passou" : "vem";
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
                      <span>{rotuloHora(j.inicio)} → {rotuloHora(j.fim)}</span>
                    </div>
                    <span className={`bx-badge ${estado}`}>
                      {estado === "live" ? <><i /> No ar</> : estado === "passou" ? "Encerrada" : "A seguir"}
                    </span>
                    {!ocupadas && p.caixas > 1 && c === p.caixas && (
                      <button className="bx-x" onClick={() => p.onRemoverCaixa(c)} title="Remover pack vazio">×</button>
                    )}
                  </div>

                  <div className="bx-slots">
                    {deles.map((e) => (
                      <div key={e.id} className={`slot enviado${e.noAr ? " noar" : ""}`} title={e.titulo}>
                        {e.miniatura ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img src={e.miniatura} alt="" loading="lazy" />
                        ) : (
                          <div className="slot-ph">📰</div>
                        )}
                        <span className={`slot-etapa ${ETAPA[e.etapa].classe}`}>
                          {e.noAr ? "● No ar" : ETAPA[e.etapa].rotulo}
                        </span>
                        <span className="slot-tit">{e.titulo}</span>
                      </div>
                    ))}

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
                          <span className="slot-etapa novo">Na fila</span>
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
            {parados.length > 0 && (
              <span className="boxes-parados">
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
