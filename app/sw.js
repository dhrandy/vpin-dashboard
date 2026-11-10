/* Network-only worker. No responses, credentials or cabinet data are cached. */
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));
/* No fetch handler: API, authentication and pages always use the network. */
