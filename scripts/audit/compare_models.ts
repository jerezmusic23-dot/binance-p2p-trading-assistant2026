import { buildHourlyGrid } from '../../server/projection/hourlyGrid.js';
import { runWalkForward, HORIZONS } from '../../server/projection/walkForward.js';
import { MODEL_LABEL } from '../../server/projection/forecastModels.js';
import type { HistoryRecord } from '../../server/types.js';

function rng(seed:number){let a=seed>>>0;return()=>{a=(a+0x6d2b79f5)>>>0;let t=a;t=Math.imul(t^(t>>>15),t|1);t^=t+Math.imul(t^(t>>>7),t|61);return ((t^(t>>>14))>>>0)/4294967296;};} // mulberry32: el LCG anterior desbordaba 2^53 y ciclaba
function mkNormal(seed:number){const r=rng(seed);return()=>{const u=Math.max(r(),1e-9),v=Math.max(r(),1e-9);return Math.sqrt(-2*Math.log(u))*Math.cos(2*Math.PI*v);};}

type Regime='trend'|'randomwalk'|'meanrevert'|'momentum';
function build(regime:Regime, seed:number, days=40): HistoryRecord[] {
  const N=mkNormal(seed); const out:HistoryRecord[]=[];
  let price=940, vel=0; const center=940;
  const t0=Date.UTC(2026,3,1,4,0,0);
  let hourIdx=0;
  for(let d=0; d<days; d++){
    for(let h=0; h<24; h++, hourIdx++){
      if(regime==='trend')        price*= 1+0.0006+0.0010*N();
      else if(regime==='randomwalk') price*= 1+0.0012*N();
      else if(regime==='meanrevert') price+= 0.30*(center-price)+1.0*N();
      else { vel = 0.85*vel + 0.0008*N(); price*= 1+vel; }   // momento autocorrelado
      const base=t0+hourIdx*3_600_000;
      for(let k=0;k<30;k++){
        const t=base+k*60_000;
        const p=price*(1+0.0004*N());
        out.push({id:`r${t}`,timestamp:t,dateStr:new Date(t).toISOString(),hour:0,
          buyPrice:p-2,sellPrice:p,spreadPct:0.2,bestBuyMerchant:'m',bestSellMerchant:'m',
          activeBuyAds:20,activeSellAds:20,source:'SYN'});
      }
    }
  }
  return out;
}

for (const regime of ['trend','momentum','randomwalk','meanrevert'] as Regime[]) {
  const grid = buildHourlyGrid(build(regime, 100+regime.length*7), 'VENTA');
  const rep  = runWalkForward(grid);
  console.log('════════ RÉGIMEN:', regime.toUpperCase(), '· horas observadas:', grid.observedHours);
  if(!rep.evaluable){ console.log('  ', rep.reason); continue; }
  console.log('  split: train', rep.split.trainHours, '| val', rep.split.validationHours, '| test', rep.split.testHours);
  for (const h of HORIZONS) {
    const chosen = rep.chosen[h];
    const t = rep.test.find(m=>m.horizon===h);
    const pad=(s:string,n:number)=>s.padEnd(n);
    if (!chosen || !t) { console.log('  h='+String(h).padStart(2)+'h  -> SIN MODELO ELEGIBLE (ninguno emite señal fiable)'); continue; }
    console.log('  h='+String(h).padStart(2)+'h  -> '+pad(chosen,15)+
      ' TEST: dir '+((t.directionAccuracy??0)*100).toFixed(1)+'%'+
      ' | señal '+(t.signalAccuracy!==null?(t.signalAccuracy*100).toFixed(1)+'%':'  n/a')+
      ' ('+t.signals+' señales, abst '+((t.abstentionRate??0)*100).toFixed(0)+'%)'+
      ' | MAPE '+(t.mape??0).toFixed(3)+'%');
  }
  console.log('');
}
