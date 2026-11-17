/*
 * Mist Browser transport (runs in the bare-mux worker).
 *
 * Two clients send the tabs' requests through the relay:
 *  - libcurl (mbedTLS + nghttp2): copes with header-heavy sites like YouTube, but its TLS can't
 *    handshake with some servers ("error code 35: SSL connect error").
 *  - epoxy (rustls + hyper): handshakes with almost everything, but its HTTP/2 client resets
 *    responses with more than 16 KB of headers.
 * In "auto" mode libcurl goes first; when its TLS handshake fails (before anything was sent), the
 * request is made again with epoxy, and that site keeps using epoxy for an hour.
 */
const sleep = ms => new Promise(r => setTimeout(r, ms));
// libcurl curl codes for failures that happen during the TLS handshake, before the request is sent
const TLS_FAIL = /error code (35|58|59|60|66|77|80|83|90|91|98)\b|SSL connect|SSL peer|certificate/i;
const ALT_MS = 3600e3;

export async function makeTransport(mode, base) {
  const [{ default: Libcurl }, { default: Epoxy }] = await Promise.all([
    mode === 'epoxy' ? { default: null } : import(base + 'libcurl/index.mjs'),
    mode === 'libcurl' ? { default: null } : import(base + 'epoxy/index.mjs')
  ]);

  // libcurl loads its wasm in the background and throws "wasm not loaded yet" until it has
  async function initLibcurl(t) {
    for (let i = 0; ; i++) {
      try { return await t.init(); }
      catch (e) { if (i > 300 || !/not loaded/i.test(String(e && e.message))) throw e; await sleep(100); }
    }
  }

  return class MistTransport {
    constructor(opts) {
      this.opts = opts;
      this.a = Libcurl ? new Libcurl(opts) : null;   // first choice
      this.b = Epoxy ? new Epoxy(opts) : null;       // fallback
      this.alt = new Map();                          // host -> time until which epoxy is used for it
      this.ready = false;
    }
    init() {
      if (!this.initP) this.initP = (this.a ? initLibcurl(this.a) : this.epoxy()).then(() => { this.ready = true; }, e => { this.initP = null; throw e; });
      return this.initP;
    }
    epoxy() {
      if (!this.bP) this.bP = this.b.init().then(() => { this.bReady = true; return this.b; }, e => { this.bP = null; throw e; });
      return this.bP;
    }
    async meta() {}
    useAlt(host) { const t = this.alt.get(host); return !!(this.b && t && t > Date.now()); }

    async request(remote, method, body, headers, signal) {
      if (!this.a) return (await this.epoxy()).request(remote, method, body, headers, signal);
      if (!this.b) return this.a.request(remote, method, body, headers, signal);
      if (this.useAlt(remote.host)) return (await this.epoxy()).request(remote, method, body, headers, signal);
      // a body stream can only be read once; keep a copy in case the request has to be made again
      if (body instanceof ReadableStream || body instanceof Blob) body = await new Response(body).arrayBuffer();
      const copy = body instanceof ArrayBuffer ? body.slice(0) : body;
      try {
        return await this.a.request(remote, method, body, headers, signal);
      } catch (e) {
        if (!TLS_FAIL.test(String(e && (e.message || e)))) throw e;
        this.alt.set(remote.host, Date.now() + ALT_MS);
        return (await this.epoxy()).request(remote, method, copy, headers, signal);
      }
    }

    connect(url, protocols, requestHeaders, onopen, onmessage, onclose, onerror) {
      const useB = !this.a || (this.useAlt(url.host) && this.bReady);
      return (useB ? this.b : this.a).connect(url, protocols, requestHeaders, onopen, onmessage, onclose, onerror);
    }
  };
}
