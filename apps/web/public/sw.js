self.addEventListener("push", function (event) {
  var payload = {};
  try { payload = event.data ? event.data.json() : {}; } catch (_) { payload = {}; }
  var data = payload.data || {};
  event.waitUntil(self.registration.showNotification(payload.title || "Slot Control", {
    body: payload.body || "Há uma atualização no seu Slot Control.",
    tag: payload.tag || data.eventId || "slot-control",
    renotify: false,
    data: data,
    icon: "/icons/slotgain-icon.svg",
    badge: "/icons/maskable-icon.svg"
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
