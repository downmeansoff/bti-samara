#!/usr/bin/env node
// Publish the seven existing price-list entries in Yandex's services_feed format.
// The labels and starting prices come from the same array the visible page uses.
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, SITE, extractConst, priceNumber } from './seo-lib.mjs';

const TARGET = path.join(ROOT, 'services-feed.xml');
const CHECK = process.argv.includes('--check');
const home = fs.readFileSync(path.join(ROOT, 'index.dc.html'), 'utf8');
const rows = extractConst(home, 'PRICE_ROWS');
const routes = new Map([
  ['Межевой план на уточнение границ земельного участка', 'mezhevanie'],
  ['Перераспределение, раздел и объединение участков', 'razdel-obedinenie'],
  ['Технический план — ИЖС и нежилые строения', 'tehplan'],
  ['Технический план — помещения', 'tehplan'],
  ['Акт обследования (снятие с кадастрового учёта и прекращение права собственности)', 'akt-obsledovaniya'],
  ['Акт осмотра объекта (отнесение к признакам объекта капитального строительства)', 'akt-osmotra'],
  ['Вынос точек в натуру', 'vynos-tochek'],
]);
if (rows.length !== routes.size || new Set(rows.map(r => r.label)).size !== rows.length ||
    rows.some(r => !routes.has(r.label))) {
  throw new Error('Visible price list changed: review the services feed mapping');
}
const esc = value => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;')
  .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
const element = (name, value, indent) => `${' '.repeat(indent)}<${name}>${esc(value)}</${name}>\n`;

let xml = '<?xml version="1.0" encoding="UTF-8"?>\n<services_feed>\n';
xml += '  <source>\n';
xml += element('name', 'Кадастровый инженер · ИП Баймурзин А.Р.', 4);
xml += element('url', SITE, 4);
xml += element('favicon', SITE + 'favicon.ico', 4);
xml += element('locale', 'ru', 4);
xml += element('redirect_service', '1', 4);
xml += '  </source>\n';
xml += '  <categories>\n    <category>\n';
xml += element('persistent_id', 'cadastral_works', 6);
xml += element('name', 'Кадастровые работы', 6);
xml += '    </category>\n  </categories>\n';
xml += '  <executors>\n    <executor>\n';
xml += element('persistent_id', 'ip_baymurzin_samara', 6);
xml += element('url', SITE, 6);
xml += element('is_organization', '1', 6);
xml += element('name', 'ИП Баймурзин Азат Ринатович', 6);
xml += element('org_permalink', '146058424243', 6);
xml += '      <contacts>\n        <phones>\n';
xml += '          <phone is_primary="1">+79027492801</phone>\n';
xml += '        </phones>\n      </contacts>\n';
xml += '      <geo_info>\n        <addresses>\n          <address>\n';
xml += element('text', 'Самара, Бобруйская улица, 132А, этаж 2', 12);
xml += '          </address>\n        </addresses>\n';
xml += '        <service_areas>\n          <area>\n';
xml += element('text', 'Самарская область', 12);
xml += '          </area>\n        </service_areas>\n      </geo_info>\n';
xml += '      <services>\n';
for (const row of rows) {
  if (!/^от\s[\d\s]+\s₽(?:\s\/\sточка)?$/.test(row.price)) {
    throw new Error('Unrecognized starting price: ' + row.price);
  }
  const value = priceNumber(row.price);
  if (!Number.isInteger(value) || value < 1) throw new Error('Invalid price: ' + row.price);
  xml += '        <service>\n';
  xml += element('persistent_id', routes.get(row.label) + (row.label.includes('помещения') ? '_premises' : row.label.includes('строения') ? '_buildings' : ''), 10);
  xml += element('url', SITE + routes.get(row.label), 10);
  xml += element('name', row.label, 10);
  xml += element('category_id', 'cadastral_works', 10);
  xml += '          <price>\n            <from>\n';
  xml += element('value', value, 14);
  xml += element('currency', 'RUB', 14);
  xml += '            </from>\n';
  if (row.price.includes('/ точка')) xml += element('unit', 'точка', 12);
  xml += '          </price>\n        </service>\n';
}
xml += '      </services>\n    </executor>\n  </executors>\n</services_feed>\n';

if (CHECK) {
  if (!fs.existsSync(TARGET) || fs.readFileSync(TARGET, 'utf8') !== xml) {
    console.error('services-feed.xml is out of date; run node gen-yandex-services.mjs');
    process.exit(1);
  }
  console.log('services-feed.xml matches the seven visible starting prices');
} else {
  fs.writeFileSync(TARGET, xml, 'utf8');
  console.log('Wrote services-feed.xml with', rows.length, 'services');
}
