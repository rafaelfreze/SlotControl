import test from 'node:test';
import assert from 'node:assert/strict';
import { resumeOfficialEngine } from './resume-engine-official.mjs';

const ids = ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222',
  'BTC', '33333333-3333-4333-8333-333333333333'];
const fixtureKey = 'offline-fixture-'.repeat(3);
test('official recovery sends only exact account/engine RESUME, never order parameters or arbitrary URLs', async () => {
  const result = await resumeOfficialEngine(ids, fixtureKey, async (url, request) => {
    assert.equal(url, 'https://cripto-flax.vercel.app/api/cron/live-control');
    assert.deepEqual(JSON.parse(request.body), { action: 'RESUME', asset: 'BTC',
      exchange_account_id: ids[0], trading_engine_id: ids[1] });
    assert.equal(request.redirect, 'error');
    return { ok: true, json: async () => ({ status: 'RESUMED', cycle_id: ids[3] }) };
  });
  assert.equal(result.engine_id, ids[1]);
  assert.equal(JSON.stringify(result).includes(fixtureKey), false);
});
test('unknown outcome is never retried and a different run is not success', async () => {
  let calls = 0;
  await assert.rejects(resumeOfficialEngine(ids, fixtureKey, async () => {
    calls++; return { ok: true, json: async () => ({ status: 'RESUMED', cycle_id: ids[0] }) };
  }), /RESPONSE_UNCONFIRMED/);
  assert.equal(calls, 1);
  await assert.rejects(resumeOfficialEngine(ids, fixtureKey, async () => { throw new TypeError('network'); }));
});
test('invalid scope/asset/secret fails before any transmission', async () => {
  const denied = async () => assert.fail('must not dispatch');
  await assert.rejects(resumeOfficialEngine([...ids.slice(0, 2), 'ETH', ids[3]], fixtureKey, denied));
  await assert.rejects(resumeOfficialEngine(ids, fixtureKey + '\n', denied));
  await assert.rejects(resumeOfficialEngine(ids.slice(1), fixtureKey, denied));
});
