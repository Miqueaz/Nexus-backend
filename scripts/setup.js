import { readFile, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
const template = await readFile(new URL('../.env.example', import.meta.url), 'utf8');
try {
  await writeFile(
    new URL('../.env', import.meta.url),
    template.replace(
      'REEMPLAZAR_CON_UNA_CLAVE_ALEATORIA_DE_AL_MENOS_48_CARACTERES',
      randomBytes(64).toString('base64url'),
    ),
    { flag: 'wx', mode: 0o600 },
  );
  console.log('.env creado con una clave aleatoria. Revisa MONGO_URI y CORS_ORIGINS.');
} catch (error) {
  if (error.code === 'EEXIST') console.log('.env ya existe; se conservó su configuración.');
  else throw error;
}
