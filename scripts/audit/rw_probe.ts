import { buildHourlyGrid } from '../../server/projection/hourlyGrid.js';
import { runWalkForward, HORIZONS } from '../../server/projection/walkForward.js';
import type { HistoryRecord } from '../../server/types.js';
function rng(seed:number){let a=seed>>>0;return()=>{a=(a+0x6d2b79f5)>>>0;let t=a;t=Math.imul(t^(t>>>15),t|1);t^=t+Math.imul(t^(t>>>7),t|61);return ((t^(t>>>14))>>>0)/4294967296;};} // mulberry32: el LCG anterior desbordaba 2^53 y ciclaba
function nrm(seed:number){const r=rng(seed);return()=>{const u=Math.max(r(),1e-9),v=Math.max(r(),1e-9);return Math.sqrt(-2*Math.log(u))*Math.cos(2*Math.PI*v);};}
const T0=Date.UTC(2026,3,1,4,0,0);
function synth(hours:number,seed:number,perHour=12){const N=nrm(seed);const out:HistoryRecord[]=[];let price=940;
 for(let h=0;h<hours;h++){price*=1+0.0012*N();const base=T0+h*3_600_000;
  for(let k=0;k<perHour;k++){const p=price*(1+0.0002*N());const t=base+k*60_000;
   out.push({id:`r${t}`,timestamp:t,dateStr:new Date(t).toISOString(),hour:0,buyPrice:p-2,sellPrice:p,
     spreadPct:0.2,bestBuyMerchant:'m',bestSellMerchant:'m',activeBuyAds:20,activeSellAds:20,source:'T'});}}
 return out;}
const grid=buildHourlyGrid(synth(600,37),'VENTA');
const wf=runWalkForward(grid);
console.log('horas',grid.observedHours,'split',wf.split.trainHours,wf.split.validationHours,wf.split.testHours);
for(const h of HORIZONS){
  const ch=wf.chosen[h];
  if(!ch){console.log('h='+h,'-> sin modelo');continue;}
  const v=wf.validation.find(m=>m.horizon===h&&m.model===ch)!;
  const t=wf.test.find(m=>m.horizon===h)!;
  console.log('h='+String(h).padStart(2),'->',ch,
    '| VAL señal',(v.signalAccuracy!*100).toFixed(1)+'% ('+v.signalHits+'/'+v.signals+')',
    '| TEST señal',t.signalAccuracy!==null?(t.signalAccuracy*100).toFixed(1)+'% ('+t.signalHits+'/'+t.signals+')':'n/a',
    '| TEST dir',t.directionAccuracy!==null?(t.directionAccuracy*100).toFixed(1)+'%':'n/a');
}
