import { createCipheriv, createDecipheriv, createHash, createHmac, hkdfSync, randomBytes, randomUUID } from "node:crypto";
import { open, readFile, readdir, rename, stat, unlink } from "node:fs/promises";
import { join } from "node:path";

import { assertPrivateDirectory, ExecutorRejection } from "./security.mjs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REF = /^account_[0-9a-f]{32}$/;
const HMAC_CREDENTIAL = /^[A-Za-z0-9]{32,128}$/;
const HOSTS = { REAL: "https://api.binance.com", TESTNET: "https://testnet.binance.vision" };
const hash = (value) => createHash("sha256").update(value).digest("hex");
const fail = (code, status = 400) => { throw new ExecutorRejection(code, status); };
const grant = (value) => value === true ? true : value === false ? false : null;

export function assertCredentialScope(input) {
  if (!UUID.test(input?.operator_id ?? "") || !UUID.test(input?.exchange_account_id ?? "")
    || input?.credential_ref !== `account_${input.exchange_account_id.replaceAll("-", "")}`
    || !REF.test(input.credential_ref) || !["REAL", "TESTNET"].includes(input.environment))
    fail("EXECUTOR_CREDENTIAL_SCOPE_INVALID", 403);
  return input;
}

function vaultKey(masterSecret) {
  if (typeof masterSecret !== "string" || Buffer.byteLength(masterSecret) < 32)
    fail("EXECUTOR_CREDENTIAL_VAULT_UNAVAILABLE", 503);
  return Buffer.from(hkdfSync("sha256", Buffer.from(masterSecret), Buffer.from("coinops-executor-vault-v1"),
    Buffer.from("binance-account-credentials"), 32));
}

function credentialPath(directory, accountId) {
  if (!UUID.test(accountId ?? "")) fail("EXECUTOR_CREDENTIAL_SCOPE_INVALID", 403);
  return join(directory, `${accountId}.json`);
}

async function readDocument(directory, accountId) {
  await assertPrivateDirectory(directory);
  const path = credentialPath(directory, accountId);
  const metadata = await stat(path).catch((error) => {
    if (error?.code === "ENOENT") return null;
    throw error;
  });
  if (!metadata) return null;
  if (process.platform !== "win32" && (metadata.mode & 0o077) !== 0)
    fail("EXECUTOR_CREDENTIAL_FILE_NOT_PRIVATE", 503);
  const document = JSON.parse(await readFile(path, "utf8"));
  if (document.version !== 1 || document.exchange_account_id !== accountId)
    fail("EXECUTOR_CREDENTIAL_FILE_INVALID", 503);
  return document;
}

function seal(input, secret, masterSecret, observation) {
  const iv = randomBytes(12);
  const aad = JSON.stringify({ operator_id: input.operator_id, exchange_account_id: input.exchange_account_id,
    credential_ref: input.credential_ref, environment: input.environment });
  const cipher = createCipheriv("aes-256-gcm", vaultKey(masterSecret), iv);
  cipher.setAAD(Buffer.from(aad));
  const encrypted = Buffer.concat([cipher.update(JSON.stringify({ apiKey: secret.apiKey, apiSecret: secret.apiSecret })), cipher.final()]);
  return { version: 1, ...JSON.parse(aad), fingerprint: hash(secret.apiKey).slice(0, 12),
    uid_hash: observation.uidHash, status: observation.status, validated_at: observation.validatedAt,
    iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), ciphertext: encrypted.toString("base64") };
}

function unseal(document, masterSecret) {
  const aad = JSON.stringify({ operator_id: document.operator_id, exchange_account_id: document.exchange_account_id,
    credential_ref: document.credential_ref, environment: document.environment });
  try {
    const decipher = createDecipheriv("aes-256-gcm", vaultKey(masterSecret), Buffer.from(document.iv, "base64"));
    decipher.setAAD(Buffer.from(aad));
    decipher.setAuthTag(Buffer.from(document.tag, "base64"));
    return JSON.parse(Buffer.concat([decipher.update(Buffer.from(document.ciphertext, "base64")), decipher.final()]).toString("utf8"));
  } catch { fail("EXECUTOR_CREDENTIAL_DECRYPT_FAILED", 503); }
}

export async function loadCredential(directory, masterSecret, scope) {
  assertCredentialScope(scope);
  const document = await readDocument(directory, scope.exchange_account_id);
  if (!document || document.operator_id !== scope.operator_id || document.credential_ref !== scope.credential_ref
    || document.environment !== scope.environment) fail("EXECUTOR_BINANCE_CREDENTIALS_MISSING", 503);
  return unseal(document, masterSecret);
}

export async function credentialMetadata(directory, scope) {
  assertCredentialScope(scope);
  const document = await readDocument(directory, scope.exchange_account_id);
  if (!document) return null;
  if (document.operator_id !== scope.operator_id || document.credential_ref !== scope.credential_ref
    || document.environment !== scope.environment) fail("EXECUTOR_CREDENTIAL_SCOPE_INVALID", 403);
  return { credential_ref: document.credential_ref, fingerprint: document.fingerprint,
    status: document.status, validated_at: document.validated_at, environment: document.environment };
}

async function signedGet(fetcher, host, path, apiKey, apiSecret, time) {
  const query = new URLSearchParams({ recvWindow: "5000", timestamp: String(time) });
  query.set("signature", createHmac("sha256", apiSecret).update(query.toString()).digest("hex"));
  const response = await fetcher(`${host}${path}?${query}`, { method: "GET", cache: "no-store",
    signal: AbortSignal.timeout(8_000), headers: { accept: "application/json", "X-MBX-APIKEY": apiKey } });
  if (!response.ok) fail("EXECUTOR_CREDENTIAL_BINANCE_GET_FAILED", 422);
  return response.json();
}

/** Authenticated GETs only. The result deliberately excludes both submitted values. */
export async function inspectBinanceCredential({ apiKey, apiSecret, environment, expectedEgressIp,
  fetcher = fetch, now = Date.now }) {
  if (!HMAC_CREDENTIAL.test(apiKey ?? "") || !HMAC_CREDENTIAL.test(apiSecret ?? "")
    || !HOSTS[environment]) fail("EXECUTOR_CREDENTIAL_FORMAT_INVALID", 422);
  const host = HOSTS[environment];
  const timeResponse = await fetcher(`${host}/api/v3/time`, { method: "GET", cache: "no-store",
    signal: AbortSignal.timeout(8_000) });
  if (!timeResponse.ok) fail("EXECUTOR_CREDENTIAL_BINANCE_GET_FAILED", 503);
  const serverTime = Number((await timeResponse.json()).serverTime);
  if (!Number.isSafeInteger(serverTime) || Math.abs(serverTime - now()) > 5_000)
    fail("EXECUTOR_CREDENTIAL_CLOCK_INVALID", 503);
  const account = await signedGet(fetcher, host, "/api/v3/account", apiKey, apiSecret, serverTime);
  if (!Array.isArray(account.balances) || typeof account.canTrade !== "boolean")
    fail("EXECUTOR_CREDENTIAL_ACCOUNT_INVALID", 503);
  const restrictions = environment === "REAL"
    ? await signedGet(fetcher, host, "/sapi/v1/account/apiRestrictions", apiKey, apiSecret, serverTime)
    : null;
  const ipResponse = await fetcher("https://api.ipify.org?format=json", { method: "GET", cache: "no-store",
    signal: AbortSignal.timeout(8_000) });
  const observedIp = ipResponse.ok ? (await ipResponse.json()).ip : null;
  const whitelistAccepted = environment === "REAL" ? restrictions?.ipRestrict === true
    && observedIp === expectedEgressIp : null;
  const permission = { read: environment === "REAL" ? grant(restrictions?.enableReading) : true,
    spotTrading: environment === "REAL" ? grant(restrictions?.enableSpotAndMarginTrading) === true && account.canTrade : account.canTrade,
    withdrawals: environment === "REAL" ? grant(restrictions?.enableWithdrawals) : null,
    internalTransfer: environment === "REAL" ? grant(restrictions?.enableInternalTransfer) : null,
    universalTransfer: environment === "REAL" ? grant(restrictions?.permitsUniversalTransfer) : null,
    margin: environment === "REAL" ? grant(restrictions?.enableMargin) : null,
    futures: environment === "REAL" ? grant(restrictions?.enableFutures) : null,
    options: environment === "REAL" ? grant(restrictions?.enableVanillaOptions) : null,
    fixTrading: environment === "REAL" ? grant(restrictions?.enableFixApiTrade) : null,
    portfolioMargin: environment === "REAL" ? grant(restrictions?.enablePortfolioMarginTrading) : null };
  // Missing permission fields are UNKNOWN, never proof that a dangerous grant is disabled.
  const safe = environment === "REAL" && whitelistAccepted === true && permission.read === true
    && permission.spotTrading === true && ["withdrawals", "internalTransfer", "universalTransfer",
      "margin", "futures", "options", "fixTrading", "portfolioMargin"].every((name) => permission[name] === false);
  const balances = account.balances.filter((row) => /^[A-Z0-9]{2,20}$/.test(row.asset ?? ""))
    .map((row) => ({ asset: row.asset, free: Number(row.free), locked: Number(row.locked) }))
    .filter((row) => Number.isFinite(row.free) && Number.isFinite(row.locked) && row.free >= 0 && row.locked >= 0);
  const uid = account.uid === undefined || account.uid === null ? null : String(account.uid);
  return { status: safe ? "PASS" : "WARNING", valid: true, accountIdentity: uid ? `UID ••••${uid.slice(-4)}` : "Conta Spot autenticada",
    uidHash: uid ? hash(`${environment}:${uid}`) : null, executorIp: observedIp, whitelistAccepted,
    permission, balances, validatedAt: new Date(now()).toISOString() };
}

async function withAccountLock(directory, accountId, work) {
  await assertPrivateDirectory(directory);
  const lockPath = `${credentialPath(directory, accountId)}.lock`;
  let handle;
  try { handle = await open(lockPath, "wx", 0o600); }
  catch (error) {
    if (error?.code === "EEXIST") fail("EXECUTOR_CREDENTIAL_OPERATION_IN_PROGRESS", 409);
    throw error;
  }
  try { return await work(); }
  finally { await handle.close(); await unlink(lockPath).catch(() => {}); }
}

export async function saveCredential({ directory, masterSecret, scope, apiKey, apiSecret, observation,
  replace = false }) {
  assertCredentialScope(scope);
  if (!HMAC_CREDENTIAL.test(apiKey ?? "") || !HMAC_CREDENTIAL.test(apiSecret ?? ""))
    fail("EXECUTOR_CREDENTIAL_FORMAT_INVALID", 422);
  return withAccountLock(directory, scope.exchange_account_id, async () => {
    const previous = await readDocument(directory, scope.exchange_account_id);
    const fingerprint = hash(apiKey).slice(0, 12);
    for (const name of await readdir(directory)) {
      if (!UUID.test(name.replace(/\.json$/, "")) || name === `${scope.exchange_account_id}.json`) continue;
      const other = await readDocument(directory, name.slice(0, -5));
      if (other?.fingerprint === fingerprint || observation.uidHash && other?.uid_hash === observation.uidHash)
        fail("EXECUTOR_CREDENTIAL_ALREADY_BOUND", 409);
    }
    if (previous && (previous.operator_id !== scope.operator_id || previous.environment !== scope.environment
      || previous.credential_ref !== scope.credential_ref)) fail("EXECUTOR_CREDENTIAL_SCOPE_INVALID", 403);
    if (previous && !replace && previous.fingerprint !== fingerprint) fail("EXECUTOR_CREDENTIAL_ALREADY_EXISTS", 409);
    if (!previous && replace) fail("EXECUTOR_CREDENTIAL_NOT_FOUND", 404);
    if (replace && (!previous.uid_hash || !observation.uidHash || previous.uid_hash !== observation.uidHash))
      fail("EXECUTOR_CREDENTIAL_ACCOUNT_IDENTITY_MISMATCH", 409);
    if (previous?.fingerprint === fingerprint && !replace) return { credential_ref: previous.credential_ref,
      fingerprint: previous.fingerprint, status: previous.status, validated_at: previous.validated_at };
    const document = seal(scope, { apiKey, apiSecret }, masterSecret, observation);
    const target = credentialPath(directory, scope.exchange_account_id);
    const temporary = `${target}.${randomUUID()}.tmp`;
    const handle = await open(temporary, "wx", 0o600);
    try { await handle.writeFile(JSON.stringify(document)); } finally { await handle.close(); }
    try { await rename(temporary, target); } catch (error) { await unlink(temporary).catch(() => {}); throw error; }
    return { credential_ref: document.credential_ref, fingerprint: document.fingerprint,
      status: document.status, validated_at: document.validated_at };
  });
}

export async function refreshCredential({ directory, masterSecret, scope, expectedEgressIp, fetcher, now }) {
  const secret = await loadCredential(directory, masterSecret, scope);
  const observation = await inspectBinanceCredential({ ...secret, environment: scope.environment,
    expectedEgressIp, fetcher, now });
  return withAccountLock(directory, scope.exchange_account_id, async () => {
    const previous = await readDocument(directory, scope.exchange_account_id);
    if (!previous || previous.operator_id !== scope.operator_id || previous.environment !== scope.environment
      || previous.credential_ref !== scope.credential_ref) fail("EXECUTOR_CREDENTIAL_SCOPE_INVALID", 403);
    const current = unseal(previous, masterSecret);
    if (current.apiKey !== secret.apiKey || current.apiSecret !== secret.apiSecret)
      fail("EXECUTOR_CREDENTIAL_CHANGED_DURING_VALIDATION", 409);
    const document = seal(scope, secret, masterSecret, observation);
    const target = credentialPath(directory, scope.exchange_account_id);
    const temporary = `${target}.${randomUUID()}.tmp`;
    const handle = await open(temporary, "wx", 0o600);
    try { await handle.writeFile(JSON.stringify(document)); } finally { await handle.close(); }
    try { await rename(temporary, target); } catch (error) { await unlink(temporary).catch(() => {}); throw error; }
    return { ...observation, credential_ref: document.credential_ref, fingerprint: document.fingerprint };
  });
}

export async function assertNoExchangeOpenOrders({ directory, masterSecret, scope, fetcher = fetch, now = Date.now }) {
  const { apiKey, apiSecret } = await loadCredential(directory, masterSecret, scope);
  const host = HOSTS[scope.environment];
  const timeResponse = await fetcher(`${host}/api/v3/time`, { method: "GET", cache: "no-store",
    signal: AbortSignal.timeout(8_000) });
  if (!timeResponse.ok) fail("EXECUTOR_CREDENTIAL_BINANCE_GET_FAILED", 503);
  const serverTime = Number((await timeResponse.json()).serverTime);
  if (!Number.isSafeInteger(serverTime) || Math.abs(serverTime - now()) > 5_000)
    fail("EXECUTOR_CREDENTIAL_CLOCK_INVALID", 503);
  const orders = await signedGet(fetcher, host, "/api/v3/openOrders", apiKey, apiSecret, serverTime);
  if (!Array.isArray(orders)) fail("EXECUTOR_CREDENTIAL_ORDERS_INVALID", 503);
  if (orders.length) fail("EXECUTOR_CREDENTIAL_OPEN_ORDERS_PRESENT", 409);
}

export async function removeCredential(directory, scope) {
  assertCredentialScope(scope);
  return withAccountLock(directory, scope.exchange_account_id, async () => {
    const previous = await credentialMetadata(directory, scope);
    if (!previous) return { removed: false };
    await unlink(credentialPath(directory, scope.exchange_account_id));
    return { removed: true, fingerprint: previous.fingerprint };
  });
}
