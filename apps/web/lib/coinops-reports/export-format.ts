import { createHash } from "node:crypto";
import { deflateRawSync } from "node:zlib";

export type ExportRow = Record<string, unknown>;
export type ExportColumn = { key: string; label: string };
const PRIVATE_KEY = /(?:api.?key|api.?secret|secret|password|senha|cookie|authorization|token|private.?key|service.?role|anon.?key|credential|signature)/i;
const PRIVATE_TEXT = /(?:bearer\s+\S+|eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+|-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----|(?:api[_-]?key|api[_-]?secret|password|senha|token|secret|authorization|cookie)\s*[=:]\s*[^\s,;]+)/gi;
const PRIVATE_TEXT_CONTEXT = /(?:authorization|cookie|api[_-]?key|api[_-]?secret|password|senha|token|secret)\s*[=:]|\b(?:bearer|basic)\s+\S+|-----BEGIN [A-Z ]*PRIVATE KEY-----/i;

/** Defense in depth after explicit database column selection. Never serialize credentials or request headers. */
export function sanitizeExportValue(value: unknown, depth = 0): unknown {
  if (depth > 16) return "[estrutura omitida]";
  if (value == null || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  // Credential-bearing free text can contain spaces, quoted values or several
  // cookies. Omit the whole value so no suffix survives partial replacement.
  if (typeof value === "string") return PRIVATE_TEXT_CONTEXT.test(value) ? "[REDACTED]" : value.replace(PRIVATE_TEXT, "[REDACTED]");
  if (Array.isArray(value)) return value.map((item) => sanitizeExportValue(item, depth + 1));
  if (typeof value === "object") return Object.fromEntries(Object.entries(value).filter(([key]) => !PRIVATE_KEY.test(key) && !["headers", "request_headers", "response_headers"].includes(key.toLowerCase())).sort(([a], [b]) => a.localeCompare(b, "en")).map(([key, item]) => [key, sanitizeExportValue(item, depth + 1)]));
  return null;
}

export function stableJson(value: unknown, pretty = true) { return JSON.stringify(sanitizeExportValue(value), null, pretty ? 2 : undefined) + (pretty ? "\n" : ""); }

export function csvCell(value: unknown) {
  const safe = sanitizeExportValue(value);
  let text = safe == null ? "" : typeof safe === "object" ? stableJson(safe, false) : String(safe);
  // Preserve numeric negative values while neutralizing spreadsheet formula injection in text cells.
  if (typeof safe === "string" && /^[\s\u0000-\u001f]*[=+@-]/.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}
export function csvHeader(columns: ExportColumn[]) { return "\uFEFF" + columns.map((column) => csvCell(column.label)).join(";") + "\r\n"; }
export function csvRows(rows: ExportRow[], columns: ExportColumn[]) { return rows.map((row) => columns.map((column) => csvCell(row[column.key])).join(";") + "\r\n").join(""); }
export function buildCsv(rows: ExportRow[], columns: ExportColumn[]) { return csvHeader(columns) + csvRows(rows, columns); }
export function sha256(data: Uint8Array | string) { return createHash("sha256").update(data).digest("hex"); }

const CRC_TABLE = Array.from({ length: 256 }, (_, i) => { let c = i; for (let bit = 0; bit < 8; bit++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
export function crc32(bytes: Uint8Array) { let crc = 0xffffffff; for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8); return (crc ^ 0xffffffff) >>> 0; }
export type PackageFile = { name: string; content: string };

/** ZIP/DEFLATE with deterministic DOS timestamp and UTF-8 filenames. No dependencies or temporary/public files. */
export function buildZip(files: PackageFile[]): Uint8Array {
  const entries: Buffer[] = [], directory: Buffer[] = [];
  let offset = 0;
  for (const file of files) {
    if (!/^[A-Z0-9_a-z.-]+$/.test(file.name) || file.name.includes("..")) throw new Error("REPORT_FILENAME_INVALID");
    const name = Buffer.from(file.name, "utf8"), raw = Buffer.from(file.content, "utf8"), compressed = deflateRawSync(raw), crc = crc32(raw);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0); header.writeUInt16LE(20, 4); header.writeUInt16LE(0x800, 6); header.writeUInt16LE(8, 8); header.writeUInt16LE(33, 12);
    header.writeUInt32LE(crc, 14); header.writeUInt32LE(compressed.length, 18); header.writeUInt32LE(raw.length, 22); header.writeUInt16LE(name.length, 26);
    entries.push(header, name, compressed);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(0x800, 8); central.writeUInt16LE(8, 10); central.writeUInt16LE(33, 14);
    central.writeUInt32LE(crc, 16); central.writeUInt32LE(compressed.length, 20); central.writeUInt32LE(raw.length, 24); central.writeUInt16LE(name.length, 28); central.writeUInt32LE(offset, 42);
    directory.push(central, name); offset += header.length + name.length + compressed.length;
  }
  const central = Buffer.concat(directory), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10); end.writeUInt32LE(central.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...entries, central, end]);
}
