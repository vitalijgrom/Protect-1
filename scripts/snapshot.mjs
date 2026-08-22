/**
 * Обновляет public/data/fallback.json — снапшот таблицы, который дашборд
 * показывает, если Cloudflare-прослойка недоступна.
 *
 *   node scripts/snapshot.mjs
 *   SHEET_ID=... SHEET_NAME=Data node scripts/snapshot.mjs
 *
 * Логика нормализации переиспользуется из самой функции, чтобы схема снапшота
 * и схема живого ответа не разъезжались.
 */
import { writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadSheet } from '../functions/api/reviews.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const target = resolve(root, 'public/data/fallback.json');

const sheetId = process.env.SHEET_ID || '1LvR1dNFDnPKpOLRFNkyJ3HPjDWivmVuaDA4Mggy2COk';
const sheetName = process.env.SHEET_NAME || 'Data';

const payload = await loadSheet(sheetId, sheetName);
payload.source = 'snapshot';

await mkdir(dirname(target), { recursive: true });
await writeFile(target, JSON.stringify(payload, null, 2) + '\n', 'utf8');

console.log(`Снапшот обновлён: ${payload.count} строк → ${target}`);
