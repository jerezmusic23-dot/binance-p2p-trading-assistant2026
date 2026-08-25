/**
 * Is BANK_CODE_MAP.apiPayTypes actually the set of codes Binance sends?
 *
 * The codes in BANK_CODE_MAP were written by hand. Nothing in this repository
 * proves they match `adv.tradeMethods[].payType`, and the development
 * environment cannot reach p2p.binance.com to find out. A constant saying
 * "validated" would be a lie; this module derives the answer from what the
 * running server has actually OBSERVED instead.
 *
 * The failure this exists to prevent is silent: if no configured code matches
 * anything Binance sends, every ad is NOT_VERIFIED, every cell is null, every
 * opportunity is null and Telegram simply goes quiet - a broken mapping and a
 * bad market look identical from the outside. This report tells them apart.
 *
 * Pure module: no clock, no network, no filesystem, no global state.
 */

import { AdPaymentMethod, BankCodeConfig, PayTypeMappingReport } from './types.js';

function isPresent(value: string | null | undefined): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * Assesses the mapping against a population of observed ads.
 *
 * VERIFIED       - at least one observed payType matched a configured code
 *                  exactly. The mapping demonstrably works for that code.
 * NOT_VERIFIED   - ads carry canonical codes and NONE matches any configured
 *                  code. This is the loud failure: the mapping is wrong.
 * NOT_VERIFIABLE - nothing has been observed yet, or no observed ad carries a
 *                  canonical code. The question is still unanswered; it is
 *                  never answered optimistically.
 */
export function assessPayTypeMapping(
  observedOptions: readonly AdPaymentMethod[],
  bankMap: Record<string, BankCodeConfig>
): PayTypeMappingReport {
  const observedPayTypes = [...new Set(observedOptions.map((o) => o.payType).filter(isPresent))].sort();

  const configuredCodes = [
    ...new Set(Object.values(bankMap).flatMap((b) => b.apiPayTypes)),
  ].sort();
  const configured = new Set(configuredCodes);

  const matchedCodes = observedPayTypes.filter((code) => configured.has(code));
  const unmatchedObserved = observedPayTypes.filter((code) => !configured.has(code));

  /*
   * Set membership, like every other comparison in this chain. Array.includes
   * would be the same exact equality here, but the project's audit rule is
   * "no includes() when deciding a payType", and a rule that needs a caveat
   * to pass a grep is a rule that will eventually be misread.
   */
  const observedSet = new Set(observedPayTypes);
  const banksVerified = Object.keys(bankMap).filter((bank) =>
    bankMap[bank].apiPayTypes.some((code) => observedSet.has(code))
  );
  const verifiedBanksSet = new Set(banksVerified);
  const banksNotObserved = Object.keys(bankMap).filter((bank) => !verifiedBanksSet.has(bank));

  const base = {
    observedAdCount: observedOptions.length,
    observedPayTypes,
    configuredCodes,
    matchedCodes,
    unmatchedObserved,
    banksVerified,
    banksNotObserved,
  };

  if (observedPayTypes.length === 0) {
    return {
      ...base,
      status: 'NOT_VERIFIABLE',
      reason:
        observedOptions.length === 0
          ? 'Todavia no se ha observado ningun anuncio de Binance. El mapping no se ha podido comprobar.'
          : 'Ningun anuncio observado trae un payType canonico. El mapping no se ha podido comprobar.',
    };
  }

  if (matchedCodes.length === 0) {
    return {
      ...base,
      status: 'NOT_VERIFIED',
      reason:
        `Se observaron ${observedPayTypes.length} payType reales y NINGUNO coincide con los ` +
        `${configuredCodes.length} codigos configurados en BANK_CODE_MAP. El mapping es incorrecto: ` +
        `ningun anuncio podra verificarse y no existira ninguna oportunidad. ` +
        `Observados: ${observedPayTypes.join(', ')}.`,
    };
  }

  return {
    ...base,
    status: 'VERIFIED',
    reason:
      `${matchedCodes.length} de ${observedPayTypes.length} payType observados coinciden ` +
      `exactamente con codigos configurados (${matchedCodes.join(', ')}). ` +
      (banksNotObserved.length > 0
        ? `Sin observaciones todavia para: ${banksNotObserved.join(', ')}.`
        : 'Todos los bancos configurados se han observado.'),
  };
}

/** One line for the server log. Loud when the mapping is wrong. */
export function describeMappingForLog(report: PayTypeMappingReport): string {
  const prefix =
    report.status === 'NOT_VERIFIED'
      ? '[PayTypeMapping] *** MAPPING INCORRECTO ***'
      : `[PayTypeMapping] ${report.status}`;
  return `${prefix} ${report.reason}`;
}
