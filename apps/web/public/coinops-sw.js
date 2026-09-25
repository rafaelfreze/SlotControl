/* CoinOps notifications only. No data or pages are cached by this worker. */
self.addEventListener("push", (event) => {
  if (!event.data) return;
  let payload;
  try { payload = event.data.json(); } catch { return; }
  const title = typeof payload.title === "string" ? payload.title.slice(0, 80) : "CoinOps — ALERTA";
  const body = typeof payload.body === "string" ? payload.body.slice(0, 200) : "Alerta operacional";
  const tag = typeof payload.tag === "string" ? payload.tag.slice(0, 100) : "coinops-alert";
  const url = typeof payload.url === "string" && payload.url.startsWith("/automacao") ? payload.url : "/automacao?view=live";
  event.waitUntil(self.registration.showNotification(title, {
    body, tag, icon: "/icon-192x192.png", badge: "/icon-192x192.png",
    data: { url }, renotify: false,
  }));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = new URL(event.notification.data?.url || "/automacao?view=live", self.location.origin);
  if (target.origin !== self.location.origin || target.pathname !== "/automacao") return;
  event.waitUntil((async () => {
    const clients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    const existing = clients.find((client) => new URL(client.url).origin === self.location.origin);
    if (existing) { await existing.navigate(target.href); return existing.focus(); }
    return self.clients.openWindow(target.href);
  })());
});
