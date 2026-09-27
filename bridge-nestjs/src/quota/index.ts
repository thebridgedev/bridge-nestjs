// TBP-704 — plan limits and entitlements: decorators + plain service calls.
export {
  RequireQuota,
  SyncQuota,
  RequireEntitlement,
  REQUIRED_QUOTA_KEY,
  SYNC_QUOTA_KEY,
  REQUIRED_ENTITLEMENT_KEY,
  type QuotaTenant,
  type QuotaCounter,
  type RequireQuotaOptions,
  type SyncQuotaOptions,
} from './quota.decorators';
export { BridgeQuotaInterceptor } from './quota.interceptor';
export {
  BridgeQuotaService,
  QuotaExceededException,
  EntitlementRequiredException,
  type QuotaExceededBody,
  type EntitlementRequiredBody,
  type QuotaCount,
  type QuotaCheckOptions,
  type QuotaDecision,
  type QuotaRecordOptions,
} from './quota.service';
