import { buildMarketReading } from '../../server/marketDecision.js';
import type { HistoryRecord } from '../../server/types.js';

function rng(seed:number){let s=seed;return()=>{s=(s*1103515245+12345)&0x7fffffff;return s/0x7fffffff;};}
function mkN(seed:number){const r=rng(seed);return()=>{const u=Math.max(r(),1e-9),v=Math.max(r(),1e-9);return Math.sqrt(-2*Math.log(u))*Math.cos(2*Math.PI*v);};}
type Regime='trend_up'|'trend_down'|'randomwalk'|'momentum';
function build(regime:Regime,seed:number,days=40):HistoryRecord[]{
  const N=mkN(seed); const out:HistoryRecord[]=[]; let price=940, vel=0;
  const t0=Date.UTC(2026,3,1,4,0,0); let idx=0;
  for(let d=0;d<days;d++) for(let h=0;h<24;h++,idx++){
    if(regime==='trend_up')   price*=1+0.0006+0.0010*N();
    else if(regime==='trend_down') price*=1-0.0006+0.0010*N();
    else if(regime==='randomwalk') price*=1+0.0012*N();
    else { vel=0.85*vel+0.0008*N(); price*=1+vel; }
    const base=t0+idx*3_600_000;
    for(let k=0;k<30;k++){const t=base+k*60_000, p=price*(1+0.0004*N());
      out.push({id:`r${t}`,timestamp:t,dateStr:new Date(t).toISOString(),hour:0,buyPrice:p-2,sellPrice:p,
        spreadPct:0.2,bestBuyMerchant:'m',bestSellMerchant:'m',activeBuyAds:20,activeSellAds:20,source:'SYN'});}
  }
  return out;
}
for(const regime of ['trend_up','trend_down','momentum','randomwalk'] as Regime[]){
  const recs=build(regime, 500+regime.length);
  const rep=buildMarketReading(recs, recs[recs.length-1].timestamp);
  const v=rep.venta.find(d=>d.horizon===rep.headlineHorizon)!;
  const c=rep.compra.find(d=>d.horizon===rep.headlineHorizon)!;
  console.log('════════',regime.toUpperCase(),'· horas',rep.observedHours,'· capturas/h',rep.capturesPerHour);
  console.log('  LECTURA :',rep.reading);
  console.log('  DECISIÓN:',rep.decision,'-',rep.decisionText);
  for(const [name,d] of [['VENTA ',v],['COMPRA',c]] as const){
    console.log(`  ${name}: ${d.model??'SIN MODELO'} | precio ${d.currentPrice.value?.toFixed(2)} -> ${d.projectedPrice.value?.toFixed(2)??'n/d'}`,
      '| mov',d.expectedMovePct.value!==null?d.expectedMovePct.value.toFixed(3)+'%':'n/d',
      '| err ±'+(d.historicalErrorPct.value?.toFixed(3)??'n/d')+'%',
      '| S/N',d.signalToNoise.value?.toFixed(2)??'n/d');
    console.log(`          régimen ${d.regime} | cont ${d.continuationProbability.value??'n/d'} | rev ${d.reversalProbability.value??'n/d'} (${d.analogCases} casos) | conf ${d.confidence} | -> ${d.decision}`);
  }
  console.log('  MOTIVO  :', v.reason.slice(0,230)+'…');
  console.log('');
}
