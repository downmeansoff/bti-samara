// Единый источник контактов сайта. Правишь один раз — применяется на всех страницах
// и во всех компонентах (Header, Footer, LeadModal, hero и CTA-блоки услуг).
// Подключён в <head> всех 5 страниц ПЕРЕД support.js.
//
// MAX: прямых ссылок «по номеру телефона» у мессенджера MAX не существует (как нет
// wa.me у WhatsApp) — профиль это https://max.ru/u/<хеш> только из приложения
// владельца. Пока владелец не прислал ссылки — max: '' у каждого номера, компоненты
// в этом случае печатают текст «также в MAX» без ссылки (см. renderVals в Header/
// Footer/LeadModal и hero-блоках страниц услуг). Как только ссылки придут — вписать
// сюда, больше нигде трогать не нужно.
//
// Порядок везде: сначала Самарская область, потом Республика Башкортостан.
window.BTI_CONTACTS = {
  phones: [
    {
      region: 'Самарская область',
      short: 'Самара',
      display: '8 902 749-28-01',
      tel: 'tel:+79027492801',
      max: '',
    },
    {
      region: 'Республика Башкортостан',
      short: 'Башкирия',
      display: '8 917 769-61-19',
      tel: 'tel:+79177696119',
      max: '',
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
