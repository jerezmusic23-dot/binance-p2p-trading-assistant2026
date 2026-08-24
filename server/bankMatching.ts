/**
 * Bank verification for P2P ads.
 *
 * One rule, and only one:
 *
 *     BANCO -> codigo canonico de Binance -> anuncio -> IGUALDAD EXACTA
 *
 * An ad belongs to a bank if and only if one of its canonical `payType` codes
 * is character-for-character identical to one of the codes declared for that
 * bank in BANK_CODE_MAP.apiPayTypes.
 *
 * There is no includes(), no startsWith(), no case folding, no accent
 * stripping, no similarity score and no fallback to the human-readable
 * tradeMethodName. Every one of those can quietly merge two different banks
 * into one, and an operation routed to the wrong bank does not settle.
 *
 * When the question cannot be answered - the ad carries no canonical code, or
 * the bank has no declared codes - the answer is NOT_VERIFIABLE. It is never
 * "probably yes".
 *
 * Pure module: no clock, no network, no filesystem, no global state.
 */

import { AdPaymentMethod, BankVerification } from './types.js';

export interface BankVerificationResult {
  verification: BankVerification;
  /** The canonical code that matched, verbatim. null unless VERIFIED. */
  matchedPayType: string | null;
  /** Why this verdict, in terms a reader can check against the data. */
  reason: string;
}

/** True for a string that actually carries a code, rather than being absent. */
function isPresent(value: string | null | undefined): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * The canonical codes an ad declares, verbatim and in order.
 *
 * Absent and blank codes are dropped - that is absence detection, not
 * normalization: no code here is ever altered before being compared.
 */
export function canonicalPayTypes(options: readonly AdPaymentMethod[]): string[] {
  return options.map((o) => o.payType).filter(isPresent);
}

/**
 * Decides whether an ad belongs to a bank.
 *
 * `allowedCodes` are that bank's BANK_CODE_MAP.apiPayTypes entries.
 * Comparison is exact string equality via Set membership.
 */
export function verifyBank(
  options: readonly AdPaymentMethod[],
  allowedCodes: readonly string[]
): BankVerificationResult {
  const declared = canonicalPayTypes(options);

  if (allowedCodes.length === 0) {
    return {
      verification: 'NOT_VERIFIABLE',
      matchedPayType: null,
      reason:
        'El banco no declara ningun codigo canonico en BANK_CODE_MAP: no hay referencia contra la que comparar.',
    };
  }

  if (declared.length === 0) {
    return {
      verification: 'NOT_VERIFIABLE',
      matchedPayType: null,
      reason:
        'El anuncio no trae ningun payType canonico de Binance. No se asume pertenencia: el dato falta.',
    };
  }

  // Exact equality. Set membership compares with ===, never as a substring.
  const allowed = new Set(allowedCodes);
  const matchedPayType = declared.find((code) => allowed.has(code)) ?? null;

  if (matchedPayType !== null) {
    return {
      verification: 'VERIFIED',
      matchedPayType,
      reason: `payType "${matchedPayType}" coincide exactamente con un codigo canonico del banco.`,
    };
  }

  return {
    verification: 'NOT_VERIFIED',
    matchedPayType: null,
    reason:
      `Ningun payType del anuncio (${declared.join(', ')}) coincide exactamente con ` +
      `los codigos del banco (${allowedCodes.join(', ')}).`,
  };
}

/** Keeps only the ads that were positively verified as belonging to the bank. */
export function filterVerifiedForBank<T extends { paymentOptions: AdPaymentMethod[] }>(
  ads: readonly T[],
  allowedCodes: readonly string[]
): T[] {
  return ads.filter((ad) => verifyBank(ad.paymentOptions, allowedCodes).verification === 'VERIFIED');
}

/** How an ad population splits across the three verdicts. */
export interface BankVerificationCounts {
  verified: number;
  notVerified: number;
  notVerifiable: number;
}

export function countVerifications<T extends { paymentOptions: AdPaymentMethod[] }>(
  ads: readonly T[],
  allowedCodes: readonly string[]
): BankVerificationCounts {
  const counts: BankVerificationCounts = { verified: 0, notVerified: 0, notVerifiable: 0 };
  for (const ad of ads) {
    const { verification } = verifyBank(ad.paymentOptions, allowedCodes);
    if (verification === 'VERIFIED') counts.verified += 1;
    else if (verification === 'NOT_VERIFIED') counts.notVerified += 1;
    else counts.notVerifiable += 1;
  }
  return counts;
}
