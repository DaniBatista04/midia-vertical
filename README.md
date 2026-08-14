# Mídia Vertical — Focus Media

Geradores de criativo para as telas verticais da rede: **cards de notícia** e
**previsão do tempo**, nos dois formatos que o Kuma aceita hoje.

| Aba | Rota | Saída |
| --- | --- | --- |
| Notícias | `/noticias` | JPG 1080×1920 (32") e 1080×2560 (25") |
| Clima | `/clima` | MP4 1080×1920 e 1080×2560, 25 fps |

Os dois formatos correspondem ao `smart32` (full screen) e ao `smart25`
(full screen) da especificação de criativo do Kuma.

## Rodando

```bash
npm install
npm run dev
```

Copie `.env.example` para `.env.local` e preencha:

| Variável | Para quê |
| --- | --- |
| `APP_PASSWORD` | senha única do painel — sem ela o login responde 503 |
| `AUTH_SECRET` | assina o cookie de sessão (`openssl rand -hex 32`) |
| `HG_BRASIL_KEY` | chave da HG Brasil; obrigatória, a rota responde 503 sem ela |

Nenhuma das três tem valor padrão no código — o repositório é público, então
chave commitada seria chave vazada.

## Login

O painel inteiro fica atrás de uma senha compartilhada. O `src/proxy.ts`
intercepta tudo: página sem sessão redireciona para `/login` guardando o
destino, e rota de API responde `401`. Só `/login`, `/api/login`,
`/api/logout` e `/api/health` respondem sem sessão.

A sessão é um cookie `httpOnly` de 12 horas assinado com HMAC-SHA256 — carrega
só a expiração e a assinatura, sem dado de usuário. Trocar a senha é editar a
env var e redeployar; trocar o `AUTH_SECRET` invalida todas as sessões abertas.

Isso também fecha o buraco das rotas de proxy: `/api/feed`, `/api/image` e
`/api/weather` ficavam abertas para qualquer um assim que o app subisse.

> Os arquivos em `public/assets/` continuam públicos de propósito — o Kuma
> precisa baixar o material pela URL do campo `iurl`, sem sessão.

## Estrutura

```
src/proxy.ts          portão de sessão — protege páginas e rotas de API
src/app/login/        tela de entrada
src/app/api/          rotas de proxy (substituem o antigo proxy-server.js)
  feed/               RSS do AppNews — allowlist de host + guarda de SSRF
  image/              imagem do feed com CORS, para o canvas não ficar tainted
  weather/            HG Brasil, com a chave do lado do servidor
  login/ logout/ health/
src/lib/server/       guardas de SSRF e sessão HMAC
src/lib/kuma/         regras do Kuma: nome de arquivo e device styles
src/lib/news/         spec do layout, parser de feed, tipografia e desenho
src/lib/weather/      condições, ícones, desenho e encoder WebCodecs
src/components/       UI dos dois geradores + shell com as abas
scripts/              geração dos materiais default do 19"
public/assets/        máscaras, barra, logo e os defaults do Kuma
docs/api-kuma/        documentação da API do Kuma e o spec de criativo
docs/legacy/          os dois HTMLs originais e o proxy Node, como referência
```

As duas telas são renderizadas só no cliente (`ssr: false`): dependem de
canvas, WebCodecs e medição de fonte, que não existem no servidor.

## Especificação de criativo do Kuma

Do `docs/api-kuma/creative specification.xlsx`:

- **Vídeo**: MP4 H.265, 25 fps, até 3.5 MB/s, áudio 48 kHz
- **Imagem**: JPG RGB, menos de 2 MB
- **Duração**: múltiplo de 2.5s, de 2.5s a 210s (a planilha diz 5s a 210s)
- **Nome do arquivo**: no máximo 60 bytes UTF-8, único entre requisições

### Cobertura por device style

O `creativeGroup` exige entrada para os quatro styles em toda submissão. O
mapa vive em `src/lib/kuma/deviceStyles.ts`:

| Style | Resolução | Origem |
| --- | --- | --- |
| `smart32` | 1080×1920 | arte própria |
| `smart55` | 1080×1920 | mesma arte do 32" |
| `smart25` | 1080×2560 | arte própria |
| `smart19` | 1920×1080 + 768×1366 | **material default** |

O 19" é split e pediria uma arte horizontal em cima, que não existe. O spec
permite subir material default nesse caso — os dois arquivos estão em
`public/assets/kuma/` e saem de `npm run gen:smart19`. É um placeholder
deliberado: troque por arte de marca quando houver.

### Nome de arquivo

`src/lib/kuma/filename.ts` monta `<base>-<w>x<h>-<carimbo>.<ext>`, cortando a
base para caber nos 60 bytes. O carimbo (tempo + aleatório) existe porque o
Kuma exige nome único **entre requisições diferentes** — sem ele, reenviar a
mesma notícia geraria o mesmo nome e o submit seria recusado.

### Codec

O browser codifica em H.265 quando a máquina tem encoder de hardware. Quando
não tem, o WebCodecs só entrega H.264 — e aí a exportação passa por
`/api/transcode`, que re-encoda com ffmpeg (`libx265`, tag `hvc1`, yuv420p,
25 fps, teto de 3.5 Mbps). O operador baixa sempre um arquivo dentro do spec,
sem passo manual.

Nesse caminho o MP4 intermediário do browser sai a 12 Mbps em vez de 3, para a
segunda passada não herdar artefato da primeira. Se a conversão falhar, o
arquivo H.264 ainda é salvo e o toast diz claramente que está fora do spec —
melhor entregar algo utilizável do que nada.

Custo: ~10s por vídeo de 1080×1920 e 10s. O `maxDuration` da rota é 300s.

Duas armadilhas de deploy já resolvidas no `next.config.ts`: o `ffmpeg-static`
precisa ficar em `serverExternalPackages` (ele acha o binário pelo `__dirname`
do próprio pacote, que o bundler reescreve) e o binário precisa entrar no
`outputFileTracingIncludes` para subir junto para a Vercel.

## Automação (próxima fase)

O plano é disparar o clima para o Kuma todo dia às 23h. Como o desenho e a
codificação acontecem no browser, a automação precisa rodar a mesma página em
Chromium headless no servidor — assim o vídeo automático e o preview do
operador saem do mesmo código. `playwright-core` já está no projeto para isso;
foi também o que validou os exports desta versão.

Dois pontos precisam de confirmação da matriz antes de valer a pena investir:

1. **Prazo de quarta às 16h.** Os documentos dizem que `createOrderStrategy` e
   `createTargetStrategy` têm o mesmo prazo do cancelamento. Se valer ao pé da
   letra, troca diária de criativo não é permitida pela API.
2. **SLA da auditoria.** O criativo nasce em `status = 1` e só toca em
   `status = 3`. Submeter às 23h para veicular no dia seguinte só funciona se a
   aprovação for rápida.

Uma nota de ambiente: o container do headless precisa de uma fonte de emoji
(Noto Color Emoji). Os ícones de umidade, chuva e vento do card de clima são
emoji e saem como quadrados vazios sem ela.
