import { describe, expect, it } from 'vitest';
import { filterGeneralReferenceAds } from '../server/binanceP2PService.js';
import type { NormalizedAd } from '../server/types.js';

function ad(name: string, payType: string | null, tradeMethodName: string | null, price: number): NormalizedAd {
  return {
    advNo: name,
    price,
    minAmountVes: 1000,
    maxAmountVes: 1_000_000,
    availableUsdt: 1000,
    availableUsdtReported: 1000,
    merchantName: name,
    userType: 'merchant',
    ordersCount: 100,
    finishRate: 0.99,
    paymentMethods: tradeMethodName ? [tradeMethodName] : [],
    paymentOptions: [{ payType, tradeMethodName }],
  };
}

describe('general reference excludes Recarga Pines', () => {
  it('rejects the canonical payType', () => {
    const result = filterGeneralReferenceAds([
      ad('pines', 'RecargaPines', 'Recarga Pines', 999),
      ad('bank', 'Mercantil', 'Mercantil', 950),
    ]);

    expect(result.map((item) => item.advNo)).toEqual(['bank']);
  });

  it('rejects spacing/casing variants from the human-readable method name', () => {
    const result = filterGeneralReferenceAds([
      ad('pines', 'RECARGA-PINES', 'Recarga de Pines', 999),
      ad('bank', 'Banesco', 'Banesco', 950),
    ]);

    expect(result.map((item) => item.advNo)).toEqual(['bank']);
  });
});
