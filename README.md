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

## Clima automático

> O registro da investigação que produziu isto — o que foi medido contra a API, e
> por que cada decisão é o que é — está em [`docs/clima-automatico.md`](docs/clima-automatico.md).
> Vale ler antes de "simplificar" qualquer coisa aqui: quase toda escolha contraria
> a documentação da Brato, por um motivo que foi medido.

Duas fases, porque a API impõe uma: a estratégia só aceita grupo criativo
**aprovado**, e a aprovação é manual no portal.

**23h — `clima-diario`.** Renderiza o clima do dia seguinte, hospeda e submete o
grupo criativo na conta Weather. O time encontra ele pronto na Análise Criativa
e aprova no lote que já faz.

**De minuto em minuto, 0h–12h — `/api/clima/agendar`.** Procura o grupo do dia;
enquanto estiver pendente, sai em silêncio. Quando encontra aprovado, checa
inventário, cria a unidade daquele dia e amarra o criativo. Se o amarramento
falhar, cancela a unidade em vez de deixar inventário travado sem conteúdo.

A fase 2 é uma rota do painel, chamada pelo cron da Vercel — não um job de CI. A
diferença é de quem opera: depois de aprovar o criativo no portal, a pessoa
precisa da unidade **já criada** para terminar a configuração dela. Cron de 5
minutos no GitHub Actions (o mínimo que ele oferece) deixava ela esperando de
braços cruzados. A fase 2 é `fetch` puro, sem browser e sem ffmpeg, então roda
como rota sem nada de especial — e cron de minuto corta a espera para ≤ 60s.

E, para não esperar nem isso, existe um link com token: a pessoa aprova o lote e
clica num favorito do navegador, sem sair do portal do Kuma. A resposta é uma
página dizendo o número da unidade que acabou de nascer.

```bash
# o favorito que fica na barra de quem aprova
https://conteudos.focusmedia.com.br/api/clima/agendar?t=$CLIMA_TOKEN
```

```
scripts/clima-diario.mts        fase 1: login → render → hospedagem → submissão
src/lib/kuma/agendar.ts         fase 2: aprovado? → inventário → unidade → amarrar
src/app/api/clima/agendar/      a fase 2 como rota — cron, link e painel
scripts/clima-agendar.mts       a mesma fase 2 pela linha de comando
vercel.json                     o cron de minuto que chama a rota
src/app/clima/auto/             rota headless, sem UI, que o runner dirige
src/lib/kuma/client.ts          criativo, inventário, unidade e estratégia
src/lib/kuma/weatherGroup.ts    montagem do payload e nomenclatura
src/lib/kuma/estado.ts          registro do dia, que liga as duas fases
```

O registro do dia (`clima/estado/<data>.json`, no mesmo bucket dos vídeos)
existe porque as duas fases rodam em execuções separadas e o projeto não tem
banco: é ele que diz à fase 2 qual grupo criativo é o do dia. Se ele apontar
para uma unidade que já foi cancelada, a fase 2 agenda de novo — mas só quando a
API responde de forma definitiva. Falha de rede ao consultar conta como "a
unidade ainda vale", porque tratar dúvida como ausência criaria uma segunda
unidade travando as mesmas telas.

A data de veiculação é calculada em `America/Sao_Paulo` de forma explícita, com
`Intl`, e não pelo fuso do host. O runtime da Vercel é UTC como o do GitHub, e
não existe workflow onde fixar `TZ` — depois da meia-noite UTC o dia local já
virou, e a fase procuraria o registro do dia errado.

### Disparo manual pelo painel

A aba Clima tem **Enviar para o Kuma**: aciona o mesmo workflow das 23h com a
data que a previsão permite, para o operador não depender do cron quando algo
falha (ou quando simplesmente quiser).

Ele **não** chama a API do Kuma direto. Render em Chromium, re-embalagem com
ffmpeg e a folga de dez minutos de propagação não cabem numa rota da Vercel — e
reimplementar isso aqui seria uma segunda versão do pipeline para divergir da
primeira. A rota `/api/clima/publicar` só faz `workflow_dispatch`.

Ele também **não** cria a unidade: o criativo precisa estar aprovado para
receber estratégia. Depois que alguém aprova no portal, o cron de minuto cria
plano e unidade, amarra e nomeia — em até 60 segundos.

**Qual data ele escolhe.** A `hourly_forecast` da HG é uma janela móvel de 24h e
o card do dia precisa dos oito horários de 08h a 22h, então existe uma faixa em
que *nenhuma* data fecha. Medido às 16h24: a janela ia das 17h de hoje às 16h de
amanhã, cobrindo 4 dos 8 alvos de hoje e 6 dos 8 de amanhã. Na prática o botão
funciona **das 20h às 10h** — à noite gera amanhã, de manhã gera hoje. Fora
disso ele diz que não há data possível em vez de gerar arte com `—` na
temperatura. A decisão sai de `primeiraDataPossivel()`, com a previsão que a
tela já buscou, não de uma regra de relógio.

### Janela de veiculação

As telas tocam comunicado em faixas de duas horas — 10h–12h, 12h–14h, e assim
até 16h–18h. O `createOrder` e o `inquireSufficientTargets` recebem isso no
campo `hours` (`投放时段，包括哪些小时`), uma lista das horas cheias incluídas: a
janela das 16h às 18h é `[16, 17]`.

Configura-se por `KUMA_CLIMA_JANELA` (`16-18` ou `16,17`), e dá para forçar numa
chamada com `?janela=16-18` no link ou `--janela=16-18` no CLI. Sem nada disso o
campo não vai no pedido e a decisão fica com o Kuma, que é como o clima
funcionou até esta janela existir.

### Alvo

O alvo do pedido — `KUMA_CLIMA_PREDIOS` ou `KUMA_CLIMA_TELAS` — **não tem
padrão**. Para a cidade toda, `KUMA_CLIMA_PREDIOS=CIDADE-INTEIRA`: a automação
pagina os prédios da cidade e expande as telas de cada um. Medido em São Paulo
(`6003`): **1.160 prédios, 5.722 telas, 5.720 com inventário** a 600
exibições/dia — 20 segundos para resolver tudo.

A palavra é por extenso de propósito. `*` seria o óbvio e é exatamente o que um
shell expande sem avisar; o acidente travaria inventário na cidade inteira.

Para medir antes de mudar: `?alvo=CIDADE-INTEIRA&simular=true` no link responde
quantas telas seriam, sem criar nada. `?alvo=` só vale junto de `simular` — quem
chama a URL não decide onde a veiculação acontece.

O antigo alvo do piloto era `2015236`, o prédio da própria Focus Media, com as
telas `2015790` (25") e `2015791` (32").

 Unidade criada consome inventário de tela física, e "todas as telas
da cidade" nunca deve ser o que acontece por omissão.

O runner abre `/clima/auto` em Chromium headless e chama `window.__clima.gerar()`.
Desenhar e codificar só acontece no browser, então a alternativa seria uma
segunda implementação do desenho para o servidor — que divergiria da tela do
operador na primeira mudança de layout. Aqui os dois saem do mesmo código.

Para rodar à mão:

```bash
npm run clima:diario -- --dry-run        # mostra o payload, não envia
npm run clima:diario -- --indice=2       # reenvia o mesmo dia (ver abaixo)
```

| Variável | Para quê |
| --- | --- |
| `APP_URL` | base pública do painel, de onde o runner renderiza |
| `APP_PASSWORD` | senha do painel; o runner faz login como qualquer operador |
| `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` | Storage onde os MP4 do dia viram URL pública — a mesma conta do Mural |
| `SUPABASE_BUCKET` | opcional; padrão `Media`, com os arquivos sob `clima/` |
| `KUMA_API_URL` | `https://openapi.api.brato.info` (sandbox: `…api.sandbox.brato.info`) |
| `KUMA_API_KEY` | chave da API, no header `x-api-key` |
| `KUMA_BIDDER_WEATHER` | conta Weather — ela já existe, não crie outra |
| `KUMA_CLIMA_TELAS` ou `KUMA_CLIMA_PREDIOS` | alvo do pedido; sem padrão, de propósito |
| `CRON_SECRET` | a Vercel manda no `Authorization` do cron; sem ela o cron toma 401 |
| `CLIMA_TOKEN` | o `?t=` do favorito de quem aprova; sem ela esse caminho fica fechado |
| `GITHUB_DISPATCH_TOKEN` | token com Actions read/write, para o botão do painel acionar o workflow |

Ferramentas de operação no mesmo link, para quando algo precisa de conserto à
mão: `?renomear=<plano>&nome=<nome>` renomeia um plano, e `?limpar=<data>` apaga
o registro daquele dia — a fase 2 volta a ver "nada a agendar" e a fase 1 grava
um registro novo. Limpar **não** cancela unidade: se havia uma no ar, ela
continua, e a resposta diz isso.
| `KUMA_CLIMA_JANELA` | janela de veiculação, ex.: `16-18`; sem ela o Kuma decide |

As três últimas, mais as do Kuma e do Supabase, precisam existir **no projeto da
Vercel** — antes eram só secrets do GitHub, e a fase 2 não roda mais lá.

O material fica em `clima/WEATHER-<data>-<tela>-<índice>-<duração>.mp4`. O
prefixo separado existe para o clima poder ter retenção própria sem que uma
limpeza dele encoste em criativo de comunicado — hoje nada é apagado, e são
~9 MB por dia.

### Nomenclatura

`WEATHER-<AAAAMMDD>-<TELA>-<ÍNDICE>-<DURAÇÃO>`, com os mesmos cinco materiais
que a auditoria já aprova hoje: `25`, `32`, `55`, `19` e `19P`. O índice
precisa ser **o mesmo entre os formatos** — exigência da Brato para o sistema
deles casar o vídeo 1 do 25" com o vídeo 1 do 32".

O índice também é a saída para reenvio: nome de arquivo repetido entre
requisições é reprovado com `502` e **feedback vazio**, sem dizer o motivo
(medido no sandbox). Reenviou o mesmo dia? Suba para `--indice=2`.

### O que a API não faz

O tipo de unidade — obrigatória × reserva preemptível — não tem campo em chamada
nenhuma; a Brato confirmou em agosto de 2026 que só se escolhe pelo portal. A
unidade que a fase 2 cria é a comum, que trava inventário. Foi medido: a 600
exibições/dia o inventário comporta em 100% de uma amostra de 116 telas, a 1800
em 95% e a 3600 em 23% — daí o padrão de 600.

Também não existe endpoint para **listar** pedidos: só `getOrderDetail` por id.
Por isso a fase 2 guarda o id da unidade que ela mesma criou no registro do dia.

Uma nota de ambiente: o container do headless precisa de uma fonte de emoji
(Noto Color Emoji). Os ícones de umidade, chuva e vento do card de clima são
emoji e saem como quadrados vazios sem ela.
