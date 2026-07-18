self.addEventListener("push", function (event) {
  var payload = {};
  try { payload = event.data ? event.data.json() : {}; } catch (_) { payload = {}; }
  var data = payload.data || {};
  event.waitUntil(self.registration.showNotification(payload.title || "CoinOps", {
    body: payload.body || "Há uma atualização no seu CoinOps.",
    tag: payload.tag || data.eventId || "coinops",
    renotify: false,
    data: data,
    icon: "/icon-192x192.png",
    badge: "/icon-maskable-192x192.png"
  }));
});

self.addEventListener("notificationclick", function (event) {
  event.notification.close();
  var target = event.notification.data && event.notification.data.url ? event.notification.data.url : "/slots";
  event.waitUntil(clients.matchAll({ type: "window", includeUncontrolled: true }).then(function (windows) {
    for (var i = 0; i < windows.length; i += 1) {
      if ("focus" in windows[i]) { windows[i].navigate(target); return windows[i].focus(); }
    }
    return clients.openWindow(target);
  }));
});
