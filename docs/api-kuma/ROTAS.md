# Rotas da API do Kuma (Brato)

O gateway publica o contrato dele. Sem o header `x-api-key` a resposta é 401, e é
por isso que abrir a URL no browser não funciona:

```bash
curl -H 'x-api-key: SUA_CHAVE' https://openapi.api.brato.info/v2/api-docs \
  -o openapi-brato-v2.json
```

A cópia baixada está em `openapi-brato-v2.json` (produção, versão 1.2.1945). Para
ler numa interface, o Swagger UI em `/swagger-ui/index.html` carrega mas não
consegue buscar o spec sem a chave — o caminho prático é abrir o JSON salvo em
qualquer visualizador de OpenAPI, ou usar uma extensão de browser que injete o
header.

São **42 rotas**. Os PDFs desta pasta cobrem 13, marcadas com ✓; as outras 29
nunca foram documentadas para nós.

## Plano, unidade e pedido

| | Método | Rota | O que faz |
| --- | --- | --- | --- |
|  | `POST` | `/v1/adgroup/campaign/create` | criar plano |
|  | `POST` | `/v1/adgroup/campaign/delete/{adCampaignId}` | excluir plano |
|  | `GET` | `/v1/adgroup/campaign/get/{adCampaignId}` | detalhe do plano |
|  | `POST` | `/v1/adgroup/campaign/getAll` | planos de todas as contas |
|  | `GET` | `/v1/adgroup/campaign/getAll/{accountId}` | planos de uma conta |
|  | `POST` | `/v1/adgroup/campaign/getAllByReferId` | planos por número de reporte |
|  | `POST` | `/v1/adgroup/campaign/modify` | alterar plano |
| ✓ | `POST` | `/v1/adgroup/cancelOrder` | cancelar veiculação |
| ✓ | `POST` | `/v1/adgroup/createOrder` | confirmar veiculação dos pontos |
| ✓ | `POST` | `/v1/adgroup/getOrderDetail` | detalhe do pedido |
|  | `POST` | `/v1/adgroup/listOrderIds` | listar ids de pedido (exige header interno ca-app-id) |
|  | `POST` | `/v1/adgroup/unit/cancel/{adUnitId}` | cancelar unidade |
|  | `POST` | `/v1/adgroup/unit/create` | criar unidade |
|  | `GET` | `/v1/adgroup/unit/get/{adUnitId}` | detalhe da unidade |
|  | `POST` | `/v1/adgroup/unit/getAll` | todas as unidades |
|  | `GET` | `/v1/adgroup/unit/getAll/{adCampaignId}` | unidades de um plano |
|  | `GET` | `/v1/adgroup/unit/inquire/{adUnitId}` | consultar a trava de pontos da unidade |
|  | `POST` | `/v1/adgroup/unit/modify` | alterar unidade |
|  | `POST` | `/v1/adgroup/unit/reserveAdUnit/{adUnitId}` | travar os pontos da unidade |
|  | `POST` | `/v1/adgroup/unit/revert/{adUnitId}` | desfazer a trava de pontos |

## Estratégia — amarrar criativo

| | Método | Rota | O que faz |
| --- | --- | --- | --- |
| ✓ | `POST` | `/v1/adstrategy/createOrderStrategy` | amarrar criativo ao pedido |
|  | `POST` | `/v1/adstrategy/createOrderStrategyWithDate` | amarrar criativo por janela de datas |
| ✓ | `POST` | `/v1/adstrategy/createTargetStrategy` | estratégia no nível do alvo (prédio) |

## Criativos

| | Método | Rota | O que faz |
| --- | --- | --- | --- |
| ✓ | `GET` | `/management/v1/bidder/{bidderId}/creativeGroups` | listar grupos por janela de auditoria |
| ✓ | `POST` | `/management/v1/bidder/{bidderId}/creativeGroups` | submeter grupo criativo |
| ✓ | `GET` | `/management/v1/bidder/{bidderId}/creativeGroups/{id}` | consultar grupo criativo |
|  | `POST` | `/management/v1/creative/batchDownload` | baixar criativos em lote |

## Inventário

| | Método | Rota | O que faz |
| --- | --- | --- | --- |
| ✓ | `POST` | `/v1/inventory/inquireSufficientTargets` | pontos com inventário suficiente, dado período, duração e frequência |
|  | `POST` | `/v1/inventory/inquireSufficientTargetsWithAppId` | pontos com inventário suficiente, dado período, duração e frequência |

## Catálogo

| | Método | Rota | O que faz |
| --- | --- | --- | --- |
| ✓ | `GET` | `/v1/adresource/getAllStandardCities` | cidades |
| ✓ | `POST` | `/v1/adresource/getBuildingInfos` | prédios de uma cidade |
| ✓ | `POST` | `/v1/adresource/getValidLocationInfos` | telas de um prédio |

## Contas

| | Método | Rota | O que faz |
| --- | --- | --- | --- |
| ✓ | `POST` | `/v1/authserver/account/create` | criar conta (variante) |
| ✓ | `POST` | `/v1/authserver/account/list` | listar contas |
|  | `POST` | `/v1/authserver/account/listByProductName` | listar contas por linha de produto |
|  | `POST` | `/v1/authserver/test/account/list` | listar contas (teste) |

## Relatórios

| | Método | Rota | O que faz |
| --- | --- | --- | --- |
|  | `POST` | `/v1/adreport/queryDetailByAdCycleId` | relatório de exibição por período |
|  | `POST` | `/v1/adreport/queryDetailByLocId` | relatório de exibição por ponto |

## Clientes (CRM)

| | Método | Rota | O que faz |
| --- | --- | --- | --- |
|  | `POST` | `/v1/crmapi/customer/create` | criar conta |
|  | `GET` | `/v1/crmapi/customer/get/{reportId}` | detalhe da conta |
|  | `POST` | `/v1/crmapi/customer/modify` | alterar conta |

## Tradução

| | Método | Rota | O que faz |
| --- | --- | --- | --- |
|  | `POST` | `/v1/translate/getContent` | conteúdo traduzido |

## E-mail

| | Método | Rota | O que faz |
| --- | --- | --- | --- |
|  | `POST` | `/v1/email/send` | enviar e-mail |

## O achado que muda o desenho

O `POST /v1/adgroup/unit/create` recebe **`adUnitType`**, e o enum é:

| Valor | Significado |
| --- | --- |
| `GUARANTEED` | unidade obrigatória, trava inventário |
| `CANDIDATE` | **reserva preemptível** — usa o inventário livre e cede para campanha paga |
| `CANDIDATE_NON_PREEMPTIVE` | reserva que ocupa o espaço e não cede |

São as três opções da tela de criação de unidade do portal. Ou seja: o tipo de
unidade **está** no contrato da API, ao contrário do que foi respondido ao time.
A unidade de clima de setembro (`60428`, no plano `101147_56219`) lê de volta como
`adUnitType: CANDIDATE`, então o campo é real e usado.

Falta confirmar se a estratégia (`createOrderStrategy*`, que fala em `orderId`)
aceita uma unidade preemptível: o `getOrderDetail` do plano falha com
`resource not found [BizId:60428]`, o que sugere que o módulo antigo de pedidos
não materializa unidade desse tipo.

## O que continua fora da API

**Aprovar criativo.** As 42 rotas foram conferidas uma a uma e não existe
endpoint de aprovação — o `audit.status` é escrito do lado do Kuma. A aprovação
segue sendo o passo manual do time na Análise Criativa.

Outros enums úteis:

- `adCampaignType`: `KA` · `VACANT` · `NONPROFIT` · `PROPERTY` (o plano do clima é `VACANT`)
- `adUnitStatus`: `PENDING` · `WAIT` · `SHOW` · `FINISH` · `TERMINATED` · `CANCELLED`
- `targetType`: `UNIT` · `AREA` · `SUIT` · `DOORWAY` · `BUILDING` · `LOCATION`
- `scopeEnum`: `ALL` · `ON_SALE` · `OFF_SALE` · `INSTALL` · `UNINSTALL`

