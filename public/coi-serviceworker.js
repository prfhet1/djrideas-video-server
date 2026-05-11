/* coi-serviceworker v0.1.7 - Guido Zuidhof, licensed under MIT */
let coepCredentialless = false;
if (typeof window === 'undefined') {
  self.addEventListener("install", () => self.skipWaiting());
  self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));
  self.addEventListener("fetch", function(event) {
    if (event.request.cache === "only-if-cached" && event.request.mode !== "same-origin") return;
    event.respondWith(
      fetch(event.request).then(function(response) {
        if (response.status === 0) return response;
        const newHeaders = new Headers(response.headers);
        newHeaders.set("Cross-Origin-Opener-Policy", "same-origin");
        newHeaders.set("Cross-Origin-Embedder-Policy", coepCredentialless ? "credentialless" : "require-corp");
        newHeaders.set("Cross-Origin-Resource-Policy", "cross-origin");
        return new Response(response.body, {
          status: response.status,
          statusText: response.statusText,
          headers: newHeaders,
        });
      })
    );
  });
} else {
  (async function() {
    const reloadedBySelf = window.sessionStorage.getItem("coiReloadedBySelf");
    window.sessionStorage.removeItem("coiReloadedBySelf");
    const coiEnabled = window.crossOriginIsolated;
    if (!coiEnabled) {
      if ("serviceWorker" in navigator) {
        try {
          await navigator.serviceWorker.register(window.document.currentScript.src);
          window.sessionStorage.setItem("coiReloadedBySelf", "true");
          window.location.reload();
        } catch(e) {
          console.log("COI serviceworker registration failed:", e);
        }
      }
    }
  })();
}
