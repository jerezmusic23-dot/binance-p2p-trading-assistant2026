import { projectLeg, groupByDay } from '../../server/projection/dailyShape.js';
import { backtestLeg } from '../../server/projection/dailyBacktest.js';
import { buildDailyProjection } from '../../server/dailyProjection.js';
import type { SeriesPoint } from '../../server/projection/series.js';
import type { HistoryRecord } from '../../server/types.js';

function rng(seed:number){let s=seed;return()=>{s=(s*1103515245+12345)&0x7fffffff;return s/0x7fffffff;};}
function mk(seed:number){const rand=rng(seed);return()=>{const u=Math.max(rand(),1e-9),v=Math.max(rand(),1e-9);return Math.sqrt(-2*Math.log(u))*Math.cos(2*Math.PI*v);};}
const vene=(day:number,hour:number,min:number)=>Date.UTC(2026,5,day,hour+4,min,0);

function build(regime:'randomwalk'|'meanrevert', seed:number){
  const normal=mk(seed);
  const points:SeriesPoint[]=[]; const records:HistoryRecord[]=[];
  let price=940; const center=940;
  for(let day=1; day<=40; day++){
    for(let hour=0; hour<24; hour++){
      if(regime==='randomwalk') price *= 1 + 0.0010*normal();
      else price += 0.25*(center-price) + 0.9*normal();
      for(let k=0;k<30;k++){
        const t=vene(day,hour,k*2), p=price*(1+0.0004*normal());
        points.push({t,price:p});
        records.push({id:`r${t}${k}`,timestamp:t,dateStr:new Date(t).toISOString(),hour,
          buyPrice:p-2, sellPrice:p, spreadPct:0.2, bestBuyMerchant:'m',bestSellMerchant:'m',
          activeBuyAds:20,activeSellAds:20,source:'SYN'});
      }
    }
  }
  return {points, records};
}

for (const regime of ['randomwalk','meanrevert'] as const){
  const {points,records}=build(regime, regime==='randomwalk'?21:33);
  const now = vene(40,12,0);
  const p  = projectLeg(points,'VENTA',now,24);
  const bt = backtestLeg(groupByDay(points,'VENTA'),'VENTA',24);
  const rep= buildDailyProjection(records, now);
  const venta = rep.legs.find(l=>l.projection.leg==='VENTA')!;

  const anchor=p.anchorPrice!;
  const em = p.projectedClose ? ((p.projectedClose.central-anchor)/anchor)*100 : NaN;
  const mae = (bt.closeErrorModel!/anchor)*100;
  console.log('REGIMEN:', regime.toUpperCase(), '(sin capacidad predictiva real de dirección)');
  console.log('  movimiento esperado 24h :', em.toFixed(4)+'%');
  console.log('  MAE del modelo          :', mae.toFixed(4)+'%');
  console.log('  SEÑAL/RUIDO             :', (Math.abs(em)/mae).toFixed(3), Math.abs(em)/mae<1?'  <-- la señal es MENOR que el error':'');
  console.log('  dirección acertada      :', bt.directionHits+'/'+bt.directionTotal,
      bt.directionTotal?'('+((bt.directionHits/bt.directionTotal)*100).toFixed(1)+'%)':'');
  console.log('  cobertura banda         :', bt.coverage!==null?(bt.coverage*100).toFixed(1)+'%':'n/a');
  console.log('  bate persistencia       :', bt.beatsPersistence);
  console.log('  >>> LO QUE LA PANTALLA MUESTRA HOY:');
  console.log('      dirección =', venta.market.direction, '| fuerza =', venta.market.speed,
              '| estado =', rep.state);
  console.log('      (no existe ninguna salida "no sé" en este camino)');
  console.log('');
}
