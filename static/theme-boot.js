// #750: the resolved theme must be on <html> before the first stylesheet paints, so this runs next to locale-boot.js
// and blocks parsing on purpose. `data-theme` carries a manual override only; without the attribute the stylesheet's
// `prefers-color-scheme` block decides, which is what lets "follow the system" keep following after the first paint.
(function () {
  var KEY = 'launchpad.theme';
  var root = document.documentElement;
  var query = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;
  var choice = 'system';
  var listeners = [];
  try {
    var stored = localStorage.getItem(KEY);
    if (stored === 'light' || stored === 'dark' || stored === 'system') choice = stored;
  } catch (e) {}
  function systemDark() { return !!(query && query.matches); }
  function paint() {
    var dark = choice === 'dark' || (choice === 'system' && systemDark());
    if (choice === 'system') root.removeAttribute('data-theme');
    else root.setAttribute('data-theme', choice);
    root.style.colorScheme = dark ? 'dark' : 'light';
  }
  paint();
  window.launchpadTheme = {
    choice: function () { return choice; },
    set: function (value) {
      if (value !== 'light' && value !== 'dark' && value !== 'system') return;
      choice = value;
      try { localStorage.setItem(KEY, value); } catch (e) {}
      paint();
      for (var i = 0; i < listeners.length; i++) listeners[i](value);
    },
    onChange: function (fn) { listeners.push(fn); }
  };
  // While the reader follows the system, an OS switch repaints immediately; with a manual choice it must not.
  if (query && query.addEventListener) query.addEventListener('change', function () { if (choice === 'system') paint(); });
})();
