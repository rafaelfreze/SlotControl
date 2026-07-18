self.addEventListener("push", function (event) {
  var payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch (_) {
    payload = {
      title: "CoinOps",
      body: event.data ? event.data.text() : "Nova atualização disponível."
    };
  }

  var data = payload.data || { url: "/" };
  event.waitUntil(self.registration.showNotification(payload.title || "CoinOps", {
    body: payload.body || "Nova atualização disponível.",
    tag: payload.tag || data.eventId || ("coinops-" + Date.now()),
    renotify: false,
    data: data,
    icon: payload.icon || "/icon-192x192.png",
    badge: payload.badge || "/icon-96x96.png"
  }));
});

self.addEventListener("notificationclick", function (event) {
  event.notification.close();
  var target = event.notification.data && event.notification.data.url ? event.notification.data.url : "/config";
  event.waitUntil(clients.matchAll({ type: "window", includeUncontrolled: true }).then(function (windows) {
    for (var i = 0; i < windows.length; i += 1) {
      if ("focus" in windows[i] && windows[i].url.indexOf(self.location.origin) === 0) {
        return windows[i].navigate(target).then(function () { return windows[i].focus(); });
      }
    }
    return clients.openWindow(target);
  }));
});
