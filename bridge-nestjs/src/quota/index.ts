// Plan limits and entitlements: decorators and plain service calls.
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
export { BridgeQuotaInterceptor, USAGE_COUNTED_HEADER } from './quota.interceptor';
export {
  BridgeQuotaService,
  QuotaExceededException,
  EntitlementRequiredException,
  BillingLockedException,
  type QuotaExceededBody,
  type EntitlementRequiredBody,
  type BillingLockedBody,
  type QuotaCount,
  type QuotaCheckOptions,
  type QuotaDecision,
  type QuotaHoldOptions,
  type QuotaRecordOptions,
} from './quota.service';
