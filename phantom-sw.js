/**
 * Phantom Proxy — Service Worker v1.1
 * FIXES:
 *  - PROXY_PREFIX avec /  au début (fix pathname matching)
 *  - CORS proxy fallback pour contourner les restrictions GitHub Pages
 *  - Meilleure gestion des erreurs
 */

const PHANTOM_VERSION = '1.1.0';
const PROXY_PREFIX = 'proxy/';  // ✅ FIX #1: slash au début OBLIGATOIRE
const XOR_KEY = 0x5A;

// CORS proxies publics — essayés dans l'ordre
const CORS_PROXIES = [
  url => `https://corsproxy.io/?${encodeURIComponent(url)}`,
  url => `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`,
  url => `https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(url)}`,
];

// ─── URL encoding ────────────────────────────────────────────────────
function encodeURL(url) {
  const bytes = new TextEncoder().encode(url);
  const xored = bytes.map(b => b ^ XOR_KEY);
  return btoa(String.fromCharCode(...xored))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '~');
}

function decodeURL(encoded) {
  try {
    const b64 = encoded.replace(/-/g, '+').replace(/_/g, '/').replace(/~/g, '=');
    const decoded = atob(b64);
    const bytes = Uint8Array.from(decoded, c => c.charCodeAt(0));
    const unxored = bytes.map(b => b ^ XOR_KEY);
    return new TextDecoder().decode(unxored);
  } catch {
    return null;
  }
}

// ─── Install & Activate ─────────────────────────────────────────────
self.addEventListener('install', e => {
  console.log('[Phantom SW] Install v' + PHANTOM_VERSION);
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  console.log('[Phantom SW] Activate v' + PHANTOM_VERSION);
  e.waitUntil(self.clients.claim());
});

// ─── Fetch intercept ────────────────────────────────────────────────
self.addEventListener('fetch', e => {
  const parsedURL = new URL(e.request.url);

  // ✅ FIX #1 appliqué ici — pathname commence par /proxy/
  if (!parsedURL.pathname.startsWith(PROXY_PREFIX)) return;

  e.respondWith(handleProxyRequest(e.request, parsedURL));
});

// ─── Main proxy handler ─────────────────────────────────────────────
async function handleProxyRequest(request, parsedURL) {
  const afterPrefix = parsedURL.pathname.slice(PROXY_PREFIX.length);

  const slashIdx = afterPrefix.indexOf('/');
  let encodedBase, extraPath;
  if (slashIdx === -1) {
    encodedBase = afterPrefix;
    extraPath = '';
  } else {
    encodedBase = afterPrefix.slice(0, slashIdx);
    extraPath = afterPrefix.slice(slashIdx);
  }

  const baseTarget = decodeURL(encodedBase);
  if (!baseTarget) {
    return errorResponse('URL cible invalide ou corrompue.<br>Encoded: ' + encodedBase, 400);
  }

  let targetURL;
  try {
    const base = new URL(baseTarget);
    targetURL = base.origin + (extraPath || base.pathname) + parsedURL.search;
  } catch {
    return errorResponse('URL malformée: ' + baseTarget, 400);
  }

  console.log('[Phantom SW] Fetching:', targetURL);

  // ─── Fetch avec fallback CORS proxies ────────────────────────────
  let response = null;
  let lastError = '';

  // Tentative 1: direct (fonctionne si le site autorise CORS)
  try {
    response = await fetch(targetURL, {
      method: request.method,
      headers: buildHeaders(request, targetURL),
      body: ['GET', 'HEAD'].includes(request.method) ? undefined : await request.blob(),
      redirect: 'follow',
      credentials: 'omit',
    });
    if (!response.ok && response.status === 0) throw new Error('opaque');
    console.log('[Phantom SW] Direct fetch OK:', response.status);
  } catch (err) {
    lastError = err.message;
    console.warn('[Phantom SW] Direct fetch failed:', err.message);
    response = null;
  }

  // Tentative 2+: CORS proxies publics
  if (!response || response.type === 'opaque') {
    for (const proxyFn of CORS_PROXIES) {
      const proxiedURL = proxyFn(targetURL);
      try {
        response = await fetch(proxiedURL, {
          method: 'GET', // CORS proxies n'acceptent que GET
          redirect: 'follow',
          credentials: 'omit',
        });
        if (response.ok || response.status > 0) {
          console.log('[Phantom SW] CORS proxy OK:', proxiedURL.slice(0, 40));
          break;
        }
      } catch (err) {
        lastError = err.message;
        console.warn('[Phantom SW] Proxy failed:', err.message);
        response = null;
      }
    }
  }

  if (!response) {
    return errorResponse(
      `Impossible de charger: <code>${targetURL}</code><br><br>` +
      `Erreur: ${lastError}<br><br>` +
      `Ce site bloque probablement les proxies ou requiert JavaScript côté serveur.`,
      502
    );
  }

  // ─── Build response headers ──────────────────────────────────────
  const contentType = response.headers.get('content-type') || '';
  const responseHeaders = new Headers();

  const passThroughHeaders = ['content-type', 'cache-control', 'expires', 'last-modified', 'etag'];
  for (const h of passThroughHeaders) {
    const v = response.headers.get(h);
    if (v) responseHeaders.set(h, v);
  }
  // Strip security headers
  responseHeaders.delete('x-frame-options');
  responseHeaders.delete('content-security-policy');
  responseHeaders.delete('x-content-type-options');
  responseHeaders.delete('strict-transport-security');

  // ─── Process body ────────────────────────────────────────────────
  let body;
  if (contentType.includes('text/html')) {
    let text;
    try { text = await response.text(); } catch { text = ''; }
    body = rewriteHTML(text, targetURL, encodedBase);
    responseHeaders.set('content-type', 'text/html; charset=utf-8');
  } else if (contentType.includes('text/css')) {
    let text;
    try { text = await response.text(); } catch { text = ''; }
    body = rewriteCSS(text, targetURL);
    responseHeaders.set('content-type', 'text/css; charset=utf-8');
  } else if (contentType.includes('javascript') || contentType.includes('ecmascript')) {
    let text;
    try { text = await response.text(); } catch { text = ''; }
    body = text; // Pass JS as-is (light touch)
    responseHeaders.set('content-type', 'application/javascript; charset=utf-8');
  } else {
    body = response.body;
  }

  return new Response(body, {
    status: response.status || 200,
    headers: responseHeaders,
  });
}

// ─── Build request headers ───────────────────────────────────────────
function buildHeaders(request, targetURL) {
  const headers = new Headers();
  const copy = ['accept', 'accept-language', 'content-type', 'cache-control'];
  for (const h of copy) {
    const v = request.headers.get(h);
    if (v) headers.set(h, v);
  }
  const origin = new URL(targetURL).origin;
  headers.set('Origin', origin);
  headers.set('Referer', targetURL);
  headers.set('User-Agent', 'Mozilla/5.0 (X11; CrOS x86_64 15311.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36');
  return headers;
}

// ─── HTML rewriter ───────────────────────────────────────────────────
function rewriteHTML(html, baseURL, encodedBase) {
  const base = new URL(baseURL);

  const injection = `<script>
/* Phantom Proxy Runtime v1.1 */
(function() {
  const _XOR = ${XOR_KEY};
  const _PREFIX = '${PROXY_PREFIX}';
  const _BASE = '${baseURL}';
  const _ORIGIN = '${base.origin}';

  function _enc(url) {
    try {
      const bytes = new TextEncoder().encode(url);
      const xored = bytes.map(b => b ^ _XOR);
      return btoa(String.fromCharCode(...xored))
        .replace(/\\+/g,'-').replace(/\\//g,'_').replace(/=/g,'~');
    } catch(e) { return null; }
  }

  function _proxy(href, base) {
    try {
      if (!href) return href;
      const s = href.trim();
      if (!s || /^(data:|blob:|javascript:|mailto:|tel:|#|about:)/i.test(s)) return s;
      if (s.startsWith(_PREFIX)) return s;
      const abs = new URL(s, base || _BASE).href;
      const enc = _enc(abs);
      return enc ? _PREFIX + enc : s;
    } catch(e) { return href; }
  }

  // Spoof location
  try {
    Object.defineProperty(window, 'location', {
      configurable: true,
      get: () => ({
        href: _BASE, origin: _ORIGIN,
        hostname: '${base.hostname}', host: '${base.host}',
        pathname: '${base.pathname}', protocol: '${base.protocol}',
        search: '${base.search}', hash: '',
        assign: u => { top.location.href = _proxy(u); },
        replace: u => { top.location.replace(_proxy(u)); },
        reload: () => top.location.reload(),
        toString: () => _BASE,
      })
    });
  } catch(e) {}

  // Patch fetch
  const _oFetch = window.fetch;
  window.fetch = function(input, init) {
    const url = input instanceof Request ? input.url : String(input);
    const p = _proxy(url);
    return _oFetch(p, init);
  };

  // Patch XHR
  const _oOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function(m, url, ...a) {
    return _oOpen.call(this, m, _proxy(url), ...a);
  };

  // Patch History
  const _oPush = history.pushState.bind(history);
  const _oReplace = history.replaceState.bind(history);
  history.pushState = (s,t,u) => _oPush(s, t, u ? _proxy(u) : u);
  history.replaceState = (s,t,u) => _oReplace(s, t, u ? _proxy(u) : u);

  // Patch <a> clicks dynamically
  document.addEventListener('click', function(e) {
    const a = e.target.closest('a');
    if (!a || !a.href) return;
    const p = _proxy(a.href);
    if (p !== a.href) { e.preventDefault(); top.location.href = p; }
  }, true);

})();
<\/script>`;

  // Inject at start of <head>
  if (/<head[^>]*>/i.test(html)) {
    html = html.replace(/(<head[^>]*>)/i, `$1${injection}`);
  } else if (/<html[^>]*>/i.test(html)) {
    html = html.replace(/(<html[^>]*>)/i, `$1${injection}`);
  } else {
    html = injection + html;
  }

  // Rewrite static URL attributes
  const attrs = ['href', 'src', 'action', 'data-src', 'poster'];
  for (const attr of attrs) {
    html = html.replace(new RegExp(`\\b${attr}="([^"]*)"`, 'gi'), (_, val) => {
      return `${attr}="${rewriteAttrURL(val, baseURL)}"`;
    });
    html = html.replace(new RegExp(`\\b${attr}='([^']*)'`, 'gi'), (_, val) => {
      return `${attr}='${rewriteAttrURL(val, baseURL)}'`;
    });
  }

  // Rewrite srcset
  html = html.replace(/\bsrcset="([^"]*)"/gi, (_, val) => {
    const rewritten = val.split(',').map(part => {
      const t = part.trim();
      const sp = t.indexOf(' ');
      const u = sp > -1 ? t.slice(0, sp) : t;
      const d = sp > -1 ? t.slice(sp) : '';
      return rewriteAttrURL(u, baseURL) + d;
    }).join(', ');
    return `srcset="${rewritten}"`;
  });

  // Rewrite CSS url() in style attributes and <style> blocks
  html = html.replace(/url\(\s*['"]?([^'")]+)['"]?\s*\)/gi, (_, val) => {
    return `url("${rewriteAttrURL(val, baseURL)}")`;
  });

  // Remove CSP meta tags
  html = html.replace(/<meta[^>]+http-equiv=["']?content-security-policy["']?[^>]*>/gi, '');

  return html;
}

// ─── CSS rewriter ────────────────────────────────────────────────────
function rewriteCSS(css, baseURL) {
  return css.replace(/url\(\s*['"]?([^'")]+)['"]?\s*\)/gi, (_, val) => {
    return `url("${rewriteAttrURL(val, baseURL)}")`;
  });
}

// ─── URL attribute rewriter ──────────────────────────────────────────
function rewriteAttrURL(href, baseURL) {
  if (!href) return href;
  const s = href.trim();
  if (!s || /^(data:|blob:|javascript:|mailto:|tel:|#|about:)/i.test(s)) return s;
  if (s.startsWith(PROXY_PREFIX)) return s;
  try {
    const abs = new URL(s, baseURL).href;
    return PROXY_PREFIX + encodeURL(abs);
  } catch {
    return href;
  }
}

// ─── Error response ──────────────────────────────────────────────────
function errorResponse(message, status = 500) {
  const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>Phantom — Erreur ${status}</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { background: #080b10; color: #c8d8f0; font-family: 'Courier New', monospace;
      display: flex; align-items: center; justify-content: center; min-height: 100vh; }
    .box { border: 1px solid #ff4560; border-radius: 12px; padding: 2rem; max-width: 560px; width: 90%; }
    h2 { color: #ff4560; margin-bottom: 1.25rem; font-size: 1.2rem; }
    p { color: #7a90a8; font-size: 0.82rem; line-height: 1.7; margin-bottom: 0.75rem; }
    code { background: #0e1420; padding: 0.1em 0.4em; border-radius: 4px; color: #00f5c4; font-size: 0.8rem; word-break: break-all; }
    a { color: #00f5c4; text-decoration: none; }
    a:hover { text-decoration: underline; }
  </style>
</head>
<body>
  <div class="box">
    <h2>⚠ Erreur ${status}</h2>
    <p>${message}</p>
    <p><a href="javascript:history.back()">← Retour</a> &nbsp; <a href="/">🏠 Accueil Phantom</a></p>
  </div>
</body>
</html>`;
  return new Response(html, {
    status,
    headers: { 'content-type': 'text/html; charset=utf-8' }
  });
}
