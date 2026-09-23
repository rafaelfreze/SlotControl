# Fase 5.0 — revisão independente dos checks mensais e gate

Escopo local, sem acesso remoto nem escrita financeira. A revisão encontrou quatro lacunas na força da evidência e acrescentou seis testes em `apps/web/lib/coinops-reports/audit-5-monthly-gate.test.ts`.

| Finding | Severidade | Prova e correção |
| --- | --- | --- |
| RPT-01 | MEDIUM | Lifetime100→1 era considerado válido se existisse qualquer reversal -1. A redução agora precisa reconciliar exatamente com os créditos e estornos assinados entre os snapshots, usando effective_gain_at e limite mensal inclusivo no início/exclusivo no fim. Evidência temporal inválida permanece WARNING. |
| RPT-02 | MEDIUM | Paridade comparava todos os slots Shadow somente ao primeiro slot Testnet; slot25 Testnet com meta99 passava. Agora os dois conjuntos precisam ter25 identidades físicas válidas e meta oficial em cada linha (BTC7/SOL2). |
| RPT-03 | MEDIUM | Uma fonte truncada pode conter gain+2 e omitir reversal-1 anterior à entrada. Com ledger assinado, essa leitura não prova entrada inelegível. Com fonte incompleta, os checks de entrada/reentrada ficam WARNING; fonte integral mantém FAIL para violação comprovada. |
| RPT-04 | MEDIUM | Quatro ciclos e dois flags de segurança bastavam para o gate PASS, sem checks operacionais. Agora exige cobertura dos invariantes críticos em cada ambiente/ativo, ownership/TPs por ambiente e checks globais de ledger/idempotência/fontes. Ausências são explicitadas em missing_required_checks e deixam o gate WARNING. Erros ativos de runtime continuam FAIL; recuperação histórica comprovada continua WARNING. |

A revisão também reproduziu gain manual legítimo causando falso FAIL na conta Shadow e FX90s no futuro causando falso PASS. Esses dois pontos foram corrigidos pelo responsável pela integração, em `audit-checks.ts` e `manual-adjustment-audit.ts`; não foram duplicadas implementações nesta subauditoria.

## Validação executada

```powershell
node --experimental-strip-types --test lib/coinops-reports/audit-5-monthly-gate.test.ts lib/coinops-reports/audit-5-reports.test.ts lib/coinops-reports/monthly-audit.test.ts
```

Resultado: **13/13 PASS**, incluindo os seis cenários novos. O teste positivo do gate usa uma matriz sintética completa; ele não representa confirmação de readiness remota. O gate é somente leitura, não habilita LIVE nem modifica permissão de trading. Publication/migration/smoke reais são responsabilidade da validação consolidada.
