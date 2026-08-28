/**
 * LAS 42 CELDAS, Y LA GARANTÍA DE QUE NINGUNA MIENTE.
 *
 * 7 bancos x 6 montos. Cada celda es una pregunta independiente, y lo único
 * que puede declararse EXECUTABLE es una pareja verificada CONJUNTAMENTE:
 *
 *   available(venta) >= amountVes / precio(compra)
 *
 * Los dos "mejores por lado" siguen existiendo y siguen siendo útiles - dicen
 * qué hay en cada lado cuando no hay operación - pero no forman una operación
 * entre ellos, porque se eligen por separado y la cantidad que la segunda
 * pierna debe mover la fija el precio de la primera.
 *
 * Esta es la comprobación de barrido: sobre la matriz entera, y sobre libros
 * generados para que las parejas incompatibles sean frecuentes, ninguna celda
 * marcada EXECUTABLE puede incumplir esa desigualdad.
 */

import { describe, expect, it } from 'vitest';
import { AMOUNT_TIERS, evaluateBankAmount } from '../server/executability.js';
import { buildCell, buildExecutableMatrix } from '../server/executableMatrix.js';
import { buildOpportunity, runOpportunityEngine } from '../server/opportunityEngine.js';
import { BANK_CODE_MAP } from '../server/binanceP2PService.js';
import type { BankAmountExecutability, NormalizedAd } from '../server/types.js';

const BANKS = Object.keys(BANK_CODE_MAP);

/** Deterministic generator: the same matrix every run. */
function rng(seed: number) {
  let state = seed;
  return () => {
    state = (state * 1103515245 + 12345) % 2147483648;
    return state / 2147483648;
  };
}

function ad(
  bank: string,
  advNo: string,
  price: number,
  availableUsdt: number
): NormalizedAd {
  const payType = BANK_CODE_MAP[bank].apiPayTypes[0];
  return {
    advNo,
    price,
    minAmountVes: 1_000,
    maxAmountVes: 200_000,
    availableUsdt,
    availableUsdtReported: availableUsdt,
    merchantName: 'Comerciante',
    userType: 'merchant',
    ordersCount: 120,
    finishRate: 0.98,
    paymentMethods: [payType],
    paymentOptions: [{ payType, tradeMethodName: payType }],
  };
}

/**
 * A full 7 x 6 matrix with awkward volumes.
 *
 * Volumes straddle the 10-110 USDT band the tiers actually need, so a good
 * share of the pairs are genuinely incompatible - which is the point: a sweep
 * where everything fits proves nothing about the check.
 */
function buildMatrix(seed = 20260829) {
  const random = rng(seed);
  const byBank: Record<string, Record<string, BankAmountExecutability>> = {};

  for (const bank of BANKS) {
    byBank[bank] = {};
    const base = 930 + Math.round(random() * 2000) / 100;

    for (const tier of AMOUNT_TIERS) {
      const buyAds = Array.from({ length: 1 + Math.floor(random() * 6) }, (_, i) =>
        ad(bank, `${bank}-${tier.key}-b${i}`, base + Math.round(random() * 800) / 100,
           5 + Math.round(random() * 12000) / 100)
      );
      const sellAds = Array.from({ length: 1 + Math.floor(random() * 6) }, (_, i) =>
        ad(bank, `${bank}-${tier.key}-s${i}`, base + Math.round(random() * 1600) / 100,
           5 + Math.round(random() * 12000) / 100)
      );

      byBank[bank][tier.key] = evaluateBankAmount({
        bank,
        allowedCodes: BANK_CODE_MAP[bank].apiPayTypes,
        amountVes: tier.val,
        buyAds,
        sellAds,
      });
    }
  }

  return byBank;
}

describe('las 42 celdas existen y son independientes', () => {
  const byBank = buildMatrix();

  it('7 bancos x 6 montos, ni una de menos', () => {
    expect(Object.keys(byBank)).toHaveLength(7);
    for (const bank of BANKS) {
      expect(Object.keys(byBank[bank]), bank).toHaveLength(6);
    }
    const cells = BANKS.flatMap((b) => Object.values(byBank[b]));
    expect(cells).toHaveLength(42);
  });

  it('cada celda lleva su propio banco y su propio monto, sin contagio', () => {
    for (const bank of BANKS) {
      for (const tier of AMOUNT_TIERS) {
        const cell = byBank[bank][tier.key];
        expect(cell.bank).toBe(bank);
        expect(cell.amountVes).toBe(tier.val);

        // Y toda pierna suya viene de un anuncio de ese banco y ese tramo.
        for (const quote of [...cell.buyQuotes, ...cell.sellQuotes]) {
          expect(quote.bank).toBe(bank);
          expect(quote.amountVes).toBe(tier.val);
          expect(quote.advNo.startsWith(`${bank}-${tier.key}-`)).toBe(true);
        }
      }
    }
  });
});

describe('ninguna oportunidad se construye con dos anuncios incompatibles', () => {
  const byBank = buildMatrix();
  const cells = BANKS.flatMap((b) => Object.values(byBank[b]));

  it('el barrido produce parejas de verdad, o no probaría nada', () => {
    const withPair = cells.filter((c) => c.pair !== null);
    const withoutPair = cells.filter((c) => c.pair === null);

    expect(withPair.length).toBeGreaterThan(5);
    expect(withoutPair.length).toBeGreaterThan(5);
  });

  it('toda pareja reportada cumple la aritmética, celda por celda', () => {
    for (const cell of cells) {
      if (cell.pair === null) continue;

      const required = cell.amountVes / cell.pair.buy.price;
      expect(cell.pair.usdtTraded, `${cell.bank} ${cell.amountVes}`).toBeCloseTo(required, 9);
      expect(cell.pair.sell.availableUsdt!, `${cell.bank} ${cell.amountVes}`)
        .toBeGreaterThanOrEqual(required);
      expect(cell.pair.buy.availableUsdt!, `${cell.bank} ${cell.amountVes}`)
        .toBeGreaterThanOrEqual(required);
    }
  });

  it('buildOpportunity lee la pareja, nunca los dos mejores por lado', () => {
    for (const cell of cells) {
      const operation = buildOpportunity(cell);

      if (cell.pair === null) {
        expect(operation, `${cell.bank} ${cell.amountVes}`).toBeNull();
        continue;
      }

      expect(operation!.buyAdvNo).toBe(cell.pair.buy.advNo);
      expect(operation!.sellAdvNo).toBe(cell.pair.sell.advNo);
    }
  });

  it('LA TRAMPA: hay celdas con ambos lados ejecutables y sin operación', () => {
    /*
     * Es el caso que el algoritmo secuencial no sabía expresar. Si nunca
     * apareciera, este barrido no estaría ejerciendo la comprobación conjunta.
     */
    const trap = cells.filter(
      (c) => c.pair === null && c.buyQuotes.length > 0 && c.sellQuotes.length > 0
    );

    expect(trap.length).toBeGreaterThan(0);
    for (const cell of trap) {
      expect(cell.noPairReason).toContain('ninguna pareja');
      // Y los diagnósticos por lado SIGUEN estando, que es para lo que sirven.
      expect(cell.bestExecutableBuy).not.toBeNull();
      expect(cell.bestExecutableSell).not.toBeNull();
    }
  });

  it('los dos mejores por lado NO son la operación cuando no casan', () => {
    const trap = cells.find(
      (c) => c.pair === null && c.buyQuotes.length > 0 && c.sellQuotes.length > 0
    )!;

    // Una operación con esos dos incumpliría la desigualdad, y por eso no existe.
    const wouldRequire = trap.amountVes / trap.bestExecutableBuy!.price;
    const sellCanTake = trap.bestExecutableSell!.availableUsdt ?? 0;
    expect(sellCanTake).toBeLessThan(wouldRequire);
    expect(buildOpportunity(trap)).toBeNull();
  });
});

describe('el motor y la vista dicen lo mismo sobre las mismas celdas', () => {
  const byBank = buildMatrix();

  it('EXECUTABLE en la vista implica una pareja verificada en el motor', () => {
    const now = Date.now();

    for (const bank of BANKS) {
      for (const tier of AMOUNT_TIERS) {
        const cell = byBank[bank][tier.key];
        const view = buildCell({
          cell,
          bankDisplayName: BANK_CODE_MAP[bank].displayName,
          amountKey: tier.key,
          capturedAt: now,
          nowMs: now,
          buyAdsEvaluated: cell.buyQuotes.length,
          sellAdsEvaluated: cell.sellQuotes.length,
        });

        if (view.status === 'EXECUTABLE') {
          expect(cell.pair, `${bank} ${tier.key}`).not.toBeNull();
          expect(cell.pair!.spreadPct).toBeGreaterThan(0);
          // Y la liquidez que muestra es la de la operación, no la del mejor por lado.
          expect(view.availableUsdt).toBe(
            Math.min(cell.pair!.buy.availableUsdt!, cell.pair!.sell.availableUsdt!)
          );
        } else {
          expect(view.reason, `${bank} ${tier.key}`).not.toBeNull();
        }
      }
    }
  });

  it('el motor completo no declara ninguna oportunidad sin pareja', () => {
    const result = runOpportunityEngine({ byBank, bankOrder: BANKS });

    for (const bank of BANKS) {
      for (const tier of AMOUNT_TIERS) {
        const declared = result.byBank[bank][tier.key];
        const cell = byBank[bank][tier.key];
        if (declared !== null) expect(cell.pair, `${bank} ${tier.key}`).not.toBeNull();
      }
    }

    // Y la mejor de todas, si existe, también cumple la aritmética.
    const best = result.bestOpportunity;
    if (best !== null) {
      expect(best.marginPct).toBeGreaterThan(0);
      expect(best.verification).toBe('VERIFIED');
      expect(best.marginVes).toBeCloseTo((best.amountVes * best.marginPct) / 100, 6);
    }
  });
});
