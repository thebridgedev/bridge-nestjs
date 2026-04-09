/**
 * Programmatic OAuth 2.0 client for the Bridge auth server.
 *
 * Implements the authorization code flow without a browser:
 *   1. GET  /url/login/{appId}   — initialize OAuth context (sets cookie)
 *   2. POST /authenticate         — validate credentials, get session
 *   3. GET  /chooseTenantUser     — select tenant, receive auth code in redirect
 *   4. POST /token/code/{appId}  — exchange code for access token
 *
 * Used exclusively in E2E tests to obtain real JWT tokens for authenticated requests.
 */

export interface TokenSet {
  accessToken: string;
  refreshToken: string;
}

export class AuthClient {
  /**
   * Redirect URI used during the OAuth flow. Must be registered OR
   * the Bridge test setup must allow arbitrary redirect URIs for test apps.
   * We use 'manual' redirect mode and never actually connect to this URL —
   * we just extract the auth code from the Location header.
   */
  private readonly redirectUri = 'http://localhost:3099/oauth-callback';

  constructor(
    /** Auth base URL, e.g., http://localhost:3200/auth */
    private readonly authBaseUrl: string,
    private readonly appId: string,
  ) {}

  /**
   * Obtain an access token for the given credentials.
   *
   * @throws Error if any step of the OAuth flow fails.
   */
  async getToken(email: string, password: string): Promise<TokenSet> {
    const cookies: string[] = [];

    // ── Step 1: Initialize OAuth context ──────────────────────────────────
    const loginUrl =
      `${this.authBaseUrl}/url/login/${this.appId}` +
      `?redirect_uri=${encodeURIComponent(this.redirectUri)}`;

    const loginResp = await fetch(loginUrl, { redirect: 'manual' });
    this.collectCookies(loginResp, cookies);

    // ── Step 2: Authenticate with credentials ─────────────────────────────
    const authResp = await fetch(`${this.authBaseUrl}/authenticate`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: cookies.join('; '),
      },
      body: JSON.stringify({ username: email, password }),
    });
    this.collectCookies(authResp, cookies);

    if (!authResp.ok) {
      const body = await authResp.text();
      throw new Error(
        `[AuthClient] Authentication failed (${authResp.status}): ${body}`,
      );
    }

    const authBody = (await authResp.json()) as {
      tenantUserId?: string;
      session?: string;
    };

    const tenantUserId = authBody.tenantUserId;
    if (!tenantUserId) {
      throw new Error(
        '[AuthClient] No tenantUserId in authenticate response. ' +
          'The user may have multiple tenants — single-tenant users are expected in tests.',
      );
    }

    // ── Step 3: Choose tenant user → receive auth code in redirect ─────────
    const chooseUrl =
      `${this.authBaseUrl}/chooseTenantUser` +
      `?id=${encodeURIComponent(tenantUserId)}`;

    const chooseResp = await fetch(chooseUrl, {
      redirect: 'manual',
      headers: { Cookie: cookies.join('; ') },
    });
    this.collectCookies(chooseResp, cookies);

    const location = chooseResp.headers.get('location');
    if (!location) {
      throw new Error(
        `[AuthClient] No Location header from chooseTenantUser (status ${chooseResp.status})`,
      );
    }

    let code: string | null;
    try {
      code = new URL(location).searchParams.get('code');
    } catch {
      throw new Error(
        `[AuthClient] Invalid redirect URL from chooseTenantUser: ${location}`,
      );
    }

    if (!code) {
      throw new Error(
        `[AuthClient] No 'code' in redirect URL: ${location}`,
      );
    }

    // ── Step 4: Exchange authorization code for tokens ─────────────────────
    const tokenResp = await fetch(
      `${this.authBaseUrl}/token/code/${this.appId}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code, redirectUri: this.redirectUri }),
      },
    );

    if (!tokenResp.ok) {
      const body = await tokenResp.text();
      throw new Error(
        `[AuthClient] Token exchange failed (${tokenResp.status}): ${body}`,
      );
    }

    const tokens = (await tokenResp.json()) as {
      access_token: string;
      refresh_token: string;
    };

    return {
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
    };
  }

  /**
   * Extract `name=value` pairs from Set-Cookie headers and append to the jar.
   *
   * Strips cookie attributes (Path, HttpOnly, SameSite, etc.) — they are not
   * relevant for server-side fetch calls.
   */
  private collectCookies(response: Response, jar: string[]): void {
    // Node.js 18.14+ exposes getSetCookie() for multi-value Set-Cookie
    const rawHeaders = response.headers as unknown as {
      getSetCookie?: () => string[];
    };

    const setCookies: string[] =
      typeof rawHeaders.getSetCookie === 'function'
        ? rawHeaders.getSetCookie()
        : response.headers.get('set-cookie')
          ? [response.headers.get('set-cookie')!]
          : [];

    for (const header of setCookies) {
      const nameValue = header.split(';')[0].trim();
      if (nameValue) jar.push(nameValue);
    }
  }
}
