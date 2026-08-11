// TBP-341 — Unified backend bridge surface.
// Wired into the existing `BridgeModule.forRoot()` — see src/bridge.module.ts.
export { BridgeService } from './bridge.service';
export { TenantScope } from './tenant-scope';
export type {
  BrandingSnapshot,
  QuotaSnapshot,
  SessionSnapshotData,
  SubscriptionSnapshot,
  TenantEntitlementsView,
  TenantUsageView,
  UserSnapshot,
} from './tenant-scope';
export { BRIDGE_OPTIONS, type BridgeModuleOptions } from './bridge.tokens';
