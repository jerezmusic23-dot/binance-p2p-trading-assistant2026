import { Router } from 'express';
import { dailyProjectionFromStorage } from './dailyProjection.js';
import { StorageEngine } from './storage.js';

const CLEAN_GENERAL_REFERENCE = 'v4-no-recarga-pines';

type GeneralProjectionRecord = {
  generalReferenceVersion?: string;
};

export const cleanDailyProjectionRouter = Router();

/**
 * General projection endpoint.
 *
 * Existing HistoryRecord entries predate payment-method provenance, so they
 * cannot be retrospectively classified as Recarga Pines or non-Recarga Pines.
 * They must remain usable: throwing away the existing history would make the
 * projection report SIN_DATOS immediately after this fix.
 *
 * New captures are tagged by marketContext only after the live general
 * snapshot has removed Recarga Pines ads. Once the historical store has been
 * naturally replaced by tagged observations, the provenance boundary can be
 * tightened without destroying the working history today.
 */
cleanDailyProjectionRouter.get('/market/projections/daily', (_req, res) => {
  try {
    const records = StorageEngine.getHistory();

    // Keep legacy records for continuity. The marker is intentionally read so
    // the provenance contract stays explicit without treating missing
    // provenance as proof that a historical observation was contaminated.
    const taggedCount = records.filter(
      (record) => (record as GeneralProjectionRecord).generalReferenceVersion === CLEAN_GENERAL_REFERENCE
    ).length;

    res.setHeader('X-General-Reference-Version', CLEAN_GENERAL_REFERENCE);
    res.setHeader('X-Tagged-Clean-Records', String(taggedCount));
    res.json(dailyProjectionFromStorage(Date.now(), () => records));
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Error building clean daily projection' });
  }
});
