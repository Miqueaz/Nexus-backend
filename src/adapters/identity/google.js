import { createRemoteJWKSet, jwtVerify } from 'jose';
import { ensure, AppError } from '../../core/errors.js';
import { z } from '../../core/validation.js';

/** Google is an identity provider; Nexo remains the issuer of application sessions. */
export function createGoogleIdentity({ clientId, keySet } = {}) {
  const keys =
    keySet ??
    createRemoteJWKSet(new URL('https://www.googleapis.com/oauth2/v3/certs'), {
      timeoutDuration: 5000,
      cooldownDuration: 30000,
      cacheMaxAge: 600000,
    });
  return {
    async verify(credential) {
      ensure(
        clientId,
        503,
        'GOOGLE_NOT_CONFIGURED',
        'El acceso con Google todavía no está configurado.',
      );
      let payload;
      try {
        ({ payload } = await jwtVerify(credential, keys, {
          algorithms: ['RS256'],
          issuer: ['https://accounts.google.com', 'accounts.google.com'],
          audience: clientId,
          requiredClaims: ['sub', 'aud', 'iss', 'exp', 'iat', 'nonce', 'email', 'email_verified'],
          maxTokenAge: '1h',
          clockTolerance: 30,
        }));
      } catch (error) {
        const invalid =
          /^ERR_(JWT|JWS)_/.test(error.code || '') ||
          ['ERR_JOSE_ALG_NOT_ALLOWED', 'ERR_JWKS_NO_MATCHING_KEY'].includes(error.code);
        throw new AppError(
          invalid ? 401 : 503,
          invalid ? 'INVALID_GOOGLE_TOKEN' : 'GOOGLE_UNAVAILABLE',
          invalid
            ? 'La identificación de Google no es válida o venció.'
            : 'No se pudo verificar Google. Inténtalo de nuevo.',
        );
      }
      ensure(
        payload.aud === clientId &&
          (!payload.azp || payload.azp === clientId) &&
          typeof payload.sub === 'string' &&
          payload.sub.length > 0 &&
          payload.sub.length <= 255 &&
          payload.email_verified === true &&
          typeof payload.nonce === 'string',
        401,
        'INVALID_GOOGLE_TOKEN',
        'La identificación de Google no es válida.',
      );
      const email = z.email().max(254).safeParse(payload.email);
      ensure(email.success, 401, 'INVALID_GOOGLE_TOKEN', 'Google no devolvió un correo válido.');
      return {
        subject: payload.sub,
        email: email.data.toLowerCase(),
        name: typeof payload.name === 'string' ? payload.name.trim().slice(0, 200) : '',
        nonce: payload.nonce,
      };
    },
  };
}
