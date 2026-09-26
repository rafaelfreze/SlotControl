export function applicationKey(value: string) {
  const padded = `${value.replaceAll("-", "+").replaceAll("_", "/")}${"=".repeat((4 - value.length % 4) % 4)}`;
  return Uint8Array.from(atob(padded), (char) => char.charCodeAt(0));
}

export function subscriptionUsesKey(subscription: Pick<PushSubscription, "options">, publicKey: string) {
  const current = subscription.options?.applicationServerKey;
  if (!current) return false;
  const expected = applicationKey(publicKey);
  const actual = new Uint8Array(current);
  return actual.length === expected.length && actual.every((byte, index) => byte === expected[index]);
}
