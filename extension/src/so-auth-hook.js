/**
 * Strategy Overview session hook (MAIN world, document_start).
 *
 * Strategy Overview's sign-in library encrypts its token cache, so the migration adapter can't
 * read the token from storage. This remembers the bearer token the app itself sends to its own
 * API, in page memory only, so the adapter (also running in this page) can make the same
 * read-only calls. Nothing is stored, logged or sent anywhere else.
 */
(function () {
  if (window.__spcsSoHook) return;
  window.__spcsSoHook = true;
  const API_HOST = 'so-prod-use2-apim-01.azure-api.net';
  const remember = (url, value) => {
    if (typeof value === 'string' && /^Bearer\s/.test(value) && String(url || '').includes(API_HOST)) {
      window.__spcsSoAuth = { value, at: Date.now() };
    }
  };

  const open = XMLHttpRequest.prototype.open;
  const setHeader = XMLHttpRequest.prototype.setRequestHeader;
  XMLHttpRequest.prototype.open = function (method, url) {
    this.__spcsUrl = url;
    return open.apply(this, arguments);
  };
  XMLHttpRequest.prototype.setRequestHeader = function (name, value) {
    if (/^authorization$/i.test(name)) remember(this.__spcsUrl, value);
    return setHeader.apply(this, arguments);
  };

  const fetchOriginal = window.fetch;
  window.fetch = function (input, init) {
    try {
      const url = typeof input === 'string' ? input : input && input.url;
      const headers = (init && init.headers) || (input && input.headers);
      const value = headers && (typeof headers.get === 'function' ? headers.get('Authorization') : headers.Authorization || headers.authorization);
      remember(url, value);
    } catch (_e) { /* never interfere with the app's own requests */ }
    return fetchOriginal.apply(this, arguments);
  };
})();
