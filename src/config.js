import { z } from 'zod';
const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  MONGO_URI: z.string().min(1),
  MONGO_AUTO_MIGRATE: z.enum(['true', 'false']).default('false'),
  MONGO_DB: z
    .string()
    .regex(/^[a-zA-Z0-9_-]+$/)
    .default('nexo'),
  JWT_SECRET: z.string().min(48),
  GOOGLE_CLIENT_ID: z
    .string()
    .regex(/^(?:[0-9]+-[a-zA-Z0-9_-]+\.apps\.googleusercontent\.com)?$/)
    .default(''),
  PLATFORM_ADMIN_EMAILS: z
    .string()
    .default('')
    .transform((s) =>
      s
        .split(',')
        .map((v) => v.trim().toLowerCase())
        .filter(Boolean),
    )
    .pipe(z.array(z.email())),
  PLATFORM_ADMIN_USER_IDS: z
    .string()
    .default('')
    .transform((s) =>
      s
        .split(',')
        .map((v) => v.trim())
        .filter(Boolean),
    )
    .pipe(z.array(z.uuid())),
  JWT_ISSUER: z.string().default('nexo-api'),
  JWT_AUDIENCE: z.string().default('nexo-app'),
  ACCESS_TOKEN_MINUTES: z.coerce.number().int().min(1).max(1440).default(30),
  CORS_ORIGINS: z.string().default('http://localhost:5173'),
  LOG_LEVEL: z.enum(['silent', 'fatal', 'error', 'warn', 'info', 'debug']).default('info'),
  TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(10).default(0),
});
export function readConfig(env = process.env) {
  const c = envSchema.parse(env);
  if (c.JWT_SECRET.includes('REEMPLAZAR')) throw new Error('Genera JWT_SECRET con npm run secret');
  return {
    nodeEnv: c.NODE_ENV,
    port: c.PORT,
    mongoUri: c.MONGO_URI,
    mongoAutoMigrate: c.MONGO_AUTO_MIGRATE === 'true',
    mongoDb: c.MONGO_DB,
    jwtSecret: c.JWT_SECRET,
    googleClientId: c.GOOGLE_CLIENT_ID,
    platformAdminEmails: c.PLATFORM_ADMIN_EMAILS,
    platformAdminUserIds: c.PLATFORM_ADMIN_USER_IDS,
    jwtIssuer: c.JWT_ISSUER,
    jwtAudience: c.JWT_AUDIENCE,
    tokenMinutes: c.ACCESS_TOKEN_MINUTES,
    corsOrigins: c.CORS_ORIGINS.split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    logLevel: c.LOG_LEVEL,
    trustProxyHops: c.TRUST_PROXY_HOPS,
  };
}
