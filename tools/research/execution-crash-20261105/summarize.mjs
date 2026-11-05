/** Local evidence summary. Refuses changed source or unsuccessful test log. */
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
const root=path.dirname(fileURLToPath(import.meta.url)),sha=x=>createHash('sha256').update(x).digest('hex');
const bytes=fs.readFileSync(path.join(root,'results.json')),r=JSON.parse(bytes),log=fs.readFileSync(path.join(root,'test-results.txt'),'utf8');
for(const [name,hash]of Object.entries(r.fingerprints))assert.equal(sha(fs.readFileSync(path.join(root,name))),hash,`STALE_SOURCE_${name}`);
const tests=Number(log.match(/tests (\d+)/)?.[1]),passed=Number(log.match(/pass (\d+)/)?.[1]),failedTests=Number(log.match(/fail (\d+)/)?.[1]);
assert(Number.isInteger(tests)&&tests>0&&passed===tests&&failedTests===0,'TEST_LOG_NOT_ALL_PASS');
assert.equal(r.historical.length,4);assert.equal(r.synthetic.length,468);
const failed=r.historical.flatMap(x=>Object.entries(x.economicScreen).filter(([,pass])=>!pass).map(([gate])=>({symbol:x.symbol,gate,
  drawdownDeltaPP:100*x.comparison.ddDelta,returnDeltaPP:100*x.comparison.returnDelta,gainRetention:x.comparison.gainRetention})));
const certificate={version:1,generatedAt:new Date().toISOString(),purpose:'OFFLINE_CANDIDATE_ONLY',liveEnabled:false,
  resultsSha256:sha(bytes),policy:r.policy.version,unitTests:{passed,failed:failedTests,logSha256:sha(log),scope:'PURE_FUNCTIONS_AND_SIMULATED_PROTOCOL'},
  historicalPairs:4,syntheticPairs:468,economicScreen:{status:failed.length?'FAIL':'PASS_MODEL_ONLY',failed},
  hardGates:{canonicalWorkerIntegration:'NOT_TESTED',databaseAtomicityRLS:'NOT_TESTED',productionLeaseFencing:'NOT_TESTED',
    allEntryPaths:'NOT_TESTED',historicalDepthSpread:'UNAVAILABLE',cancelLatency:'NOT_CALIBRATED',
    historicalFiltersLotSize:'NOT_RECONSTRUCTED',watchdogAndReportsIntegration:'NOT_IMPLEMENTED'},
  decision:'LIVE_DESATIVADA',reason:'Model fixtures are not financial execution certification; economic/implementation gates remain unmet.'};
fs.writeFileSync(path.join(root,'certification.json'),JSON.stringify(certificate,null,2)+'\n');
let md=fs.readFileSync(path.join(root,'README.md'),'utf8');
const pct=x=>(100*x).toFixed(2).replace('.',',')+'%',num=x=>String(x).replace('.',',');
for(const x of r.historical){const line=`| ${x.symbol} |${x.baseline.buys}/${x.protected.buys}|${x.baseline.gains}/${x.protected.gains}|${pct(x.baseline.netReturn)}/${pct(x.protected.netReturn)}|${pct(x.baseline.maxDD)}/${pct(x.protected.maxDD)}|${pct(x.comparison.pauseFraction)}|`;
  md=md.replace(new RegExp(`^\\| ${x.symbol} \\|[^\\n]*%[^\\n]*$`,'m'),line);}
const selected=r.synthetic.filter(x=>x.symbol==='SOLBRL'&&x.slots===25&&x.spacing===.01);
const tail='\n## Resultados sintéticos selecionados — modelo SOL, 25 slots, spacing 1%\n\n'
  +'A/P = baseline/protegido. Pausa é em minutos de candles conhecidos; inclui o período de confirmação.\n\n'
  +'| Cenário | Compras A/P | Máximo OPEN A/P | Gains A/P | Minutos pausado |\n|---|---:|---:|---:|---:|\n'
  +selected.map(x=>`| ${x.case} |${x.baseline.buys}/${x.protected.buys}|${x.baseline.maxOpen}/${x.protected.maxOpen}|${x.baseline.gains}/${x.protected.gains}|${num(x.protected.heldBars*5)}|`).join('\n')+'\n\n'
  +'A LIMIT que já estava residente pode preencher antes da pausa. A proteção não desfaz esse fill. Quedas graduais/sucessivas podem consumir todos os slots. São trajetórias sintéticas, não eventos históricos nem estimativa das contas.\n';
md=md.split('\n## Resultados sintéticos selecionados')[0]+tail;
fs.writeFileSync(path.join(root,'README.md'),md);
console.log(JSON.stringify(certificate,null,2));
