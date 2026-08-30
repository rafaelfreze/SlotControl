const SLOT_FILTER_PATHS: Readonly<Record<string, string>> = {
  BTC: "/slots?asset=BTC",
  SOL: "/slots?asset=SOL",
  aberto: "/slots?flow=gain",
  open: "/slots?flow=gain",
  closed: "/slots?flow=abrir",
  free: "/slots?flow=abrir"
};

export function getSlotsReturnPath(filter: unknown): string {
  if (typeof filter !== "string") return "/slots";
  return SLOT_FILTER_PATHS[filter] || "/slots";
}

export function addNoticeToPath(path: string, message: string): string {
  const [pathname, query = ""] = path.split("?", 2);
  const params = new URLSearchParams(query);
  params.set("notice", message);
  return `${pathname}?${params.toString()}`;
}
