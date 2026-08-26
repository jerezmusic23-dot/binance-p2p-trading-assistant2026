import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  assessPayTypeMapping,
  describeMappingForLog,
} from '../server/payTypeMappingStatus.js';
import { BANK_CODE_MAP } from '../server/binanceP2PService.js';
import { AdPaymentMethod } from '../server/types.js';

const opts = (...pairs: [string | null, string | null][]): AdPaymentMethod[] =>
  pairs.map(([payType, tradeMethodName]) => ({ payType, tradeMethodName }));

const same = (...codes: string[]): AdPaymentMethod[] =>
  opts(...codes.map((c) => [c, c] as [string, string]));

describe('NOT_VERIFIABLE - the question has not been answered', () => {
  it('reports NOT_VERIFIABLE when nothing has been observed', () => {
    const r = assessPayTypeMapping([], BANK_CODE_MAP);

    expect(r.status).toBe('NOT_VERIFIABLE');
    expect(r.observedAdCount).toBe(0);
    expect(r.reason).toContain('Todavia no se ha observado');
  });

  it('reports NOT_VERIFIABLE when ads carry no canonical code', () => {
    const r = assessPayTypeMapping(opts([null, 'Banesco'], ['  ', 'Mercantil']), BANK_CODE_MAP);

    expect(r.status).toBe('NOT_VERIFIABLE');
    expect(r.observedAdCount).toBe(2); // the ads WERE seen
    expect(r.observedPayTypes).toEqual([]); // but none carried a code
  });

  it('never reports VERIFIED without evidence', () => {
    expect(assessPayTypeMapping([], BANK_CODE_MAP).status).not.toBe('VERIFIED');
  });
});

describe('NOT_VERIFIED - the loud failure', () => {
  const wrong = same('BankTransferVES', 'MobilePaymentVE', 'SomeOtherRail');

  it('detects that no configured code matches anything Binance sends', () => {
    const r = assessPayTypeMapping(wrong, BANK_CODE_MAP);

    expect(r.status).toBe('NOT_VERIFIED');
    expect(r.matchedCodes).toEqual([]);
    expect(r.banksVerified).toEqual([]);
  });

  it('names the real codes so the mapping can be corrected from evidence', () => {
    const r = assessPayTypeMapping(wrong, BANK_CODE_MAP);

    expect(r.unmatchedObserved).toEqual(['BankTransferVES', 'MobilePaymentVE', 'SomeOtherRail']);
    expect(r.reason).toContain('BankTransferVES');
    expect(r.reason).toContain('ninguna oportunidad');
  });

  it('says nothing about which codes are CORRECT - only what was observed', () => {
    // The report is evidence, not a suggested mapping. It must not claim to
    // know which bank an unmatched code belongs to.
    const r = assessPayTypeMapping(wrong, BANK_CODE_MAP);
    expect(Object.keys(r)).not.toContain('suggestedMapping');
  });

  it('logs the wrong mapping loudly', () => {
    const line = describeMappingForLog(assessPayTypeMapping(wrong, BANK_CODE_MAP));
    expect(line).toContain('*** MAPPING INCORRECTO ***');
  });
});

describe('VERIFIED - evidence exists', () => {
  it('verifies on a single exact match and names the bank', () => {
    const r = assessPayTypeMapping(same('Banesco', 'UnknownRail'), BANK_CODE_MAP);

    expect(r.status).toBe('VERIFIED');
    expect(r.matchedCodes).toEqual(['Banesco']);
    expect(r.banksVerified).toEqual(['BANESCO']);
  });

  it('keeps the unobserved banks visible instead of implying they work', () => {
    const r = assessPayTypeMapping(same('Banesco'), BANK_CODE_MAP);

    expect(r.banksNotObserved).toContain('PROVINCIAL');
    expect(r.reason).toContain('Sin observaciones todavia');
  });

  it('matching is exact - a near-miss does not verify', () => {
    for (const near of ['banesco', 'BANESCO', 'Banesco ', 'BanescoPagoMovil']) {
      expect(assessPayTypeMapping(same(near), BANK_CODE_MAP).status).toBe('NOT_VERIFIED');
    }
  });

  it('reports the configured codes verbatim, for comparison', () => {
    const r = assessPayTypeMapping(same('Banesco'), BANK_CODE_MAP);
    expect(r.configuredCodes).toContain('BBVAProvincial');
    expect(r.configuredCodes).toContain('BancoDeVenezuela');
  });
});

describe('purity', () => {
  it('is deterministic for the same input', () => {
    const input = same('Banesco', 'PagoMovil');
    expect(assessPayTypeMapping(input, BANK_CODE_MAP)).toEqual(
      assessPayTypeMapping(input, BANK_CODE_MAP)
    );
  });

  it('does not mutate its input', () => {
    const input = same('Banesco');
    const copy = JSON.parse(JSON.stringify(input));
    assessPayTypeMapping(input, BANK_CODE_MAP);
    expect(input).toEqual(copy);
  });
});

describe('the comparison is exact equality, by construction', () => {
  it('no substring or case-insensitive rule can pass', () => {
    // A configured code embedded in a longer observed code must NOT verify.
    // String.includes would accept every one of these.
    for (const observed of [
      'BanescoPagoMovil', // configured code as a prefix
      'PagoMovilBanesco', // as a suffix
      'XBanescoX', // contained
      'banesco', // case folded
      ' Banesco', // padded
      'Banesc', // truncated
    ]) {
      const r = assessPayTypeMapping(same(observed), BANK_CODE_MAP);
      expect(r.status, `${observed} must not verify`).toBe('NOT_VERIFIED');
      expect(r.matchedCodes).toEqual([]);
    }
  });

  it('the exact code, and only the exact code, verifies', () => {
    expect(assessPayTypeMapping(same('Banesco'), BANK_CODE_MAP).matchedCodes).toEqual(['Banesco']);
  });

  it('an observed code that contains a configured one is reported as unmatched', () => {
    // It stays visible as evidence for correcting the mapping - it is just
    // never treated as a match.
    const r = assessPayTypeMapping(same('BanescoPagoMovil'), BANK_CODE_MAP);
    expect(r.unmatchedObserved).toEqual(['BanescoPagoMovil']);
  });

  it('the module contains no includes() at all', () => {
    const code = fs
      .readFileSync(path.join(process.cwd(), 'server', 'payTypeMappingStatus.ts'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '');

    expect(code).not.toContain('includes(');
    expect(code).not.toContain('startsWith(');
    expect(code).not.toContain('toLowerCase(');
  });
});

describe('per-bank verdict: VERIFIED vs NOT_OBSERVED', () => {
  /** The real Venezuelan book as production reported it. */
  const REAL_BOOK = opts(
    ['BancoDeVenezuela', 'Banco de Venezuela'],
    ['BANK', 'Transferencia bancaria'],
    ['Mercantil', 'Mercantil'],
    ['PagoMovil', 'Pago Movil'],
    ['Provincial', 'Provincial'],
    ['RecargaPines', 'Recarga Pines'],
    ['Banesco', 'Banesco'],
    ['BancoDelTesoro', 'Banco del Tesoro']
  );

  it('marks a bank VERIFIED only when one of its codes was actually seen', () => {
    const r = assessPayTypeMapping(REAL_BOOK, BANK_CODE_MAP);
    const verdict = (bank: string) => r.bankVerdicts.find((v) => v.bank === bank)!;

    expect(verdict('BANESCO').status).toBe('VERIFIED');
    expect(verdict('MERCANTIL').status).toBe('VERIFIED');
    expect(verdict('PAGO_MOVIL').status).toBe('VERIFIED');
    expect(verdict('PROVINCIAL').status).toBe('VERIFIED');
    expect(verdict('PROVINCIAL').matchedCodes).toEqual(['Provincial']); // not BBVAProvincial
  });

  it('NOT_OBSERVED never claims the configured code is wrong', () => {
    const r = assessPayTypeMapping(REAL_BOOK, BANK_CODE_MAP);
    const bnc = r.bankVerdicts.find((v) => v.bank === 'BNC')!;

    expect(bnc.status).toBe('NOT_OBSERVED');
    expect(bnc.matchedCodes).toEqual([]);
    expect(bnc.reason).toContain('NO es prueba de que el codigo sea incorrecto');
    expect(bnc.reason).not.toMatch(/incorrecto\.|invalido|erroneo/);
  });

  it('a near-miss code is NOT_OBSERVED, and the real code shows up unmapped', () => {
    /*
     * The whole point of the distinction, and how the VENEZUELA code was
     * actually found: the configured code differed from Binance's by one
     * letter, so the bank could not verify, AND the real code surfaced as
     * evidence. Neither half is a conclusion on its own; together they
     * justified a correction.
     *
     * Demonstrated here against a bank map deliberately carrying the old
     * typo, so the behaviour stays pinned even though BANK_CODE_MAP has
     * since been corrected from exactly this evidence.
     */
    const mapWithTypo = {
      ...BANK_CODE_MAP,
      VENEZUELA: { code: 'VENEZUELA', displayName: 'Banco de Venezuela', apiPayTypes: ['BancodeVenezuela'] },
    };
    const r = assessPayTypeMapping(REAL_BOOK, mapWithTypo);

    expect(r.bankVerdicts.find((v) => v.bank === 'VENEZUELA')!.status).toBe('NOT_OBSERVED');
    expect(r.observedUnmapped.map((o) => o.payType)).toContain('BancoDeVenezuela');
  });

  it('the corrected VENEZUELA code now verifies against the real book', () => {
    const r = assessPayTypeMapping(REAL_BOOK, BANK_CODE_MAP);
    const venezuela = r.bankVerdicts.find((v) => v.bank === 'VENEZUELA')!;

    expect(venezuela.status).toBe('VERIFIED');
    expect(venezuela.matchedCodes).toEqual(['BancoDeVenezuela']);
    expect(r.observedUnmapped.map((o) => o.payType)).not.toContain('BancoDeVenezuela');
  });

  it('every configured bank gets exactly one verdict', () => {
    const r = assessPayTypeMapping(REAL_BOOK, BANK_CODE_MAP);

    expect(r.bankVerdicts).toHaveLength(Object.keys(BANK_CODE_MAP).length);
    expect(r.bankVerdicts.map((v) => v.bank).sort()).toEqual(Object.keys(BANK_CODE_MAP).sort());
  });
});

describe('observations: frequency, labels and mapping', () => {
  const book = opts(
    ['Banesco', 'Banesco'],
    ['Banesco', 'Banesco'],
    ['Banesco', 'Banesco Panama'],
    ['RecargaPines', 'Recarga Pines'],
    [null, 'Sin codigo']
  );

  it('counts every payment-method entry, not every ad', () => {
    const r = assessPayTypeMapping(book, BANK_CODE_MAP);
    const banesco = r.observations.find((o) => o.payType === 'Banesco')!;

    expect(banesco.count).toBe(3);
    expect(r.observations).toHaveLength(2); // the null entry carries no code
  });

  it('keeps every label seen for a code, verbatim, without picking one', () => {
    const banesco = assessPayTypeMapping(book, BANK_CODE_MAP).observations.find(
      (o) => o.payType === 'Banesco'
    )!;

    expect(banesco.tradeMethodNames).toEqual(['Banesco', 'Banesco Panama']);
  });

  it('sorts by frequency, so the dominant rails are visible first', () => {
    const r = assessPayTypeMapping(book, BANK_CODE_MAP);
    expect(r.observations[0].payType).toBe('Banesco');
  });

  it('says which banks claim a code, and marks the unmapped ones', () => {
    const r = assessPayTypeMapping(book, BANK_CODE_MAP);

    expect(r.observations.find((o) => o.payType === 'Banesco')!.banks).toEqual(['BANESCO']);
    const pines = r.observations.find((o) => o.payType === 'RecargaPines')!;
    expect(pines.mapped).toBe(false);
    expect(pines.banks).toEqual([]);
  });
});

describe('inspection window', () => {
  it('reports how much book produced the verdict', () => {
    const r = assessPayTypeMapping(same('Banesco'), BANK_CODE_MAP, {
      buyAds: 20,
      sellAds: 20,
      totalAds: 40,
      paymentMethodEntries: 70,
    });

    expect(r.inspected).toEqual({
      buyAds: 20,
      sellAds: 20,
      totalAds: 40,
      paymentMethodEntries: 70,
    });
  });

  it('omits the window rather than inventing one', () => {
    expect(assessPayTypeMapping(same('Banesco'), BANK_CODE_MAP).inspected).toBeUndefined();
  });

  it('an empty sample leaves every bank NOT_OBSERVED, none wrong', () => {
    const r = assessPayTypeMapping([], BANK_CODE_MAP, {
      buyAds: 0,
      sellAds: 0,
      totalAds: 0,
      paymentMethodEntries: 0,
    });

    expect(r.status).toBe('NOT_VERIFIABLE');
    expect(r.bankVerdicts.every((v) => v.status === 'NOT_OBSERVED')).toBe(true);
    expect(r.observations).toEqual([]);
    expect(r.observedUnmapped).toEqual([]);
  });
});
