"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import type { ReactNode } from "react";

const TABS = [
  { href: "/noticias", emoji: "📰", label: "Notícias" },
  { href: "/clima", emoji: "🌤", label: "Clima" },
] as const;

export type ShellStatus = { text: string; ok?: boolean; err?: boolean };

type Props = {
  /** Define o accent, a largura da sidebar e o fundo da área de canvas. */
  app: "news" | "weather";
  logo: ReactNode;
  tag?: ReactNode;
  status: ShellStatus;
  banner?: ReactNode;
  aside: ReactNode;
  asideScroll?: boolean;
  children: ReactNode;
};

export function AppShell({
  app,
  logo,
  tag,
  status,
  banner,
  aside,
  asideScroll = false,
  children,
}: Props) {
  const pathname = usePathname();
  const router = useRouter();

  const logout = async () => {
    await fetch("/api/logout", { method: "POST" });
    router.replace("/login");
    router.refresh();
  };

  return (
    <div className="app-shell" data-app={app}>
      <header className="app-header">
        <div className="logo">{logo}</div>

        <nav className="tabs">
          {TABS.map((t) => (
            <Link
              key={t.href}
              href={t.href}
              className="tab"
              data-active={pathname === t.href}
            >
              <span className="tab-emoji">{t.emoji}</span>
              {t.label}
            </Link>
          ))}
        </nav>

        {tag}

        <div className="hstatus">
          <div className={`dot${status.ok ? " ok" : status.err ? " err" : ""}`} />
          <span>{status.text}</span>
          <button className="logout-btn" onClick={logout} title="Encerrar a sessão">
            Sair
          </button>
        </div>
      </header>

      {banner}

      <aside className={`app-aside${asideScroll ? " scroll" : ""}`}>{aside}</aside>

      <div className="main-wrap">{children}</div>
    </div>
  );
}
