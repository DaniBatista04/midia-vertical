"use client";

import { useState } from "react";

import type { TesteDoDia } from "@/app/api/noticias/dia/route";

/**
 * O pack de teste do `ignoreLock`: manda a notícia selecionada para um plano e
 * uma unidade só dela, nas telas de um prédio, criada com `ignoreLock: true`
 * (ver `testeIgnoreLock.ts`). Fica recolhido embaixo da programação do dia e
 * não mexe nos packs.
 *
 * O que o teste mede está no log de cada envio — o que o Kuma respondeu a cada
 * chamada, e o `published`/`publishChanged` da unidade quando relida — mais o
 * que alguém vir na tela do prédio.
 */

type Predio = { buildingId: string; buildingName: string };

type Props = {
  testes: TesteDoDia[];
  /** Título da notícia selecionada no feed, ou `null`. */
  selecionada: string | null;
  busy: boolean;
  onEnviar: (predio: Predio, pontos: string[]) => Promise<void>;
  onAtualizar: () => void;
};

const ETAPA: Record<TesteDoDia["etapa"], { rotulo: string; classe: string }> = {
  propagando: { rotulo: "Subindo", classe: "sub" },
  "em-aprovacao": { rotulo: "Aprovar no Kuma", classe: "apr" },
  "no-plano": { rotulo: "Unidade criada", classe: "ok" },
  parado: { rotulo: "Parado", classe: "err" },
  retirada: { rotulo: "Retirado", classe: "err" },
  cancelado: { rotulo: "Cancelado", classe: "err" },
};

const hora = (iso?: string) =>
  iso ? new Date(iso).toLocaleTimeString("pt-BR", { timeZone: "America/Sao_Paulo" }) : "—";

export function NewsTeste(p: Props) {
  const [aberto, setAberto] = useState(false);
  const [busca, setBusca] = useState("");
  const [buscando, setBuscando] = useState(false);
  const [achados, setAchados] = useState<Predio[] | null>(null);
  const [erroBusca, setErroBusca] = useState<string | null>(null);
  const [predio, setPredio] = useState<Predio | null>(null);
  const [acao, setAcao] = useState<string | null>(null);
  const [projetoId, setProjetoId] = useState("");
  const [pontosTxt, setPontosTxt] = useState("");
  const pontos = pontosTxt.split(/[\s,;]+/).map((s) => s.trim()).filter(Boolean);
  const pontosOk = pontos.every((pt) => /^\d+$/.test(pt));
  // O ID do projeto digitado vale mais que o prédio achado pela busca.
  const alvo: Predio | null = /^\d+$/.test(projetoId.trim())
    ? { buildingId: projetoId.trim(), buildingName: predio?.buildingId === projetoId.trim() ? predio.buildingName : "" }
    : predio;

  const buscar = async () => {
    setBuscando(true);
    setErroBusca(null);
    try {
      const r = await fetch(`/api/noticias/teste?predio=${encodeURIComponent(busca.trim())}`);
      const corpo = await r.json();
      if (!r.ok) throw new Error(corpo?.error ?? `HTTP ${r.status}`);
      setAchados(corpo.predios as Predio[]);
    } catch (e) {
      setErroBusca(e instanceof Error ? e.message : String(e));
      setAchados(null);
    } finally {
      setBuscando(false);
    }
  };

  const agir = async (id: string, qual: "ler" | "cancelar" | "retomar") => {
    if (qual === "cancelar" && !window.confirm("Cancelar a unidade deste teste? A notícia sai das telas do prédio.")) {
      return;
    }
    setAcao(`${id}:${qual}`);
    try {
      const r = await fetch("/api/noticias/teste", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, acao: qual }),
      });
      const corpo = await r.json();
      if (!r.ok) throw new Error(corpo?.error ?? `HTTP ${r.status}`);
    } catch (e) {
      window.alert(e instanceof Error ? e.message : String(e));
    } finally {
      setAcao(null);
      p.onAtualizar();
    }
  };

  return (
    <section className={`teste-dock${aberto ? "" : " fechado"}`}>
      <button className="boxes-toggle" onClick={() => setAberto((a) => !a)}>
        <span className={`chev${aberto ? " on" : ""}`}>▸</span>
        <span className="boxes-title">Pack de teste · ignoreLock</span>
        {p.testes.length > 0 && <span className="boxes-date">{p.testes.length}</span>}
      </button>

      {aberto && (
        <div className="teste-body">
          <p className="boxes-nota">
            Manda a notícia selecionada para <b>um plano e uma unidade só dela</b>, nas telas de um
            prédio, criada com <code>ignoreLock: true</code>. Não entra nos packs nem no plano do dia.
            Depois de aprovar no portal, o sistema cria a unidade e amarra a notícia. Para o teste
            valer, <b>não faça City Lock nem publicação</b> até alguém olhar a tela do prédio.
          </p>

          <div className="teste-form">
            <input
              className="teste-input"
              placeholder="Nome do prédio (mín. 3 letras)"
              value={busca}
              onChange={(e) => setBusca(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && busca.trim().length >= 3 && void buscar()}
            />
            <button className="btn btn-ghost btn-sm" onClick={() => void buscar()}
              disabled={buscando || busca.trim().length < 3}>
              {buscando ? <span className="spinner" /> : "Buscar"}
            </button>
            {predio && (
              <span className="teste-predio">
                Prédio: <b>{predio.buildingName}</b> <code>{predio.buildingId}</code>
              </span>
            )}
          </div>

          <div className="teste-form">
            <input
              className="teste-input curto"
              placeholder="ou ID do projeto (ex.: 2015526)"
              value={projetoId}
              onChange={(e) => setProjetoId(e.target.value)}
            />
            <input
              className="teste-input"
              placeholder="Point IDs (opcional — vazio usa todas as telas)"
              value={pontosTxt}
              onChange={(e) => setPontosTxt(e.target.value)}
            />
            {alvo && (
              <span className="teste-predio">
                Alvo: <b>{alvo.buildingName || `Projeto ${alvo.buildingId}`}</b>
                {pontos.length ? <> · só {pontos.length === 1 ? "o point" : "os points"} <code>{pontos.join(", ")}</code></> : " · todas as telas"}
              </span>
            )}
          </div>
          {!pontosOk && <p className="teste-erro">Point ID é só número; separe vários com vírgula.</p>}

          {erroBusca && <p className="teste-erro">{erroBusca}</p>}
          {achados && (
            <div className="teste-achados">
              {achados.length === 0 && <span className="boxes-nota">Nenhum prédio com esse nome.</span>}
              {achados.map((a) => (
                <button
                  key={a.buildingId}
                  className={`teste-achado${predio?.buildingId === a.buildingId ? " on" : ""}`}
                  onClick={() => setPredio(a)}
                >
                  {a.buildingName}
                </button>
              ))}
            </div>
          )}

          <button
            className="btn btn-accent btn-sm"
            disabled={!alvo || !pontosOk || !p.selecionada || p.busy}
            onClick={() => alvo && void p.onEnviar(alvo, pontos)}
            title={!p.selecionada ? "Selecione uma notícia no feed" : undefined}
          >
            {p.busy ? <span className="spinner" /> : "🧪"} Enviar como teste
            {p.selecionada ? ` — “${p.selecionada.slice(0, 50)}${p.selecionada.length > 50 ? "…" : ""}”` : ""}
          </button>

          {p.testes.map((t) => (
            <div key={t.id} className="teste-card">
              <div className="teste-card-head">
                <span className={`slot-etapa ${ETAPA[t.etapa].classe}`} style={{ position: "static" }}>
                  <i />
                  {ETAPA[t.etapa].rotulo}
                </span>
                <strong>{t.titulo}</strong>
                <span className="teste-meta">
                  {t.predioNome} · <code>{t.id}</code>
                  {t.planoId && <> · plano <code>{t.planoId}</code></>}
                  {t.adUnitId && <> · unidade <code>{t.adUnitId}</code></>}
                  {t.telas !== undefined && <> · {t.telas} tela(s)</>}
                  {t.agendadoEm && <> · criada às {hora(t.agendadoEm)}</>}
                </span>
                <span className="teste-acoes">
                  {t.etapa === "parado" && (
                    <button className="btn btn-ghost btn-sm" onClick={() => void agir(t.id, "retomar")}
                      disabled={acao !== null} title="O cron tenta de novo, do passo que faltou">
                      {acao === `${t.id}:retomar` ? <span className="spinner" /> : "Tentar de novo"}
                    </button>
                  )}
                  {t.adUnitId && !t.canceladoEm && (
                    <>
                      <button className="btn btn-ghost btn-sm" onClick={() => void agir(t.id, "ler")}
                        disabled={acao !== null}>
                        {acao === `${t.id}:ler` ? <span className="spinner" /> : "Ler unidade"}
                      </button>
                      <button className="btn btn-ghost btn-sm" onClick={() => void agir(t.id, "cancelar")}
                        disabled={acao !== null}>
                        {acao === `${t.id}:cancelar` ? <span className="spinner" /> : "Cancelar unidade"}
                      </button>
                    </>
                  )}
                </span>
              </div>
              {t.erro && <p className="teste-erro">{t.erro}</p>}
              {t.log.length > 0 && (
                <ol className="teste-log">
                  {t.log.map((l, k) => (
                    <li key={k} className={l.ok ? "" : "err"}>
                      <span>{hora(l.em)}</span>
                      <b>{l.passo}</b>
                      <code>{l.detalhe}</code>
                    </li>
                  ))}
                </ol>
              )}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
