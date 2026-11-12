import {
  applyDecorators,
  BadRequestException,
  CanActivate,
  createParamDecorator,
  ExecutionContext,
  Inject,
  Injectable,
  InternalServerErrorException,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { Public } from '../decorators/public.decorator';
import { BRIDGE_OPTIONS, type BridgeModuleOptions } from '../options';
import { verifyWebhook, WebhookSignatureError, type BridgeWebhookEvent } from './verify';

const events = new WeakMap<object, BridgeWebhookEvent>();

/**
 * Lets a request through only when it carries a valid Bridge webhook
 * signature, with the module's `webhookSecrets`. Needs the raw body: create
 * the app with `NestFactory.create(AppModule, { rawBody: true })`.
 */
@Injectable()
export class BridgeWebhookGuard implements CanActivate {
  constructor(@Inject(BRIDGE_OPTIONS) private readonly options: BridgeModuleOptions) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<{ rawBody?: Buffer | string; headers: Record<string, string | string[] | undefined> }>();
    const secrets = this.options.webhookSecrets ?? [];
    if (request.rawBody === undefined) {
      throw new InternalServerErrorException('Webhooks need the raw body: create the app with { rawBody: true }.');
    }
    try {
      events.set(request, verifyWebhook({ body: request.rawBody, headers: request.headers, secrets }));
      return true;
    } catch (error) {
      if (!(error instanceof WebhookSignatureError)) throw error;
      if (error.reason === 'no-secret') throw new InternalServerErrorException('No webhook secret is configured: set webhookSecrets.');
      if (error.reason === 'not-json') throw new BadRequestException(error.message);
      throw new UnauthorizedException({ statusCode: 401, error: 'Unauthorized', message: error.message, reason: error.reason });
    }
  }
}

/** A route that receives Bridge's webhooks: public to the auth guard, checked by signature instead. */
export const BridgeWebhook = () => applyDecorators(Public(), UseGuards(BridgeWebhookGuard));

/** The verified webhook event (`{ id, type, timestamp, payload }`). */
export const WebhookEvent = createParamDecorator((_: unknown, context: ExecutionContext) => events.get(context.switchToHttp().getRequest()) ?? null);
