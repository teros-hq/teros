export {
  __setAcResolveHostForTests,
  __setAcSleepForTests,
  type AcRequestOptions,
  acPing,
  acRequest,
} from './activecampaign-client.js';
export {
  ActiveCampaignAuthError,
  ActiveCampaignBadRequestError,
  ActiveCampaignError,
  type ActiveCampaignErrorCode,
  ActiveCampaignNotFoundError,
  ActiveCampaignRateLimitError,
  classifyAcError,
  extractAcErrorMessage,
} from './errors.js';
