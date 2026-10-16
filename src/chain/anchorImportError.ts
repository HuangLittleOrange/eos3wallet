import { t } from '../i18n';

export class AnchorImportNetworkError extends Error {
  constructor() { super(t('anchorImport.networkFailed')); }
}

export function isConnectionError(error: unknown): boolean {
  return error instanceof AnchorImportNetworkError || (error instanceof Error &&
    /fetch failed|failed to fetch|network request failed|network error|socketexception|connection (?:abort|reset|closed)|timed?\s*out/i.test(error.message));
}
