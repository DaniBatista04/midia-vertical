"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";

export function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const next = params.get("next") ?? "/noticias";

  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        setError(body?.error ?? `Falha no login (HTTP ${res.status})`);
        return;
      }
      // Rota destino só existe depois do cookie, então recarrega de fato.
      router.replace(next.startsWith("/") ? next : "/noticias");
      router.refresh();
    } catch {
      setError("Não foi possível falar com o servidor.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="login-card" onSubmit={submit}>
      <div className="login-logo">
        MÍDIA<span>VERTICAL</span>
      </div>
      <p className="login-sub">Geradores de criativo · Focus Media</p>

      <div className="field-row" style={{ marginTop: 18 }}>
        <label className="field-label" htmlFor="pwd">
          Senha do painel
        </label>
        <input
          id="pwd"
          type="password"
          value={password}
          autoFocus
          autoComplete="current-password"
          placeholder="••••••••"
          onChange={(e) => setPassword(e.target.value)}
        />
      </div>

      {error && <div className="login-error">{error}</div>}

      <button className="btn btn-accent" type="submit" disabled={busy || !password}>
        {busy ? (
          <>
            <span className="spinner" /> Entrando…
          </>
        ) : (
          "Entrar"
        )}
      </button>
    </form>
  );
}
