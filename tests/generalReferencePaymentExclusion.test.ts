import { describe, expect, it } from 'vitest';
import { filterGeneralReferenceAds } from '../server/binanceP2PService.js';
import type { NormalizedAd } from '../server/types.js';

const ad = (price: number, payType: string | null, tradeMethodName: string | null): NormalizedAd => ({
  advNo: `adv-${price}`,
  price,
  minAmountVes: 1,
  maxAmountVes: 1_000_000,
  availableUsdt: 100,
  availableUsdtReported: 100,
  merchantName: 'test',
  userType: 'user',
  ordersCount: 10,
  finishRate: 1,
  paymentMethods: tradeMethodName ? [tradeMethodName] : [],
  paymentOptions: [{ payType, tradeMethodName }],
});

describe('general market reference excludes Recarga Pines', () => {
  it('does not let RecargaPines supply a general reference price', () => {
    const ads = [
      ad(900, 'RecargaPines', 'Recarga Pines'),
      ad(940, 'Mercantil', 'Mercantil'),
      ad(945, 'PagoMovil', 'Pago Móvil'),
    ];

    expect(filterGeneralReferenceAds(ads).map((item) => item.price)).toEqual([940, 945]);
  });

  it('also excludes the human-readable Recarga Pines label when payType is absent', () => {
    const ads = [
      ad(901, null, 'Recarga Pines'),
      ad(940, 'Mercantil', 'Mercantil'),
    ];

    expect(filterGeneralReferenceAds(ads).map((item) => item.price)).toEqual([940]);
  });

  it('does not remove normal bank/payment methods', () => {
    const ads = [
      ad(940, 'Mercantil', 'Mercantil'),
      ad(941, 'Bancamiga', 'Bancamiga'),
      ad(942, 'PagoMovil', 'Pago Móvil'),
    ];

    expect(filterGeneralReferenceAds(ads)).toHaveLength(3);
  });
});
