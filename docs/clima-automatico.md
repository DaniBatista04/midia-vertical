# Clima automático — o que foi medido e por que o código é assim

Registro da investigação que produziu a automação do clima, em agosto de 2026.
Existe porque quase toda decisão aqui contraria a documentação da Brato, e sem o
motivo escrito a próxima pessoa vai "simplificar" o código de volta para algo que
não funciona.

O que este documento **não** tem: chaves. Elas vivem nos secrets do repositório
(`gh secret list`) e no `.env` local, nunca aqui — o repositório é público.

---

## Estado em 18/08/2026

Automatizado, rodando por GitHub Actions:

| Fase | Onde | Quando | O que faz |
| --- | --- | --- | --- |
| `clima-diario` | GitHub Actions | 23h BRT | renderiza o card do dia seguinte, hospeda no Supabase, submete o grupo criativo |
| `/api/clima/agendar` | Vercel | a cada minuto, 0h–12h BRT | quando o criativo é aprovado, cria a unidade do dia e amarra o criativo |

A fase 2 já morou no GitHub Actions e saiu de lá — o porquê está em
"[A fase 2 saiu do CI](#a-fase-2-saiu-do-ci-porque-tem-gente-esperando)".

Manual, por limite da API:

- **aprovar o criativo** na Análise Criativa do portal (não existe rota);
- **escolher unidade preemptível**, que só a interface oferece.

Provado em produção de ponta a ponta: grupo `101147_C20043026` aprovado (cinco
materiais em 通过), unidade criada, criativo amarrado, unidade cancelada depois.

O cron da fase 1 vive na `main` — no GitHub Actions, cron só vale na branch
padrão. O da fase 2 vive no `vercel.json` e passa a valer no deploy.

---

## A fase 2 saiu do CI porque tem gente esperando

O clima **não** passa pelo Mural. Diferente do resto, o processo dele é
inteiramente dentro do portal do Kuma — não existe front nosso na jornada de
quem opera, e a pessoa que aprova nunca abre o painel do `midia-vertical`.

Isso importa porque, hoje e sem automação, depois de aprovar os grupos criativos
ela vai até a unidade, amarra os criativos e termina outras configurações por
lá. Quando a automação cria a unidade no lugar dela, ela **fica esperando a
unidade existir** para poder continuar. Com o cron de 5 minutos do GitHub
Actions — que é o intervalo mínimo que ele oferece — isso era até 5 minutos de
pessoa parada, todo dia.

Duas coisas destravaram a mudança:

1. **A fase 2 não precisa de CI.** `src/lib/kuma/client.ts` e
   `src/lib/server/supabaseUpload.ts` não importam nada: são `fetch` puro. Nada
   de Playwright, nada de ffmpeg — isso é só da fase 1, que renderiza vídeo. A
   fase 2 inteira cabe numa rota do painel.
2. **A Vercel faz cron de minuto.** Espera máxima cai de 5 min para 60s, sem a
   pessoa mudar nada no que faz.

E para não esperar nem os 60 segundos, a rota aceita um token na URL. A pessoa
está num navegador o tempo todo: um favorito na barra, clicado logo depois do
"Confirmar" do lote, dispara o agendamento e devolve uma página com o número da
unidade. É o mais perto de um webhook que dá para chegar — **a pessoa é o
webhook**, já que o Kuma não tem nenhum.

Que o Kuma não tem webhook não é suposição: `callback`, `webhook`, `notify`,
`subscribe`, `push` e `hook` aparecem **zero** vezes no contrato inteiro do
gateway (`openapi-brato-v2.json`, 42 rotas).

Um detalhe de fuso veio junto. O runner do GitHub era UTC e a correção foi
`TZ: America/Sao_Paulo` no workflow; o runtime da Vercel também é UTC e não tem
workflow onde fixar isso. Por isso `dataEmSaoPaulo()` calcula com `Intl` e
`timeZone: "America/Sao_Paulo"`, sem depender do fuso do host — verificado com
o relógio em UTC, São Paulo, Tóquio e Los Angeles, e no caso que quebra de
verdade (02:30 UTC, que são 23:30 do dia anterior em Brasília).

## O processo real do time, que define onde a automação para

De `Guia_de_Processos_MURAL_e_KUMA.docx`, e é deliberado: o time opera assim
porque a API não publica tudo.

1. **Mural** — fila de revisão, conferir material e dimensões, "Aprovar e Publicar"
   (é o que dispara `submitCreativeGroup`).
2. **KUMA** — Análise Criativa → Operações em Lote → selecionar todos → Passar →
   Confirmar. **É aqui que a auditoria é aprovada, e é manual.**
3. **Mural** — API & Integração → Poll Criativos → Atualizar.
4. **KUMA** — City Lock (semana de lançamento, São Paulo, Batch Lock, Add Lock) →
   Gerenciamento → Check → Liberar → aguardar a Visão Geral → Desbloquear.

Uma armadilha de diagnóstico: o banco de produção do publicador mostra 5.033
grupos aprovados com mediana de 11 minutos entre envio e aprovação, o que parece
automação. Não é — é a equipe aprovando em lote logo depois de publicar. **Número
de produção não distingue "automático" de "humano rápido e disciplinado".**

---

## Descobertas contra a API, todas medidas

### O que reprova o criativo sem dizer o motivo

O `502` ("falha de geração") vem com `feedback: null` em três situações
diferentes, e nenhuma delas é explicada pela API:

**Submeter cedo demais depois do upload.** O Kuma baixa o material pela URL logo
após a submissão, e objeto recém-subido no Supabase ainda não está acessível para
ele. Falhou com 0s, 30s e 180s de folga; o **mesmo material**, submetido cerca de
15 minutos depois, foi aprovado. Daí a folga de 10 minutos antes de submeter — num
job das 23h ela não custa nada, e sem ela o clima do dia simplesmente não existe.

Isso descartou, uma a uma, hipóteses que pareciam óbvias: codec (H.265 e H.264
reprovam igual), container (`mp4-muxer` do browser × ffmpeg), ausência de faixa de
áudio, 25 × 24 fps, bitrate, a nomenclatura e o Supabase como host.

**Nome de arquivo repetido entre requisições.** O feedback vem listando os
materiais com o motivo em branco (`19寸上屏第1个素材：；…`). O índice do material é o
campo que a convenção da Brato reserva para reenvio, e o job sobe ele sozinho
quando já existe registro para a data.

**Resolução fora do padrão do device style.** Este dá feedback de verdade, em
chinês: `25寸整屏第1个素材分辨率不合规`. Validação automática, em menos de um minuto.

### O feedback da auditoria vem em chinês

`通过` é aprovado. `分辨率不合规` é resolução fora do padrão. O
`src/lib/kuma/weatherGroup.ts` traduz o que já vimos e nomeia o caso de motivo
vazio, porque `19寸上屏第1个素材：；` não é acionável para quem opera.

### A API tem 42 rotas, não 11

O gateway publica o contrato dele em `/v2/api-docs` (exige o header `x-api-key`,
por isso abrir no browser dá 401). A cópia está em `openapi-brato-v2.json` e o
mapa em português em `ROTAS.md`.

O achado que muda o desenho: `POST /v1/adgroup/unit/create` recebe **`adUnitType`**,
com `GUARANTEED` · `CANDIDATE` · `CANDIDATE_NON_PREEMPTIVE` — as três opções da
tela de criação de unidade. Ou seja, o tipo de unidade **está** no contrato,
apesar de a Brato ter respondido ao time que só dá pelo portal. A unidade de clima
de setembro (`60428`, plano `101147_56219`) lê de volta como `CANDIDATE`.

O que **não** existe entre as 42, conferido uma a uma:

- **aprovar criativo** — o `audit.status` é escrito do lado deles;
- **apagar grupo criativo** — dá para apagar plano e cancelar unidade, grupo não;
- **ler a estratégia** de um pedido — quem chama precisa guardar o próprio registro.

### Vínculo de criativo só existe em três rotas

`createOrderStrategy`, `createOrderStrategyWithDate` e `createTargetStrategy`, e
todas indexam por `orderId`. Nem `unit/create` nem `unit/modify` têm campo de
criativo. Consequência: se unidade `CANDIDATE` não gera Pedido de Venda — o que a
auditoria do time levanta, e o que explica o `getOrderDetail` do plano falhar com
`resource not found [BizId:60428]` — então **não existe caminho por API** para
amarrar criativo nela. Não testado ainda; é a próxima pergunta para a Brato.

### A janela de veiculação existe na API, e nós não usávamos

As telas tocam comunicado em faixas de duas horas — 10h–12h até 16h–18h. Tanto
`createOrder` quanto `inquireSufficientTargets` aceitam um campo **`hours`**
(`投放时段，包括哪些小时` — "quais horas incluir"), um array de horas cheias: a
janela das 16h às 18h é `[16, 17]`. Nenhum dos PDFs menciona esse campo; ele
apareceu ao ler o contrato do gateway.

Enquanto o clima não mandava `hours`, a unidade nascia sem faixa declarada e a
distribuição das exibições ao longo do dia ficava por conta do Kuma. Agora dá
para escolher, por `KUMA_CLIMA_JANELA` ou por chamada.

**Só que no `inquireSufficientTargets` o campo está quebrado do lado deles.**
Mandar `hours` na consulta de inventário devolve HTTP 400 com
`JSON parse error: (was java.lang.UnsupportedOperationException) ... through
reference chain: InventoryInquireRequest["hours"] -> java.util.Collections…` —
cara de coleção imutável que o Jackson tenta preencher em vez de substituir. Não
é o payload: o mesmo array vai bem no `createOrder`. Por isso a consulta de
inventário é feita sem janela, do dia inteiro, e a faixa entra só na criação da
unidade. Vale perguntar à Brato.

### Erros e limites que a documentação erra ou omite

| Coisa | O que o PDF diz | O que a API faz |
| --- | --- | --- |
| `durationInSecond` | múltiplo de 15 | múltiplo de **5**, mínimo **10** (12s recusado) |
| `frequency` | múltiplo de 300 | confirmado |
| Parâmetro inválido | erro de negócio | **HTTP 200 com `errorCode` negativo** |
| `-5` | "rede / interno / desconhecido" | também é erro de validação — nunca repetir |
| Listagem de grupos | `auditStart`/`auditEnd` | exige `pageNo`/`pageSize` também |

Códigos que aparecem na prática: `-8` inventário insuficiente, `-6` trava de
publicação, `-7` fora do prazo, `-10` pedido inexistente, `-12` criativo não
aprovado, `-13` estratégia perto do vencimento.

E duas rotas bloqueadas para nós: `inquireSufficientTargetsWithAppId` e
`listOrderIds` exigem headers internos (`ca-app-id`) que a nossa chave não tem.

### Inventário por frequência

Medido em amostra de 116 telas, para a semana seguinte:

| Frequência | Telas com inventário |
| --- | --- |
| 300 · 600 · 1200 /dia | 100% |
| 1800 /dia | 95% |
| 2400 /dia | 86% |
| 3600 /dia | 23% |

Daí os 600/dia do clima. E daí também os 1.468 erros `-8` do publicador: ele pede
2400 para acordo 2x1 e 3600 para 1x1.

### Nunca repetir criação em 5xx

A auditoria do time mostrou `campaign/create` **devolvendo erro e criando o plano**.
O publicador tem cicatriz equivalente ("pedido fantasma") nascida de timeout em
`createOrder`. Por isso `submitCreativeGroup` e `createOrder` vão com
`tentativas = 1`; leitura e inventário continuam repetindo.

### Espaços de id independentes

`orderId` é `{referId}_{n}` (ex.: `101147_56862`); `adUnitId` é um número solto
(ex.: `60428`). **Não dá para derivar um do outro** — o número `56862`, sozinho,
é uma unidade de outra conta.

---

## Duas armadilhas de infraestrutura, não da Brato

**O CDN do Supabase serve versão velha.** Depois de gravar o registro do dia com a
unidade criada, a leitura pela URL pública ainda vinha sem ela — e a fase de
agendamento criava unidade duplicada a cada ciclo, travando as telas de novo. Duas
nasceram assim em execuções consecutivas, ambas canceladas. O `lerJson` vai pelo
endpoint **autenticado**, que não tem CDN. O material de vídeo sofre do mesmo
atraso, e é o que a folga antes de submeter cobre.

**O runner do GitHub é UTC.** O cron das 23h de Brasília dispara às 02:00 UTC do
dia seguinte, então `new Date()` já está no dia seguinte e "amanhã" virava D+2 —
o job renderizaria o card de depois de amanhã, cuja previsão horária não existe, e
falharia na trava todas as noites. Os dois workflows fixam `TZ: America/Sao_Paulo`.

---

## A previsão horária da HG é uma janela móvel de 24h

O `hourly_forecast` começa na hora atual e cobre 24 horas. Rodando às 23h, cobre o
dia seguinte inteiro — os oito horários que o card mostra (08h às 22h). Rodando de
manhã ou à tarde, o fim do dia seguinte ainda não existe e a arte sai com `—` no
lugar da temperatura.

Por isso o job roda às 23h, e por isso ele **recusa** gerar quando algum horário
está sem dado. Publicar arte furada em tela de condomínio é pior que falhar o job.

O card que vai às telas é o **do dia** (hora a hora), não o da semana.

---

## Onde as coisas moram

```
scripts/clima-diario.mts        fase 1
src/lib/kuma/agendar.ts         fase 2 — a lógica
src/app/api/clima/agendar/      fase 2 — a rota (cron da Vercel, link, painel)
scripts/clima-agendar.mts       fase 2 — a mesma coisa pela linha de comando
vercel.json                     o cron de minuto
src/app/clima/auto/             rota headless que o runner dirige
src/components/weather/AutoRenderer.tsx
src/lib/kuma/client.ts          criativo, inventário, unidade, estratégia, catálogo
src/lib/kuma/weatherGroup.ts    payload, nomenclatura, tradução do feedback
src/lib/kuma/estado.ts          registro do dia, que liga as duas fases
src/lib/server/supabaseUpload.ts upload público + leitura autenticada
.github/workflows/clima-diario.yml  o cron das 23h (precisa de Chromium e ffmpeg)
docs/api-kuma/ROTAS.md          as 42 rotas
docs/api-kuma/openapi-brato-v2.json
```

O registro do dia fica em `clima/estado/<data>.json`, no mesmo bucket dos vídeos,
porque as duas fases rodam em execuções separadas de CI e o projeto não tem banco.

A nomenclatura é `WEATHER-<AAAAMMDD>-<TELA>-<ÍNDICE>-<DURAÇÃO>`, com cinco
materiais (`25`, `32`, `55`, `19`, `19P`). O índice precisa ser **o mesmo entre os
formatos** — exigência da Brato para o sistema deles casar o vídeo 1 do 25" com o
vídeo 1 do 32".

---

## Contas e ids úteis

As contas de conteúdo próprio **já existem**, criadas pela equipe da Brato — não
criar outras:

| Conta | Para quê |
| --- | --- |
| Weather | o clima; é a que a automação usa |
| News | as notícias |

Cidade de São Paulo é `6003`. O prédio da própria Focus Media é `2015236`, com as
telas `2015790` (25") e `2015791` (32") — é o alvo do piloto, e o lugar certo para
testar sem encostar em condomínio de cliente.

Existe **sandbox** (`openapi.api.sandbox.brato.info`), com prédios e telas
próprios. Cuidado: a auditoria do sandbox **nunca aprova** criativo válido, e
"pendente" lá não significa "passou" — alguns ficam em `status 1` por mais de um
dia. Foi essa ambiguidade que me fez tirar duas conclusões erradas antes de medir
na produção.

---

## Perguntas abertas para a Brato

1. Para unidade `adUnitType: CANDIDATE`, **qual rota amarra grupo criativo**, já
   que as três de `adstrategy` exigem `orderId` e a unidade não gera pedido?
2. Depois de aprovado, o Kuma **volta a buscar** o arquivo pela `iurl`? É o que
   decide se dá para apagar o material do clima depois de 30 dias.
3. Como **remover** criativos de uma janela de datas sem cancelar o pedido? Lista
   vazia é recusada com HTTP 400.
4. Confirmar `durationInSecond` múltiplo de 5 com mínimo 10, e o `errorCode -5`
   usado para erro de validação.
5. `adUnitType` está no contrato da API — por que a resposta ao time foi que só
   dá pelo portal?

---

## Rastros deixados nos testes

- **Produção, conta Weather**: sete grupos criativos com `502` e um aprovado
  (`101147_C20043026`), todos com prefixo `TESTE-` no nome. Não existe rota para
  apagar grupo criativo; são inofensivos, não podem ser aprovados nem amarrados.
  As unidades criadas nos testes (`…56862`, `…56767`, `…56768`) foram todas
  canceladas, com zero telas travadas.
- **Sandbox**: alguns grupos criativos e uma unidade de teste que a API não deixa
  apagar.
- **Vercel pessoal**: projeto `clima-lab`, que hospedou material de teste. Pode
  sair com `vercel remove clima-lab`.
- **Supabase**: o bucket `Media/clima/` ficou só com o material do grupo aprovado;
  40 MB de lixo de teste foram apagados.
