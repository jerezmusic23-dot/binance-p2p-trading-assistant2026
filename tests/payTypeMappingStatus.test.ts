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
    expect(r.configuredCodes).toContain('BancodeVenezuela');
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
