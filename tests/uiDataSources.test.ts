/**
 * WHERE THE INTERFACE GETS ITS NUMBERS
 *
 * These are STATIC SOURCE ASSERTIONS, not behavioural tests, and that is the
 * point. The defect FASE 5 removed was not a wrong calculation - the backend
 * had computed the right answer for two phases already. The defect was that
 * the interface reached for a different field.
 *
 * A behavioural test cannot catch that coming back: someone re-adds one line
 * reading snapshot.strategicBuyPrice into an opportunity card and every unit
 * test still passes. So these tests read the component sources and assert
 * which structure each one is allowed to touch.
 *
 * None of this is evidence about the market. It is evidence about wiring.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const SRC = path.join(process.cwd(), 'src');
const SERVER = path.join(process.cwd(), 'server');

const read = (dir: string, file: string) => readFileSync(path.join(dir, file), 'utf8');

/** Source with block and line comments removed - only code is asserted on. */
function code(dir: string, file: string): string {
  return read(dir, file)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

describe('TEST 8 - the Header never presents an executable rate', () => {
  it('labels the global medians as a reference', () => {
    const header = read(SRC, 'Header.tsx');

    expect(header).toMatch(/Referencia/i);
    expect(header).toMatch(/no ejecutable/i);
  });

  it('no longer calls the global medians a "Tasa"', () => {
    const header = code(SRC, 'Header.tsx');

    expect(header).not.toMatch(/Tasa Venta/);
    expect(header).not.toMatch(/Tasa Recompra/);
  });

  it('does not import the executable matrix - it is not the Header\'s job', () => {
    const header = code(SRC, 'Header.tsx');
    expect(header).not.toMatch(/executableMatrix/);
  });
});

describe('TEST 9 - MainOverview never builds an opportunity from the global snapshot', () => {
  it('delegates the opportunity to the card fed by the backend', () => {
    const overview = code(SRC, 'MainOverview.tsx');
    expect(overview).toMatch(/OpportunityCard/);
  });

  it('labels its global card as reference, not as a rate', () => {
    const overview = read(SRC, 'MainOverview.tsx');

    expect(overview).toMatch(/Mercado global \(referencia\)/);
    expect(overview).not.toMatch(/1\. Tasa Real Actual/);
  });

  it('states in the card that the global level is not executable', () => {
    const overview = read(SRC, 'MainOverview.tsx');
    expect(overview).toMatch(/NO es una tasa ejecutable/);
  });

  it('renders the opportunities even when the global reference is missing', () => {
    /*
     * The two paths read different ads through different endpoints. Gating the
     * executable rates on the global median - as this component used to -
     * hides real opportunities whenever the reference happens to be absent.
     */
    const overview = read(SRC, 'MainOverview.tsx');
    const guard = overview.slice(
      overview.indexOf('if (!snapshot || snapshot.strategicBuyPrice === null)'),
      overview.indexOf('const getTrendIcon')
    );

    expect(guard).toMatch(/<OpportunityCard \/>/);
  });
});

describe('TEST 14 - no component derives an opportunity from global prices', () => {
  /*
   * strategicBuyPrice / strategicSellPrice may still be RENDERED as context -
   * they are the market level and that is legitimate. What they may never do
   * is appear in a component that declares an opportunity.
   */
  const OPPORTUNITY_COMPONENTS = ['OpportunityCard.tsx', 'BankMatrix.tsx'];

  for (const file of OPPORTUNITY_COMPONENTS) {
    it(`${file} never reads a global price`, () => {
      const src = code(SRC, file);

      expect(src).not.toMatch(/strategicBuyPrice/);
      expect(src).not.toMatch(/strategicSellPrice/);
      expect(src).not.toMatch(/strategicSpreadPct/);
      expect(src).not.toMatch(/bestBuyPrice/);
      expect(src).not.toMatch(/bestSellPrice/);
    });
  }

  it('OrderBookView keeps its "Mejor" label - it really is the best of the book', () => {
    /*
     * NOT a defect and deliberately left alone. This component renders the
     * order book itself, where the best level is exactly what it claims to be.
     * Removing a correct concept for sharing a word with an incorrect one
     * would be a different mistake.
     */
    const orderBook = read(SRC, 'OrderBookView.tsx');

    expect(orderBook).toMatch(/bestBuyPrice/);
    expect(orderBook).toMatch(/Mejor/);
    expect(code(SRC, 'OrderBookView.tsx')).not.toMatch(/OPORTUNIDAD|EXECUTABLE/);
  });
});

describe('TEST 10 - BankMatrix consumes the executable matrix and nothing else', () => {
  it('calls getExecutableMatrix', () => {
    const matrix = code(SRC, 'BankMatrix.tsx');

    expect(matrix).toMatch(/ApiService\.getExecutableMatrix/);
    expect(matrix).not.toMatch(/getBankMatrix/);
  });

  it('renders cells from executableMatrix.cells', () => {
    const matrix = code(SRC, 'BankMatrix.tsx');
    expect(matrix).toMatch(/matrix\.cells/);
  });

  it('no longer references the removed structure', () => {
    const matrix = code(SRC, 'BankMatrix.tsx');

    expect(matrix).not.toMatch(/ratesByAmount/);
    expect(matrix).not.toMatch(/leaderPrice/);
    expect(matrix).not.toMatch(/suggestedPrice/);
  });

  it('shows every cell state instead of hiding the blocked ones', () => {
    const matrix = read(SRC, 'BankMatrix.tsx');

    for (const status of [
      'EXECUTABLE',
      'NO_OPPORTUNITY',
      'NO_LIQUIDITY',
      'INSUFFICIENT_LIQUIDITY',
      'NO_AD',
      'STALE',
      'NOT_VERIFIABLE',
      'ERROR',
    ]) {
      expect(matrix).toContain(status);
    }
  });

  it('shows bank, amount, both prices, spread and liquidity per cell', () => {
    const matrix = read(SRC, 'BankMatrix.tsx');

    expect(matrix).toMatch(/bankDisplayNames/);
    expect(matrix).toMatch(/amountKeys/);
    expect(matrix).toMatch(/Compra/);
    expect(matrix).toMatch(/Venta/);
    expect(matrix).toMatch(/Spread/);
    expect(matrix).toMatch(/Liquidez/);
  });
});

describe('TEST 11 / 12 - one source of truth for the opportunity', () => {
  it('the UI reads the same endpoint the notifier is fed from', () => {
    const card = code(SRC, 'OpportunityCard.tsx');
    expect(card).toMatch(/getOpportunities/);

    const api = code(SRC, 'api.ts');
    expect(api).toMatch(/\/api\/market\/opportunities/);
  });

  it('the store hands Telegram the SAME object the endpoint serves', () => {
    /*
     * getOpportunities() returns this.lastOpportunities, and the notifier is
     * called with this.lastOpportunities.bestOpportunity. One value, two
     * readers - there is no second calculation for Telegram to disagree with.
     */
    const store = code(SERVER, 'centralStore.ts');

    expect(store).toMatch(/notifyOpportunityLifecycle\(\s*\n?\s*this\.lastOpportunities\.bestOpportunity/);
    expect(store).toMatch(/result: this\.lastOpportunities/);
  });

  it('the OPPORTUNITY messages are built from the Opportunity alone', () => {
    /*
     * Scoped to the two opportunity formatters on purpose.
     *
     * strategicLines() DOES read the global medians, and correctly: it is used
     * by the price-threshold alerts (ABOVE / BELOW / SPREAD_ABOVE), which are
     * statements about where the market is - exactly what the global level
     * measures. Banning it outright would delete a correct use.
     *
     * What must never happen is an OPPORTUNITY message carrying a global
     * price, because that would let Telegram announce an operation nobody can
     * execute. These two functions may only read the Opportunity.
     */
    const notifier = code(SERVER, 'telegramNotifier.ts');
    const opportunityFormatters =
      notifier.slice(
        notifier.indexOf('export function formatOpportunityMessage'),
        notifier.indexOf('export function formatAlertMessage')
      ) +
      notifier.slice(
        notifier.indexOf('export function formatOpportunityLifecycleMessage'),
        notifier.indexOf('export function formatSystemAlertMessage')
      );

    expect(opportunityFormatters.length).toBeGreaterThan(500);
    expect(opportunityFormatters).not.toMatch(/strategic/);
    expect(opportunityFormatters).not.toMatch(/bestBuyPrice|bestSellPrice/);
    expect(opportunityFormatters).not.toMatch(/strategicLines/);
    // It names bank and amount, which only an executable cell can supply.
    expect(opportunityFormatters).toMatch(/opportunity\.bank/);
    expect(opportunityFormatters).toMatch(/opportunity\.amountVes/);
  });

  it('the notifier never evaluates executability itself', () => {
    const notifier = code(SERVER, 'telegramNotifier.ts');
    expect(notifier).not.toMatch(/evaluateAd|evaluateBankTiers|buildExecutableMatrix/);
  });

  it('the notifier reports MARGEN BRUTO, never net profit', () => {
    const notifier = read(SERVER, 'telegramNotifier.ts');

    expect(notifier).toMatch(/MARGEN BRUTO/);
    expect(notifier).toMatch(/NO es beneficio neto/);
  });
});

describe('TEST 12 (backend) - no Math.abs on an economic spread', () => {
  it('the executable matrix module contains no Math.abs at all', () => {
    expect(code(SERVER, 'executableMatrix.ts')).not.toMatch(/Math\.abs/);
  });

  it('the executability evaluator contains no Math.abs at all', () => {
    expect(code(SERVER, 'executability.ts')).not.toMatch(/Math\.abs/);
  });

  it('the opportunity engine contains no Math.abs at all', () => {
    expect(code(SERVER, 'opportunityEngine.ts')).not.toMatch(/Math\.abs/);
  });

  it('the only Math.abs left in the capture layer is the RAW audit trail', () => {
    /*
     * binanceP2PService still computes spreadAbsolute with Math.abs. It feeds
     * HistoryRecord.spreadPct - the raw extreme spread kept as an audit trail -
     * and NOTHING else. It reaches no opportunity, no cell and no screen.
     */
    const service = code(SERVER, 'binanceP2PService.ts');
    const occurrences = service.match(/Math\.abs/g) ?? [];
    expect(occurrences).toHaveLength(1);
    expect(service).toMatch(/spreadAbsolute[\s\S]{0,200}Math\.abs/);

    for (const file of ['MainOverview.tsx', 'BankMatrix.tsx', 'OpportunityCard.tsx', 'Header.tsx']) {
      expect(code(SRC, file)).not.toMatch(/Math\.abs/);
    }
  });
});

describe('TEST 13 - the leader-plus-one-cent path is gone', () => {
  it('no server module builds a suggested price by undercutting the leader', () => {
    for (const file of ['centralStore.ts', 'executableMatrix.ts', 'executability.ts']) {
      const src = code(SERVER, file);
      expect(src).not.toMatch(/leaderPrice/);
      expect(src).not.toMatch(/suggestedPrice/);
      expect(src).not.toMatch(/\+ 0\.01/);
    }
  });

  it('no client module does either', () => {
    for (const file of ['BankMatrix.tsx', 'OpportunityCard.tsx', 'types.ts', 'api.ts']) {
      const src = code(SRC, file);
      expect(src).not.toMatch(/leaderPrice/);
      expect(src).not.toMatch(/suggestedPrice/);
    }
  });

  it('the parallel min/max filter no longer exists', () => {
    const store = code(SERVER, 'centralStore.ts');

    expect(store).not.toMatch(/matchingBuyAds/);
    expect(store).not.toMatch(/matchingSellAds/);
  });
});

describe('the request budget stayed flat', () => {
  it('the matrix refresh issues one query per bank per side and no transAmount', () => {
    const store = code(SERVER, 'centralStore.ts');

    // Exactly two queryP2PAds calls inside refreshBankMatrix.
    const refresh = store.slice(
      store.indexOf('private async refreshBankMatrix'),
      store.indexOf('private evaluateAlerts')
    );
    const calls = refresh.match(/BinanceP2PService\.queryP2PAds\(/g) ?? [];

    expect(calls).toHaveLength(2);
    expect(refresh).not.toMatch(/transAmount/);
    expect(refresh).toMatch(/rows: 20/);
  });
});

describe('the API names the two structures apart', () => {
  it('serves marketReference and executableMatrix as separate keys', () => {
    const routes = code(SERVER, 'routes.ts');
    expect(routes).toMatch(/res\.json\(\{ marketReference, executableMatrix \}\)/);
  });

  it('no longer accepts a tradeType for the matrix - a cell is an operation', () => {
    const routes = code(SERVER, 'routes.ts');
    const handler = routes.slice(
      routes.indexOf("apiRouter.get('/market/matrix'"),
      routes.indexOf("apiRouter.get('/market/opportunities'")
    );
    expect(handler).not.toMatch(/tradeType/);
  });
});
