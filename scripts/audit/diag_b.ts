import { projectLeg, groupByDay } from '../../server/projection/dailyShape.js';
import { backtestLeg } from '../../server/projection/dailyBacktest.js';
import type { SeriesPoint } from '../../server/projection/series.js';

function rng(seed:number){let s=seed;return()=>{s=(s*1103515245+12345)&0x7fffffff;return s/0x7fffffff;};}
const rand=rng(11);
function normal(){const u=Math.max(rand(),1e-9),v=Math.max(rand(),1e-9);return Math.sqrt(-2*Math.log(u))*Math.cos(2*Math.PI*v);}

// 40 días, cada hora capturada 30 veces. Deriva alcista REAL y clara: +0.05%/h.
const vene=(day:number,hour:number,min:number)=>Date.UTC(2026,5,day,hour+4,min,0);
const points:SeriesPoint[]=[];
let price=900;
for(let day=1; day<=40; day++){
  for(let hour=0; hour<24; hour++){
    price *= 1 + 0.0005 + 0.0008*normal();     // deriva + ruido
    for(let k=0;k<30;k++) points.push({t:vene(day,hour,k*2), price: price*(1+0.0004*normal())});
  }
}
const now = vene(40, 12, 0);
const p = projectLeg(points,'VENTA',now,24);
const bt = backtestLeg(groupByDay(points,'VENTA'),'VENTA',24);

const anchor = p.anchorPrice!;
const expectedMovePct = p.projectedClose ? ((p.projectedClose.central-anchor)/anchor)*100 : NaN;
const maeAbs = bt.closeErrorModel!;
const maePct = (maeAbs/anchor)*100;

console.log('SERIE SINTÉTICA CON DERIVA ALCISTA REAL DE +0.05%/h (=> ~+1.2% en 24h)');
console.log('  precio ancla                :', anchor.toFixed(2));
console.log('  movimiento esperado 24h     :', expectedMovePct.toFixed(4)+'%');
console.log('  MAE del propio modelo (24h) :', maePct.toFixed(4)+'%');
console.log('  RELACIÓN SEÑAL/RUIDO        :', (Math.abs(expectedMovePct)/maePct).toFixed(3));
console.log('');
console.log('  dirección acertada          :', bt.directionHits+'/'+bt.directionTotal,
            bt.directionTotal? '('+((bt.directionHits/bt.directionTotal)*100).toFixed(1)+'%)':'');
console.log('  cobertura de la banda       :', bt.coverage!==null?(bt.coverage*100).toFixed(1)+'%':'n/a');
console.log('  bate a la persistencia      :', bt.beatsPersistence, '(p='+(bt.pValue?.toFixed(4) ?? 'n/a')+')');
console.log('  MAE persistencia            :', ((bt.closeErrorPersistence!/anchor)*100).toFixed(4)+'%');
