/**
 * Phantom Proxy — Service Worker
 * Intercepte toutes les requêtes /proxy/* et les reroute
 * Compatible Chrome 130+ / Chromebook
 */

const PHANTOM_VERSION = '1.0.0';
const PROXY_PREFIX = 'proxy/';
const XOR_KEY = 0x5A; // Doit correspondre à index.html

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
  console.log('[Phantom SW] Activate');
  e.waitUntil(self.clients.claim());
});

// ─── Fetch intercept ────────────────────────────────────────────────
self.addEventListener('fetch', e => {
  const url = e.request.url;
  const parsedURL = new URL(url);

  // Only intercept /proxy/* routes
  if (!parsedURL.pathname.startsWith(PROXY_PREFIX)) return;

  e.respondWith(handleProxyRequest(e.request, parsedURL));
});

// ─── Main proxy handler ─────────────────────────────────────────────
async function handleProxyRequest(request, parsedURL) {
  // Extract encoded target from path
  // Path format: /proxy/<encoded_url>[/extra/path]
  const afterPrefix = parsedURL.pathname.slice(PROXY_PREFIX.length);

  // Split at first slash to separate the encoded base URL from sub-paths
  const slashIdx = afterPrefix.indexOf('/');
  let encodedBase, extraPath;
  if (slashIdx === -1) {
    encodedBase = afterPrefix;
    extraPath = '';
  } else {
    encodedBase = afterPrefix.slice(0, slashIdx);
    extraPath = afterPrefix.slice(slashIdx);
  }

  // Decode base target URL
  const baseTarget = decodeURL(encodedBase);
  if (!baseTarget) {
    return errorResponse('URL cible invalide ou corrompue.', 400);
  }

  // Reconstruct full target URL with extra path and original query
  let targetURL;
  try {
    const base = new URL(baseTarget);
    targetURL = base.origin + (extraPath || base.pathname) + parsedURL.search;
  } catch {
    return errorResponse('URL malformée: ' + baseTarget, 400);
  }

  // Build fetch headers — strip problematic ones, spoof origin
  const headers = new Headers();
  const copyHeaders = ['accept', 'accept-language', 'content-type', 'content-length', 'cache-control'];
  for (const h of copyHeaders) {
    const v = request.headers.get(h);
    if (v) headers.set(h, v);
  }

  const targetOrigin = new URL(targetURL).origin;
  headers.set('Origin', targetOrigin);
  headers.set('Referer', targetURL);
  headers.set('User-Agent', 'Mozilla/5.0 (X11; CrOS x86_64 15311.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36');
  headers.set('X-Forwarded-For', '127.0.0.1');

  let response;
  try {
    response = await fetch(targetURL, {
      method: request.method,
      headers,
      body: ['GET', 'HEAD'].includes(request.method) ? undefined : await request.blob(),
      redirect: 'follow',
      credentials: 'omit',
      mode: 'cors',
    });
  } catch (err) {
    // Try without CORS mode as fallback
    try {
      response = await fetch(targetURL, {
        method: request.method,
        headers,
        body: ['GET', 'HEAD'].includes(request.method) ? undefined : await request.blob(),
        redirect: 'follow',
        credentials: 'omit',
        mode: 'no-cors',
      });
    } catch (err2) {
      return errorResponse('Impossible de récupérer: ' + targetURL + '\n' + err2.message, 502);
    }
  }

  // Get content type
  const contentType = response.headers.get('content-type') || '';

  // Build response headers
  const responseHeaders = new Headers();
  const passThroughHeaders = ['content-type', 'content-length', 'cache-control', 'expires', 'last-modified', 'etag'];
  for (const h of passThroughHeaders) {
    const v = response.headers.get(h);
    if (v) responseHeaders.set(h, v);
  }

  // Remove security headers that would block us
  responseHeaders.delete('x-frame-options');
  responseHeaders.delete('content-security-policy');
  responseHeaders.delete('x-content-type-options');

  // Process body based on content type
  let body;
  if (contentType.includes('text/html')) {
    const text = await response.text();
    body = rewriteHTML(text, targetURL, encodedBase);
    responseHeaders.set('content-type', 'text/html; charset=utf-8');
    responseHeaders.delete('content-length');
  } else if (contentType.includes('text/css')) {
    const text = await response.text();
    body = rewriteCSS(text, targetURL, encodedBase);
    responseHeaders.set('content-type', 'text/css; charset=utf-8');
    responseHeaders.delete('content-length');
  } else if (contentType.includes('javascript') || contentType.includes('ecmascript')) {
    const text = await response.text();
    body = rewriteJS(text, targetURL);
    responseHeaders.set('content-type', 'application/javascript; charset=utf-8');
    responseHeaders.delete('content-length');
  } else {
    body = response.body;
  }

  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: responseHeaders,
  });
}

// ─── HTML rewriter ──────────────────────────────────────────────────
function rewriteHTML(html, baseURL, encodedBase) {
  const base = new URL(baseURL);

  // Inject phantom base + rewrite script at the top of <head>
  const injection = `
<script>
/* Phantom Proxy Injected Runtime */
(function() {
  const _XOR = ${XOR_KEY};
  const _PREFIX = '${PROXY_PREFIX}';

  function _enc(url) {
    try {
      const bytes = new TextEncoder().encode(url);
      const xored = bytes.map(b => b ^ _XOR);
      return btoa(String.fromCharCode(...xored))
        .replace(/\\+/g,'-').replace(/\\//g,'_').replace(/=/g,'~');
    } catch(e) { return null; }
  }

  function _resolveAndEncode(href, base) {
    try {
      if (!href || href.startsWith('data:') || href.startsWith('blob:') || href.startsWith('javascript:') || href.startsWith('#')) return href;
      const abs = new URL(href, base).href;
      return _PREFIX + _enc(abs);
    } catch(e) { return href; }
  }

  // Patch window.location
  const _realOrigin = '${base.origin}';
  const _realHref = '${baseURL}';

  try {
    Object.defineProperty(window, 'location', {
      get: function() {
        return {
          href: _realHref,
          origin: _realOrigin,
          hostname: '${base.hostname}',
          host: '${base.host}',
          pathname: '${base.pathname}',
          protocol: '${base.protocol}',
          search: '${base.search}',
          hash: '',
          assign: function(url) { window.location.href = _resolveAndEncode(url, _realHref); },
          replace: function(url) { window.location.href = _resolveAndEncode(url, _realHref); },
          reload: function() { window.location.reload(); },
          toString: function() { return _realHref; }
        };
      }
    });
  } catch(e) {}

  // Patch fetch
  const _origFetch = window.fetch;
  window.fetch = function(input, init) {
    let url = (input instanceof Request) ? input.url : input;
    url = _resolveAndEncode(url, _realHref);
    if (input instanceof Request) {
      return _origFetch(new Request(url, input), init);
    }
    return _origFetch(url, init);
  };

  // Patch XMLHttpRequest
  const _origOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function(method, url, ...args) {
    const rewritten = _resolveAndEncode(url, _realHref);
    return _origOpen.call(this, method, rewritten, ...args);
  };

  // Patch history
  const _origPushState = history.pushState.bind(history);
  const _origReplaceState = history.replaceState.bind(history);
  history.pushState = function(state, title, url) {
    if (url) url = _resolveAndEncode(url, _realHref);
    return _origPushState(state, title, url || undefined);
  };
  history.replaceState = function(state, title, url) {
    if (url) url = _resolveAndEncode(url, _realHref);
    return _origReplaceState(state, title, url || undefined);
  };

  // Patch document.cookie (basic passthrough)
  // Patch WebSocket
  const _OrigWS = window.WebSocket;
  window.WebSocket = function(url, protocols) {
    // Convert ws:// to wss:// proxy - limited support
    return new _OrigWS(url, protocols);
  };
  window.WebSocket.prototype = _OrigWS.prototype;

})();
<\/script>
<base href="${base.origin}">
`;

  // Inject after <head> or at the start
  if (/<head[^>]*>/i.test(html)) {
    html = html.replace(/<head([^>]*)>/i, `<head$1>${injection}`);
  } else {
    html = injection + html;
  }

  // Rewrite all URL attributes
  const urlAttrs = ['href', 'src', 'action', 'data-src', 'poster', 'srcset'];
  for (const attr of urlAttrs) {
    if (attr === 'srcset') {
      html = html.replace(new RegExp(`${attr}="([^"]*)"`, 'gi'), (match, val) => {
        const rewritten = val.split(',').map(part => {
          const trimmed = part.trim();
          const space = trimmed.indexOf(' ');
          const url = space > -1 ? trimmed.slice(0, space) : trimmed;
          const descriptor = space > -1 ? trimmed.slice(space) : '';
          return rewriteAttrURL(url, baseURL, encodedBase) + descriptor;
        }).join(', ');
        return `${attr}="${rewritten}"`;
      });
    } else {
      html = html.replace(new RegExp(`${attr}="([^"]*)"`, 'gi'), (match, val) => {
        return `${attr}="${rewriteAttrURL(val, baseURL, encodedBase)}"`;
      });
    }
  }

  // Rewrite inline style url()
  html = html.replace(/url\(['"]?([^'")]+)['"]?\)/gi, (match, val) => {
    return `url("${rewriteAttrURL(val, baseURL, encodedBase)}")`;
  });

  return html;
}

// ─── CSS rewriter ────────────────────────────────────────────────────
function rewriteCSS(css, baseURL, encodedBase) {
  return css.replace(/url\(['"]?([^'")]+)['"]?\)/gi, (match, val) => {
    return `url("${rewriteAttrURL(val, baseURL, encodedBase)}")`;
  });
}

// ─── JS rewriter (light touch) ──────────────────────────────────────
function rewriteJS(js, baseURL) {
  // Only rewrite absolute URLs in string literals — conservative approach
  // to avoid breaking JS logic
  return js;
}

// ─── URL attribute rewriter ─────────────────────────────────────────
function rewriteAttrURL(href, baseURL, encodedBase) {
  if (!href) return href;
  // Skip special schemes
  if (/^(data:|blob:|javascript:|mailto:|tel:|#|about:)/i.test(href)) return href;
  // Already proxied
  if (href.startsWith(PROXY_PREFIX)) return href;

  try {
    const abs = new URL(href, baseURL).href;
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
  <title>Phantom — Erreur</title>
  <style>
    body { background: #080b10; color: #c8d8f0; font-family: monospace; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; }
    .box { border: 1px solid #ff4560; border-radius: 12px; padding: 2rem; max-width: 500px; }
    h2 { color: #ff4560; margin-bottom: 1rem; }
    p { color: #4a6080; font-size: 0.85rem; line-height: 1.6; }
    a { color: #00f5c4; }
  </style>
</head>
<body>
  <div class="box">
    <h2>⚠ Erreur ${status}</h2>
    <p>${message}</p>
    <p><a href="/">← Retour à Phantom</a></p>
  </div>
</body>
</html>`;
  return new Response(html, {
    status,
    headers: { 'content-type': 'text/html; charset=utf-8' }
  });
}
