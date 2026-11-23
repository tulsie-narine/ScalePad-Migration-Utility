(() => {
  const clean = (value) => String(value || '').replace(/\s+/g, ' ').trim();
  let lastUrl = window.location.href;
  let timer = null;

  function readPageContext(reason = 'page-ready') {
    const selection = clean(window.getSelection?.()?.toString());
    const headings = Array.from(document.querySelectorAll('h1, h2, h3'))
      .map((heading) => clean(heading.textContent))
      .filter(Boolean)
      .slice(0, 6);
    const bodyText = clean(document.body?.innerText).slice(0, 420);
    return {
      reason,
      url: window.location.href,
      title: clean(document.title) || window.location.hostname,
      host: window.location.hostname,
      path: `${window.location.pathname}${window.location.search}${window.location.hash}`,
      selection: selection.slice(0, 600),
      headings,
      preview: bodyText,
      capturedAt: new Date().toISOString(),
    };
  }

  function publish(reason) {
    const context = readPageContext(reason);
    lastUrl = context.url;
    chrome.runtime.sendMessage({ type: 'SIDE_PANEL_PAGE_CONTEXT', context }).catch(() => {});
  }

  function publishSoon(reason) {
    clearTimeout(timer);
    timer = setTimeout(() => publish(reason), 120);
  }

  function patchHistoryMethod(name) {
    const original = history[name];
    if (typeof original !== 'function') return;
    history[name] = function patchedHistoryMethod(...args) {
      const result = original.apply(this, args);
      if (window.location.href !== lastUrl) publishSoon(`history-${name}`);
      return result;
    };
  }

  patchHistoryMethod('pushState');
  patchHistoryMethod('replaceState');
  window.addEventListener('popstate', () => publishSoon('popstate'));
  window.addEventListener('hashchange', () => publishSoon('hashchange'));
  window.addEventListener('load', () => publishSoon('load'));

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type !== 'SIDE_PANEL_GET_CONTEXT') return undefined;
    sendResponse({ ok: true, context: readPageContext('panel-request') });
    return true;
  });

  publish('page-ready');
})();
