import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { App } from 'supertest/types';
import { MailService } from '../mail/mail.service';
import { bodyOf } from './response-body';

interface AuthTokensBody {
  access_token: string;
  refresh_token: string;
}

/**
 * Registers a user, confirms the address and logs in, returning the access
 * token. Registration also creates the user's channel (1:1 from Fase 02), so
 * the returned token belongs to a user who can own videos.
 *
 * The confirmation token is captured by spying on `MailService` rather than
 * reading Mailpit, which keeps the helper usable in specs that do not care
 * about the mail transport.
 *
 * `test/auth.e2e-spec.ts` carries its own local copy of this chain; converging
 * it on this helper is deliberately left as a separate change so a refactor of
 * a Fase 02 spec does not ride along with a Fase 03 feature.
 */
export async function registerConfirmAndLogin(
  app: INestApplication<App>,
  email: string,
  password = 'password123',
): Promise<string> {
  const mailService = app.get(MailService);
  let confirmationToken = '';

  // A persistent `mockImplementation` restored right after, NOT
  // `mockImplementationOnce`: one-shots queue up across the many calls a spec
  // makes, and a single unconsumed one shifts every later capture — which
  // showed up as an empty token from roughly the eleventh registration on.
  const spy = jest
    .spyOn(mailService, 'sendConfirmationEmail')
    .mockImplementation((_email: string, _name: string, token: string) => {
      confirmationToken = token;
      return Promise.resolve();
    });

  // Each step asserts its own status. Without this, a throttled register or a
  // missed confirmation surfaces much later as an opaque 401/404 on the route
  // under test, which is a miserable thing to debug.
  const registered = await request(app.getHttpServer())
    .post('/auth/register')
    .send({ email, password });
  spy.mockRestore();

  if (registered.status !== 201) {
    throw new Error(
      `register ${email} failed: ${registered.status} ${JSON.stringify(registered.body)}`,
    );
  }
  if (confirmationToken === '') {
    throw new Error(
      `register ${email} did not emit a confirmation token (mail spy captured nothing)`,
    );
  }

  const confirmed = await request(app.getHttpServer())
    .get('/auth/confirm-email')
    .query({ token: confirmationToken });
  if (confirmed.status !== 204) {
    throw new Error(
      `confirm ${email} failed: ${confirmed.status} ${JSON.stringify(confirmed.body)}`,
    );
  }

  const res = await request(app.getHttpServer())
    .post('/auth/login')
    .send({ email, password });
  if (res.status !== 200) {
    throw new Error(
      `login ${email} failed: ${res.status} ${JSON.stringify(res.body)}`,
    );
  }

  return bodyOf<AuthTokensBody>(res).access_token;
}
