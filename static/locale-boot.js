(function () {
  try {
    var stored = localStorage.getItem('launchpad.locale');
    var browser = navigator.language || '';
    var locale = (stored === 'zh-CN' || stored === 'en') ? stored
      : /^zh\b/i.test(browser) ? 'zh-CN'
      : /^en\b/i.test(browser) ? 'en'
      : 'zh-CN';
    document.documentElement.lang = locale;
  } catch (e) {}
})();
