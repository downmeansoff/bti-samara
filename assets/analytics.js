/* Web analytics: Yandex Metrica. Counter 113594675 for kadastrhelp.ru,
   enabled with the owner's approval on 10 October 2026. Set metrika to 0 to disable.

   Turn on, in this order:
   1. Owner or lawyer reads the analytics wording in politika.dc.html (it switches on by itself
      together with the counter) and agrees to it.
   2. Create the counter at metrika.yandex.ru for kadastrhelp.ru, WITHOUT Webvisor.
   3. Put its number into `metrika` and today's date into `policyDate`, e.g. '10 октября 2026 года'.
   4. node tests/analytics-check.mjs, then the usual DEPLOY.bat.

   Counted only on the real domain (the Railway and Pages mirrors, localhost, the robots'
   prerendered copies and the owner's review mode are skipped) and never for visitors who send
   Do Not Track / Global Privacy Control. Open any page with ?nostat=1 once to exclude your own
   browser; ?nostat=0 undoes it. No Webvisor, no form content, no goal parameters: the form's
   name and phone never reach the counter.

   Goals (JavaScript events) to create in the counter:
   lead_open, lead_sent, click_phone, click_telegram, click_max, click_email. */
window.BTI_ANALYTICS = {
  metrika: 113594675,
  policyDate: '10 октября 2026 года',
  hosts: ['kadastrhelp.ru', 'www.kadastrhelp.ru']
};

(function (A) {
  var q = location.search;
  try {
    if (/[?&]nostat=1(&|$)/.test(q)) localStorage.setItem('btiNoStat', '1');
    if (/[?&]nostat=0(&|$)/.test(q)) localStorage.removeItem('btiNoStat');
  } catch (e) {}

  function skip() {
    try { if (localStorage.getItem('btiNoStat') === '1') return true; } catch (e) {}
    if (navigator.doNotTrack === '1' || window.doNotTrack === '1' || navigator.globalPrivacyControl) return true;
    if (navigator.webdriver) return true;
    if (/[?&](seo-snapshot|review)(=|&|$)/.test(q)) return true;
    return A.hosts.indexOf(location.hostname) < 0;
  }

  var on = !!A.metrika && !skip();

  // Safe from any page or component, whether or not analytics is on.
  window.btiGoal = function (name) {
    try { if (on && window.ym) window.ym(A.metrika, 'reachGoal', name); } catch (e) {}
  };
  if (!on) return;

  (function (m, e, t, r, i, k, a) {
    m[i] = m[i] || function () { (m[i].a = m[i].a || []).push(arguments); };
    m[i].l = 1 * new Date();
    k = e.createElement(t); a = e.getElementsByTagName(t)[0];
    k.async = 1; k.src = r; a.parentNode.insertBefore(k, a);
  })(window, document, 'script', 'https://mc.yandex.ru/metrika/tag.js', 'ym');
  window.ym(A.metrika, 'init', { clickmap: true, trackLinks: true, accurateTrackBounce: true, webvisor: false, ssl: true });

  // Contact links are drawn by the page runtime, so listen on the document.
  document.addEventListener('click', function (ev) {
    var a = ev.target && ev.target.closest ? ev.target.closest('a[href]') : null;
    if (!a) return;
    var h = String(a.getAttribute('href') || '').toLowerCase();
    if (h.indexOf('tel:') === 0) window.btiGoal('click_phone');
    else if (h.indexOf('mailto:') === 0) window.btiGoal('click_email');
    else if (/^https?:\/\/(t|telegram)\.me\//.test(h)) window.btiGoal('click_telegram');
    else if (/^https?:\/\/(www\.)?max\.ru\//.test(h)) window.btiGoal('click_max');
  }, true);
})(window.BTI_ANALYTICS);
