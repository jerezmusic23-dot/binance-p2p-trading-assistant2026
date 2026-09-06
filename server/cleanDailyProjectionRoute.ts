import { Router } from 'express';
import { dailyProjectionFromStorage } from './dailyProjection.js';
import { StorageEngine } from './storage.js';
import type { HistoryRecord } from './types.js';

const CLEAN_GENERAL_REFERENCE = 'v4-no-recarga-pines';

type GeneralProjectionRecord = HistoryRecord & {
  generalReferenceVersion?: string;
};

export const cleanDailyProjectionRouter = Router();

/**
 * General projection endpoint with an auditable history boundary.
 *
 * Records captured before the Recarga Pines exclusion cannot be trusted because
 * HistoryRecord did not persist payment-method provenance. They are therefore
 * not allowed into the projection. New captures are tagged by marketContext
 * only after the general snapshot has removed Recarga Pines ads.
 */
cleanDailyProjectionRouter.get('/market/projections/daily', (_req, res) => {
  try {
    const cleanRecords = StorageEngine.getHistory().filter(
      (record) => (record as GeneralProjectionRecord).generalReferenceVersion === CLEAN_GENERAL_REFERENCE
    );

    res.json(
      dailyProjectionFromStorage(Date.now(), () => cleanRecords)
    );
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Error building clean daily projection' });
  }
});
