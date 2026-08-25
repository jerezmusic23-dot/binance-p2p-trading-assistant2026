import { describe, it, expect } from 'vitest';
import {
  canonicalPayTypes,
  countVerifications,
  filterVerifiedForBank,
  verifyBank,
} from '../server/bankMatching.js';
import { BANK_CODE_MAP, BinanceP2PService } from '../server/binanceP2PService.js';
import { AdPaymentMethod } from '../server/types.js';
import { makeAdItem } from './helpers/fixtures.js';

/** Payment options from (payType, tradeMethodName) pairs. */
const opts = (...pairs: [string | null, string | null][]): AdPaymentMethod[] =>
  pairs.map(([payType, tradeMethodName]) => ({ payType, tradeMethodName }));

/** The same code in both fields, the common case. */
const same = (...codes: string[]): AdPaymentMethod[] =>
  opts(...codes.map((c) => [c, c] as [string, string]));

const PROVINCIAL = BANK_CODE_MAP.PROVINCIAL.apiPayTypes; // ['BBVAProvincial', 'Provincial']
const VENEZUELA = BANK_CODE_MAP.VENEZUELA.apiPayTypes; // ['BancodeVenezuela']
const BANESCO = BANK_CODE_MAP.BANESCO.apiPayTypes; // ['Banesco']

describe('TEST 1 - exact payType accepts the bank', () => {
  it('verifies an ad whose payType equals a canonical code', () => {
    const result = verifyBank(same('BBVAProvincial'), PROVINCIAL);

    expect(result.verification).toBe('VERIFIED');
    expect(result.matchedPayType).toBe('BBVAProvincial');
  });

  it('accepts any of the codes the bank declares, not only the first', () => {
    expect(verifyBank(same('Provincial'), PROVINCIAL).matchedPayType).toBe('Provincial');
  });
});

describe('TEST 2 - a different payType rejects the bank', () => {
  it('does not verify a Banesco ad against Provincial', () => {
    const result = verifyBank(same('Banesco'), PROVINCIAL);

    expect(result.verification).toBe('NOT_VERIFIED');
    expect(result.matchedPayType).toBeNull();
    expect(result.reason).toContain('Banesco');
  });
});

describe('TEST 3 - a missing payType is NOT_VERIFIABLE', () => {
  it('returns NOT_VERIFIABLE when the ad declares no payment method at all', () => {
    const result = verifyBank([], BANESCO);

    expect(result.verification).toBe('NOT_VERIFIABLE');
    expect(result.matchedPayType).toBeNull();
  });

  it('returns NOT_VERIFIABLE when payType is null even though a label exists', () => {
    // A label alone can never establish membership.
    const result = verifyBank(opts([null, 'Banesco']), BANESCO);
    expect(result.verification).toBe('NOT_VERIFIABLE');
  });

  it('treats a blank payType as absent, not as a code', () => {
    expect(verifyBank(opts(['   ', 'Banesco']), BANESCO).verification).toBe('NOT_VERIFIABLE');
  });

  it('returns NOT_VERIFIABLE when the bank itself declares no canonical code', () => {
    const result = verifyBank(same('Banesco'), []);
    expect(result.verification).toBe('NOT_VERIFIABLE');
    expect(result.reason).toContain('BANK_CODE_MAP');
  });
});

describe('TEST 4 - a matching tradeMethodName never rescues a wrong payType', () => {
  it('rejects the bank when only the human-readable label matches', () => {
    // Binance sends the label 'Provincial (BBVA)' with the code of another
    // rail. Matching on the label would route the operation to the wrong bank.
    const result = verifyBank(opts(['Banesco', 'Provincial (BBVA)']), PROVINCIAL);

    expect(result.verification).toBe('NOT_VERIFIED');
    expect(result.matchedPayType).toBeNull();
  });

  it('rejects even when the label is exactly a canonical code of the bank', () => {
    const result = verifyBank(opts(['SomeOtherRail', 'BBVAProvincial']), PROVINCIAL);
    expect(result.verification).toBe('NOT_VERIFIED');
  });
});

describe('TEST 5 - a similar name is not a match', () => {
  it.each([
    'bbvaprovincial', // case folded
    'BBVA Provincial', // spaced
    'BBVAProvinciaI', // capital i for lowercase L
    'Provincial (BBVA)', // the display label
    'BBVAPROVINCIAL',
  ])('rejects %s', (code) => {
    expect(verifyBank(same(code), PROVINCIAL).verification).toBe('NOT_VERIFIED');
  });

  it('does not let leading or trailing whitespace pass as the same code', () => {
    expect(verifyBank(same(' BBVAProvincial'), PROVINCIAL).verification).toBe('NOT_VERIFIED');
  });
});

describe('TEST 6 - a partial code is not a match', () => {
  it.each([
    'BBVA', // prefix of BBVAProvincial
    'Provinci', // prefix of Provincial
    'BBVAProvincialPagoMovil', // the canonical code as a substring
    'XBBVAProvincial', // suffix containment
  ])('rejects %s', (code) => {
    expect(verifyBank(same(code), PROVINCIAL).verification).toBe('NOT_VERIFIED');
  });

  it('would have been accepted by includes() - which is exactly why it is not used', () => {
    const code = 'BBVAProvincialExtra';
    expect(PROVINCIAL.some((c) => code.includes(c))).toBe(true); // the wrong rule
    expect(verifyBank(same(code), PROVINCIAL).verification).toBe('NOT_VERIFIED'); // the right one
  });
});

describe('TEST 7 - an ad with several methods verifies on any exact match', () => {
  it('verifies when one of three payTypes matches exactly', () => {
    const result = verifyBank(same('PagoMovil', 'Banesco', 'BBVAProvincial'), PROVINCIAL);

    expect(result.verification).toBe('VERIFIED');
    expect(result.matchedPayType).toBe('BBVAProvincial');
  });

  it('still rejects when none of several payTypes matches', () => {
    expect(verifyBank(same('PagoMovil', 'Banesco', 'BNC'), PROVINCIAL).verification).toBe(
      'NOT_VERIFIED'
    );
  });

  it('lists every declared code, in order', () => {
    expect(canonicalPayTypes(same('PagoMovil', 'Banesco'))).toEqual(['PagoMovil', 'Banesco']);
  });
});

describe('TEST 8 - different banks never cross', () => {
  it('matches each bank only against itself', () => {
    const bankKeys = Object.keys(BANK_CODE_MAP);

    for (const owner of bankKeys) {
      for (const code of BANK_CODE_MAP[owner].apiPayTypes) {
        for (const candidate of bankKeys) {
          const expected = candidate === owner ? 'VERIFIED' : 'NOT_VERIFIED';
          expect(
            verifyBank(same(code), BANK_CODE_MAP[candidate].apiPayTypes).verification,
            `${code} against ${candidate}`
          ).toBe(expected);
        }
      }
    }
  });

  it('no canonical code is shared by two banks', () => {
    const seen = new Map<string, string>();
    for (const [bank, config] of Object.entries(BANK_CODE_MAP)) {
      for (const code of config.apiPayTypes) {
        expect(seen.has(code), `${code} declared by ${seen.get(code)} and ${bank}`).toBe(false);
        seen.set(code, bank);
      }
    }
  });

  it('Banco de Venezuela does not verify against Banesco despite the shared prefix', () => {
    expect(verifyBank(same('BancodeVenezuela'), BANESCO).verification).toBe('NOT_VERIFIED');
    expect(verifyBank(same('Banesco'), VENEZUELA).verification).toBe('NOT_VERIFIED');
  });
});

describe('TEST 9 - compatibility with the existing paymentMethods field', () => {
  it('keeps paymentMethods as the human-readable list it has always been', () => {
    const [ad] = BinanceP2PService.normalizeAds([
      makeAdItem({
        tradeMethods: [{ payType: 'BBVAProvincial', tradeMethodName: 'Provincial (BBVA)' }],
      }),
    ]);

    expect(ad.paymentMethods).toEqual(['Provincial (BBVA)']);
  });

  it('carries the canonical code alongside it, verbatim', () => {
    const [ad] = BinanceP2PService.normalizeAds([
      makeAdItem({
        tradeMethods: [{ payType: 'BBVAProvincial', tradeMethodName: 'Provincial (BBVA)' }],
      }),
    ]);

    expect(ad.paymentOptions).toEqual([
      { payType: 'BBVAProvincial', tradeMethodName: 'Provincial (BBVA)' },
    ]);
    expect(verifyBank(ad.paymentOptions, PROVINCIAL).verification).toBe('VERIFIED');
  });

  it('the old paymentMethods list alone could not have verified the bank', () => {
    // This is the FASE 0 contradiction, demonstrated: the label the previous
    // normalizer kept does not equal any canonical code.
    const label = 'Provincial (BBVA)';
    expect(PROVINCIAL).not.toContain(label);
  });

  it('still falls back to payType for the label when Binance sends no name', () => {
    const [ad] = BinanceP2PService.normalizeAds([
      makeAdItem({ tradeMethods: [{ payType: 'PagoMovil', tradeMethodName: '' }] }),
    ]);

    expect(ad.paymentMethods).toEqual(['PagoMovil']);
    expect(ad.paymentOptions[0].payType).toBe('PagoMovil');
  });
});

describe('population helpers', () => {
  const ads = [
    { paymentOptions: same('Banesco') },
    { paymentOptions: same('BBVAProvincial') },
    { paymentOptions: same('PagoMovil', 'Banesco') },
    { paymentOptions: [] as AdPaymentMethod[] },
  ];

  it('counts the three verdicts without dropping any ad', () => {
    const counts = countVerifications(ads, BANESCO);

    expect(counts).toEqual({ verified: 2, notVerified: 1, notVerifiable: 1 });
    expect(counts.verified + counts.notVerified + counts.notVerifiable).toBe(ads.length);
  });

  it('filtering keeps only VERIFIED ads - never the unverifiable ones', () => {
    expect(filterVerifiedForBank(ads, BANESCO)).toHaveLength(2);
    expect(filterVerifiedForBank(ads, VENEZUELA)).toHaveLength(0);
  });
});

describe('codes corrected from production evidence', () => {
  it('BNC verifies on BNCBancoNacional, the code Binance actually returns', () => {
    expect(verifyBank(same('BNCBancoNacional'), BANK_CODE_MAP.BNC.apiPayTypes).verification).toBe(
      'VERIFIED'
    );
    // The old configured value was never a real Binance code.
    expect(verifyBank(same('BNC'), BANK_CODE_MAP.BNC.apiPayTypes).verification).toBe('NOT_VERIFIED');
  });

  it('VENEZUELA verifies on BancoDeVenezuela - the capital D matters', () => {
    const codes = BANK_CODE_MAP.VENEZUELA.apiPayTypes;

    expect(verifyBank(same('BancoDeVenezuela'), codes).verification).toBe('VERIFIED');
    // One letter apart, and exact equality is exact.
    expect(verifyBank(same('BancodeVenezuela'), codes).verification).toBe('NOT_VERIFIED');
  });

  it('the corrected codes still cross no other bank', () => {
    for (const [bank, config] of Object.entries(BANK_CODE_MAP)) {
      for (const code of config.apiPayTypes) {
        for (const other of Object.keys(BANK_CODE_MAP)) {
          if (other === bank) continue;
          expect(
            verifyBank(same(code), BANK_CODE_MAP[other].apiPayTypes).verification,
            `${code} must not verify against ${other}`
          ).toBe('NOT_VERIFIED');
        }
      }
    }
  });

  it('BBVAProvincial is retained - absence of evidence is not evidence of absence', () => {
    // Provincial verifies on 'Provincial'; nothing observed proves
    // 'BBVAProvincial' is invalid, so it stays.
    expect(BANK_CODE_MAP.PROVINCIAL.apiPayTypes).toContain('BBVAProvincial');
    expect(BANK_CODE_MAP.PROVINCIAL.apiPayTypes).toContain('Provincial');
  });
});
