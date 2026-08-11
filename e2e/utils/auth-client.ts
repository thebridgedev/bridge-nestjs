/**
 * Programmatic SDK-mode auth client for the Bridge auth server.
 *
 * Implements the same two-call flow the Bridge SDK (auth-core `DirectAuth`)
 * uses, without a browser — stateless, no cookies, no redirects:
 *   1. POST /authenticate  { username, password, mode: 'sdk', appId }
 *        → { session, tenantUsers: [{ id, … }] }
 *   2. POST /token/direct  { session, tenantUserId, appId, scope, mode: 'sdk' }
 *        → { access_token, refresh_token, id_token }
 *
 * This replaces an earlier hosted-OAuth ("authorization code") implementation
 * that could never work headlessly: `GET /url/login/{appId}` only 302s to the
 * hosted login UI and sets no OAuth-context cookie, so the follow-up
 * `POST /authenticate` arrived with an empty cookie jar and the server answered
 * 401 NBLOCKS_APP_UNAUTHORIZED_EXCEPTION ("App is unauthenticated"). Every E2E
 * suite died in `beforeAll` on that call.
 *
 * SDK mode is guarded by `SdkOriginGuard`: the request must carry an `Origin`
 * header that matches the app's registered `allowedOrigins`. That value comes
 * from `TEST_APP_URL` (see config/test-app.ts) — the same constant
 * `e2e/pre-setup.ts` registers the app with (`appUrl`), so the two cannot drift.
 *
 * Used exclusively in E2E tests to obtain real JWT tokens for authenticated requests.
 */

import { TEST_APP_URL } from '../config/test-app';

export interface TokenSet {
  accessToken: string;
  refreshToken: string;
}

interface SdkAuthenticateResponse {
  session?: string;
  tenantUsers?: Array<{ id: string; username: string }>;
}

interface DirectTokenResponse {
  access_token: string;
  refresh_token: string;
  id_token?: string;
}

export class AuthClient {
  constructor(
    /** Auth base URL, e.g., http://localhost:3200/auth */
    private readonly authBaseUrl: string,
    private readonly appId: string,
    /**
     * Origin presented to `SdkOriginGuard`. Must be one of the app's
     * `allowedOrigins` — which the Bridge API derives from the `appUrl`
     * `e2e/pre-setup.ts` registered, i.e. `TEST_APP_URL`.
     */
    private readonly origin: string = process.env.E2E_SDK_ORIGIN || TEST_APP_URL,
  ) {}

  /**
   * Obtain an access token for the given credentials via the SDK direct flow.
   *
   * @throws Error if either step of the SDK auth flow fails.
   */
  async getToken(email: string, password: string): Promise<TokenSet> {
    const sdkHeaders = {
      'Content-Type': 'application/json',
      // Must match one of the test app's allowed origins (SdkOriginGuard).
      Origin: this.origin,
    };

    // ── Step 1: Authenticate with credentials (SDK mode) ──────────────────
    const authResp = await fetch(`${this.authBaseUrl}/authenticate`, {
      method: 'POST',
      headers: sdkHeaders,
      body: JSON.stringify({
        username: email,
        password,
        mode: 'sdk',
        appId: this.appId,
      }),
    });

    if (!authResp.ok) {
      throw new Error(
        `[AuthClient] authenticate failed (${authResp.status}): ${await authResp.text()}`,
      );
    }

    const authBody = (await authResp.json()) as SdkAuthenticateResponse;

    if (!authBody.session) {
      throw new Error(
        `[AuthClient] No session in authenticate response: ${JSON.stringify(authBody)}`,
      );
    }

    const tenantUser = authBody.tenantUsers?.[0];
    if (!tenantUser?.id) {
      throw new Error(
        '[AuthClient] No tenantUsers in authenticate response. ' +
          'The user is not a member of any workspace in this app.',
      );
    }

    // ── Step 2: Select the tenant user → tokens ───────────────────────────
    const tokenResp = await fetch(`${this.authBaseUrl}/token/direct`, {
      method: 'POST',
      headers: sdkHeaders,
      body: JSON.stringify({
        session: authBody.session,
        tenantUserId: tenantUser.id,
        appId: this.appId,
        scope: 'openid profile email onboarding tenant',
        mode: 'sdk',
      }),
    });

    if (!tokenResp.ok) {
      throw new Error(
        `[AuthClient] token/direct failed (${tokenResp.status}): ${await tokenResp.text()}`,
      );
    }

    const tokens = (await tokenResp.json()) as DirectTokenResponse;

    return {
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
    };
  }
}
