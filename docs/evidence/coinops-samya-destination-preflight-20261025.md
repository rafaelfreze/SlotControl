# Samya — checkpoint de migração, 25/10/2026

Produto CoinOps; OnPlay Platform `otdfpmsegjxpqrzisfmi`; schema `coinops`; REAL.
Escopo: conta Samya `95c95966-b92e-4e22-ac03-32a3f1d0bc1b`.

## Concluído

- Git inicial `97b4e87a16f33a707da31aafb124be43e2769635`, main alinhada ao remoto.
  `apps/web/tsconfig.json` e artefatos anteriores preservados.
- Whitelist autenticada do Executor 02, `164.90.223.159`, PASS.
  Mesma API recebida por relay RSA-OAEP-SHA256/AES-256-GCM, chave privada efêmera
  somente no destino. Nenhum secret, vault, HMAC ou claim financeiro copiado.
- Identidade física e credencial iguais às do 03, permissões restritas PASS,
  origem inalterada, leitura do vault de destino conferida.
- Revalidação oficial `/v1/admin/credentials` e vínculo
  `account_executor_connections` VALIDATED em `2026-10-25T20:25:07.777Z`.
  Claim global existente conferido; auditoria SHARD_CONNECTION persistida.
- Nenhuma ordem criada, cancelada ou substituída. Nenhum engine/run/slot,
  capital ou parâmetro alterado. Sem migration SQL ou alteração de runtime.

## Direção atual do proprietário

Somente Executor 02 para os dois motores da Samya. Não usar o Executor 01.
A tentativa anterior no 01 recebeu HTTP 401 / Binance -2015; não instalou
credencial e não moveu motor. O relay agora permite Samya somente 03→02.

## Impedimento comprovado

Às `20:23:42Z`, os motores de Renato e Jenny Mae Maria já estavam PAUSED,
kill switch de novas BUY fechado, sem erro e com reconciliação fresca.
Cada um ainda tinha **7 posições OPEN e 7 TPs NEW**, sem BUY residente.
Pausa não remove a responsabilidade de acompanhar fills/TPs.

Admission 02 para +2 motores: `CAPACITY_REQUIRED`.
Média sustentada: 2.304,13 weight/min. Incremento conservador: 1.800.
Projeção: **4.104,13 / 3.900** (68,40% vs 65%). Reserva de recovery:
2.100, descontada uma vez. Nenhum threshold alterado ou proteção contornada.

Foi solicitada decisão sobre manter o acompanhamento das 14 posições até o
encerramento ou fazer offboarding com gestão assumida pelos clientes. Não
interpretar “remover” como autorização para vender, cancelar TP ou abandonar
silenciosamente reconciliação financeira. Aguardar essa definição.

## Pendente — não declarar concluído

- Protocolo versionado e testado de migração LIVE: ainda não implementado.
  O guard de shard imutável continua ativo. Não fazer UPDATE manual, desabilitar
  trigger, criar engine substituto nem copiar claims para contorná-lo.
- Aprovação de capacidade para os dois motores no 02, após tratar o escopo de
  offboarding sem presumir que PAUSED equivale a carga zero.
- Handoff com lease/CAS, fencing durável da origem, idempotência, identidade
  engine/run/order e prova Binance × ledger antes e depois.
- Reconciliar no destino e validar TPs/NEXT BUY/Watchdog antes de desativar o 03.
- Executor 03 e os dois motores da Samya continuam operacionais na origem;
  não parar ou destruir a VPS enquanto houver responsabilidade financeira.

## Validação do relay

`node --test tools/operations/reuse-thyely-credential-executor03.test.mjs`:
criptografia, adulteração, freshness/escopo/direção, provas antes da instalação,
ausência de transporte de ordens e sintaxe dos programas remotos.
Sem build/deploy web nem restart: somente ferramenta de manutenção e docs.
