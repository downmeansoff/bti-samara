// Единый источник контактов сайта. Правишь один раз — применяется на всех страницах
// и во всех компонентах (Header, Footer, LeadModal, hero и CTA-блоки услуг).
// Подключён в <head> всех 5 страниц ПЕРЕД support.js.
//
// MAX: ссылок «по номеру телефона» у мессенджера MAX нет — профиль это
// https://max.ru/u/<хеш> из приложения владельца. Ссылки прислал владелец 29.09.2026
// QR-кодами (Самара — зелёный, Башкирия — синий). Пустое max: '' — компоненты
// печатают «также в MAX» без ссылки. Ссылки дублируются в JSON-LD sameAs
// статического <head> index.dc.html.
//
// Порядок везде: сначала Самарская область, потом Республика Башкортостан.
window.BTI_CONTACTS = {
  phones: [
    {
      region: 'Самарская область',
      short: 'Самара',
      display: '8 902 749-28-01',
      tel: 'tel:+79027492801',
      max: 'https://max.ru/u/f9LHodD0cOKQw0ntMHcTVpKZj7yk1IyNxxCf9YD1BStgrfLVht53Tiw5bao',
    },
    {
      region: 'Республика Башкортостан',
      short: 'Башкирия',
      display: '8 917 769-61-19',
      tel: 'tel:+79177696119',
      max: 'https://max.ru/u/f9LHodD0cOJkSRIwE5ShMfP3HfMBSggCftDYpEczkBfjvAvR69cglmz1WM8',
    },
  ],
  telegram: {
    handle: '@kadastricom_bot',
    url: 'https://t.me/kadastricom_bot',
  },
  email: 'baymurzin.86@bk.ru',
  // LeadModal posts here. On the Railway domain itself it uses the relative
  // '/api/lead' instead (see LeadModal.dc.html) — this absolute URL is for
  // every other host (kadastrhelp.ru, the GitHub Pages mirror).
  leadApi: 'https://bti-samara-landing-production.up.railway.app/api/lead',
};
