/* Ultraviolet settings for Mist Browser. Everything is relative to where this file is served
   (/browse/ behind nginx), so the same files work under any path. Loaded by the tab page, the
   service worker and every proxied page. */
(function () {
  var src = (self.document && document.currentScript && document.currentScript.src) || self.location.href;
  var base = new URL('./', src).pathname;
  self.__uv$config = {
    prefix: base + 'service/',
    encodeUrl: Ultraviolet.codec.xor.encode,
    decodeUrl: Ultraviolet.codec.xor.decode,
    handler: base + 'uv/uv.handler.js',
    client: base + 'uv/uv.client.js',
    bundle: base + 'uv/uv.bundle.js',
    config: base + 'uv.config.js',
    sw: base + 'uv/uv.sw.js'
  };
})();
