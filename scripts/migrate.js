import { readConfig } from '../src/config.js';
import { connectDatabase } from '../src/adapters/mongo/database.js';
// No se ejecuta dentro de Workers: índices y colecciones se provisionan antes del deploy.
const config = readConfig();
const { client } = await connectDatabase(config);
try {
  console.log('Colecciones e índices de MongoDB preparados.');
} finally {
  await client.close();
}
