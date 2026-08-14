"use client";

import { useCallback, useEffect, useRef, useState } from "react";

export type ToastKind = "" | "ok" | "err";

/**
 * Toast simples, com a mesma aparência e duração dos geradores originais.
 * Devolve a função de disparo e o nó que deve ser montado na página.
 */
export function useToast(duration = 3400) {
  const [msg, setMsg] = useState<{ text: string; kind: ToastKind } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const toast = useCallback(
    (text: string, kind: ToastKind = "") => {
      setMsg({ text, kind });
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setMsg(null), duration);
    },
    [duration],
  );

  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  const node = (
    <div className={`toast ${msg ? "show" : ""} ${msg?.kind ?? ""}`}>{msg?.text ?? ""}</div>
  );

  return { toast, toastNode: node };
}
