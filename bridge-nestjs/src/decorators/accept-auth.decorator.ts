import { SetMetadata } from '@nestjs/common';

/**
 * Which credentials a route takes:
 * - `jwt`: a person's (or a job's) access token, `Authorization: Bearer`;
 * - `api_token`: a key, `x-api-key` (personal, service account or the app's own);
 * - `both` (the default).
 */
export type AuthType = 'jwt' | 'api_token' | 'both';

export const ACCEPT_AUTH_KEY = 'bridge:acceptAuth';

export const AcceptAuth = (type: AuthType) => SetMetadata(ACCEPT_AUTH_KEY, type);
