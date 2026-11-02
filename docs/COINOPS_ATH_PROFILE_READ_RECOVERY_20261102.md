# CoinOps — leitura ATH e retomada segura

## Incidente e causa comprovada

Rafael SOLBRL, Executor01, engine `56d4c9f4-adf5-4d03-9085-87487bcd4af8`,
run `dc7eed26-36b3-47d3-9e2c-ca2b682026c1`, incidente
`c9babd95-1a11-47ae-9e61-7a25a2423809`, iniciou em 02/11/2026 17:23:36 UTC.
`COINOPS_ATH_PROFILE_UNAVAILABLE`, stage `ATH_TRANSITION`, veio de um GET sem
retry/deadline que descartava o erro original. O código não era recuperável.
Não há evidência da resposta upstream original: não atribuir a503, Binance ou
mudança real de ATH. A reconciliação posterior protegeu as ordens mas preservou
o gate local; o Watchdog detectou BLOCKED sem iniciar recovery.

Leitura atual confirmou perfil v3 NORMAL, gain5,5%, spacing1,5%/3%, mesma
identidade/configuração do run, sem edição pendente. Snapshot Binance/ledger
17:29 UTC confirmou 25 slots, 15TPs e umaBUY NEW, pending claims0, runtime8001cc6.

## Correção

Somente a observação REAL de `robot_v1_ath_profiles` usa a política GET existente:
duas tentativas até5s/250ms, metadata `ledger/ath_profile`. Erros duros mantêm
HTTP/provider; ausência/integridade inválida têm códigos separados. Nenhum
UPDATE/transition/create/cancel é repetido pelo helper. SHADOW/histórico Testnet
mantêm seu contrato anterior; nenhuma reativação Testnet.

Compatibilidade legada exige code=root `COINOPS_ATH_PROFILE_UNAVAILABLE`, stage
ATH_TRANSITION e ausência dos diagnósticos que o wrapper antigo não emitia.
Novo stale exige root/path/stage/tentativas e diagnóstico transitório exatos.
Nenhum desses códigos é prova de segurança financeira ou de causa histórica.

O cron canônico só retoma após reconciliação completa. `resumeLiveRun` verifica
o perfil antes e depois das leituras externas: ownership completo, versão,
regime, transition_key, rates/gain, ATH/source e snapshot iguais; zero next_config
ou bulk PENDING/APPLYING/BLOCKED_SAFE. O fingerprint inclui updated_at e estado
ATH, exigindo os mesmos dois resultados. Estado diferente aguarda investigação,
sem aplicar transição/configuração através da recuperação.

Além disso continuam obrigatórios lease, health, todas as posições/TPs, ordens,
fills, slots, mês, caps, parents, decisões/dispatches assentados duas vezes,
CAS do mesmo incidente e evento LIVE_RESUMED/VERIFIED_READ_RECOVERY. Não limpar
alerta/gate via SQL. Watchdog confirma o encerramento independentemente.

## Publicação e regressões

Somente web/control plane: nenhuma migration ou reinicialização de VPS.
Testes isolados exercitam503→sucesso, exaustão tipada, permissão/schema/ausência,
perfil estrangeiro, BTC/SOL, versão/rates/regime pendentes, concorrência entre
duas leituras, dispatch pendente, TP ausente, cap eCAS perdido. O relatório v32
preserva o formato e adiciona regra versionada `ath_profile_read_recovery` v1;
diagnósticos eLIVE_RESUMED já são exportados sem reescrever histórico.
