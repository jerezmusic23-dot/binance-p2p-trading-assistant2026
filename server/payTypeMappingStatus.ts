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

import {
  AdPaymentMethod,
  BankCodeConfig,
  BankMappingVerdict,
  PayTypeInspection,
  PayTypeMappingReport,
  PayTypeObservation,
} from './types.js';

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
  bankMap: Record<string, BankCodeConfig>,
  /** How much book produced these options. Reported verbatim when given. */
  inspected?: PayTypeInspection
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

  /*
   * Frequency and labels per code. An ad may publish several payment methods,
   * so the counts here add up to more than the number of ads.
   */
  const observations: PayTypeObservation[] = observedPayTypes
    .map((payType) => {
      const entries = observedOptions.filter((o) => o.payType === payType);
      const banks = Object.keys(bankMap).filter((b) => new Set(bankMap[b].apiPayTypes).has(payType));
      return {
        payType,
        tradeMethodNames: [...new Set(entries.map((e) => e.tradeMethodName).filter(isPresent))].sort(),
        count: entries.length,
        mapped: configured.has(payType),
        banks,
      };
    })
    .sort((a, b) => b.count - a.count || a.payType.localeCompare(b.payType));

  /*
   * Per bank: was one of its codes seen, or not?
   *
   * NOT_OBSERVED deliberately does NOT say "wrong". A bank with no ad in the
   * window looks exactly like a bank whose code is mistyped, and this sample
   * cannot tell them apart. Only a payType Binance actually returned can
   * justify correcting a code.
   */
  const bankVerdicts: BankMappingVerdict[] = Object.keys(bankMap).map((bank) => {
    const configuredCodes = bankMap[bank].apiPayTypes;
    const matched = configuredCodes.filter((code) => observedSet.has(code));
    return matched.length > 0
      ? {
          bank,
          configuredCodes,
          status: 'VERIFIED' as const,
          matchedCodes: matched,
          reason: `Observado en el libro con el codigo ${matched.join(', ')}.`,
        }
      : {
          bank,
          configuredCodes,
          status: 'NOT_OBSERVED' as const,
          matchedCodes: [],
          reason:
            `Ninguno de sus codigos (${configuredCodes.join(', ')}) apareci\u00f3 en la muestra. ` +
            'NO es prueba de que el codigo sea incorrecto: el banco puede no tener anuncios ahora. ' +
            'Un codigo solo se corrige contra un payType realmente devuelto por Binance.',
        };
  });

  const banksVerified = bankVerdicts.filter((v) => v.status === 'VERIFIED').map((v) => v.bank);
  const verifiedBanksSet = new Set(banksVerified);
  const banksNotObserved = bankVerdicts
    .filter((v) => !verifiedBanksSet.has(v.bank))
    .map((v) => v.bank);

  const base = {
    inspected,
    observations,
    observedUnmapped: observations.filter((o) => !o.mapped),
    bankVerdicts,
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
