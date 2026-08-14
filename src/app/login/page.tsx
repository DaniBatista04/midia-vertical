import { Suspense } from "react";

import { LoginForm } from "./LoginForm";

export const metadata = { title: "Entrar — Mídia Vertical" };

export default function LoginPage() {
  return (
    <main className="login-wrap">
      <Suspense fallback={null}>
        <LoginForm />
      </Suspense>
    </main>
  );
}
