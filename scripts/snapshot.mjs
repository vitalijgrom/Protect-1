/**
 * Обновляет снапшоты, которые дашборды показывают, если Cloudflare-прослойка
 * недоступна:
 *   public/data/fallback.json        — отзывы
 *   public/data/media.json           — медиамониторинг
 *
 *   node scripts/snapshot.mjs
 *   node scripts/snapshot.mjs media
 *
 * Логика загрузки переиспользуется из самих функций, чтобы схема снапшота и
 * схема живого ответа не разъезжались.
 */
import { writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadSheet } from '../functions/api/reviews.js';
import { loadWorkbook } from '../functions/api/media.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const TARGETS = {
  reviews: {
    file: 'public/data/fallback.json',
    load: () =>
      loadSheet(
        process.env.SHEET_ID || '1LvR1dNFDnPKpOLRFNkyJ3HPjDWivmVuaDA4Mggy2COk',
        process.env.SHEET_NAME || 'Data'
      ),
    describe: (data) => `${data.count} строк`,
  },
  media: {
    file: 'public/data/media.json',
    load: () => loadWorkbook(process.env.MEDIA_SHEET_ID || '18xL7SvIsXgU5aKOhTzYKucLs290cjCITR8Xxk29gXL4'),
    describe: (data) => `${data.brands.length} брендов, ${data.viferon.months.length} месяцев`,
  },
};

const requested = process.argv[2];
const names = requested ? [requested] : Object.keys(TARGETS);

for (const name of names) {
  const target = TARGETS[name];
  if (!target) {
    console.error(`Неизвестный снапшот: ${name}. Доступны: ${Object.keys(TARGETS).join(', ')}`);
    process.exitCode = 1;
    continue;
  }

  const payload = await target.load();
  payload.source = 'snapshot';

  const file = resolve(root, target.file);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(payload, null, 2) + '\n', 'utf8');

  console.log(`${name}: ${target.describe(payload)} → ${target.file}`);
}
