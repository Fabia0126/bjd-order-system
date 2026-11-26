const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto').webcrypto;
const { Client } = require('../bjd-rpc.js');

function fixture(rpc, overrides = {}) {
    const data = new Map();
    const storage = { getItem: key => data.get(key) ?? null, setItem: (key, value) => data.set(key, value) };
    const options = { storage, crypto, project: 'test-only', timeout: 50, ...overrides };
    return { client: new Client({ rpc }, options), options };
}
const payload = { campaign_id: 'fixture', size: '3fen', makeup: 'free', xianyu_id: '虚构单主' };
const receipt = { ok: true, entry_id: 'fixture-entry', status: 'received', price: 190 };

test('Missing secure hashing rejects locally without pretending to preserve a pending send', async () => {
    let count = 0;
    const f = fixture(async () => { count++; return { data: receipt }; }, { crypto: { getRandomValues: crypto.getRandomValues.bind(crypto) } });
    assert.equal(f.client.canPrepareSubmission(), false);
    await assert.rejects(f.client.submit('普', payload), { safeCode: 'secure_context_required' });
    assert.equal(count, 0);
    assert.equal(f.client.pending(), null);
});

test('Maintenance is reported clearly while the original request remains recoverable', async () => {
    let original;
    const f = fixture(async (_, params) => { original=structuredClone(params);return { error:{ message:'maintenance' } }; });
    await assert.rejects(f.client.submit('普',payload), { safeCode:'maintenance' });
    assert.equal(f.client.pending().requestId,original.p_request_id);
    const resumed=new Client({rpc:async(_,params)=>{
        assert.deepEqual(params,original);return {data:receipt};
    }},f.options);
    await resumed.recover();
    assert.equal(resumed.pending(),null);
});

test('ID, credential and payload exist durably before submission; confirmed journal drops contact payload', async () => {
    let f;
    f = fixture(async (name, params) => {
        assert.equal(name, 'submit_entry');
        const record = f.client.pending();
        assert.equal(record.requestId, params.p_request_id);
        assert.match(params.p_token, /^[A-Za-z0-9_-]{43}$/);
        assert.deepEqual(params.p_payload, { ...payload, contact1: 'fictional' });
        return { data: receipt };
    });
    const result = await f.client.submit('普', { ...payload, contact1: 'fictional' });
    assert.match(result.token, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(f.client.pending(), null);
    assert.equal(f.client.read()[0].payload, undefined);
    assert.equal(JSON.stringify(f.client.read()).includes('fictional'), false);
    assert.equal(f.client.receipts().length, 1);
});

test('Lost response, page reload and recovery reuse exactly the original request', async () => {
    let first;
    const f = fixture(async (_, params) => { first = structuredClone(params); throw new Error('offline'); });
    await assert.rejects(f.client.submit('普', payload), { safeCode: 'network_unknown' });
    const reopened = new Client({ rpc: async (_, params) => {
        assert.deepEqual(params, first);
        return { data: { ...receipt, replay: true } };
    } }, f.options);
    assert.equal((await reopened.recover()).replay, true);
});

test('Unknown result cannot silently become another payload or pool', async () => {
    let count = 0;
    const f = fixture(async () => { count++; throw new Error('offline'); });
    await assert.rejects(f.client.submit('普', payload));
    await assert.rejects(f.client.submit('钞', payload), { safeCode: 'pending_request' });
    await assert.rejects(f.client.submit('普', { ...payload, xianyu_id: '另一个' }), { safeCode: 'pending_request' });
    assert.equal(count, 1);
});

test('Double clicks share one network operation', async () => {
    let count = 0;
    const f = fixture(async () => {
        count++;
        await new Promise(resolve => setTimeout(resolve, 5));
        return { data: receipt };
    });
    const [first, second] = await Promise.all([f.client.submit('普', payload), f.client.submit('普', payload)]);
    assert.equal(count, 1);
    assert.equal(first.requestId, second.requestId);
});

test('An in-flight submission cannot masquerade as acceptance of a different pool', async () => {
    const f = fixture(async () => {
        await new Promise(resolve => setTimeout(resolve, 5));
        return { data: receipt };
    });
    const original = f.client.submit('普', payload);
    await assert.rejects(f.client.submit('钞', payload), { safeCode: 'pending_request' });
    await original;
});

test('Unavailable storage prevents submission entirely', async () => {
    let count = 0;
    const f = fixture(async () => { count++; }, { storage: {
        getItem: () => null, setItem: () => { throw new Error('full'); }
    } });
    await assert.rejects(f.client.submit('普', payload), { safeCode: 'storage_unavailable' });
    assert.equal(count, 0);
});

test('Lookup only sends a valid bearer credential, not a phone or interpolated filter', async () => {
    let count = 0;
    const f = fixture(async (name, params) => {
        count++;
        assert.equal(name, 'lookup_entry');
        assert.deepEqual(params, { p_token: 'a'.repeat(43) });
        return { data: { status: 'received' } };
    });
    await assert.rejects(f.client.lookup('phone-number'), { safeCode: 'invalid_token' });
    await f.client.lookup('a'.repeat(43));
    assert.equal(count, 1);
});

test('Deadline returns uncertainty and preserves recovery data; raw server data is not surfaced', async () => {
    const f = fixture(() => new Promise(() => {}), { timeout: 5 });
    await assert.rejects(f.client.submit('普', payload), { safeCode: 'network_unknown' });
    assert.equal(f.client.pending().payload.xianyu_id, payload.xianyu_id);
    const g = fixture(async () => ({ error: { message: 'sensitive-internal-field-value' } }));
    await assert.rejects(g.client.campaignStatus(), error => !error.message.includes('sensitive-internal'));
});

test('Definitive closed response is preserved as rejection, not success', async () => {
    const f = fixture(async () => ({ error: { message: 'closed' } }));
    await assert.rejects(f.client.submit('普', payload), { safeCode: 'closed' });
    assert.equal(f.client.receipts().length, 0);
    assert.equal(f.client.pending(), null);
});

test('Malformed success is treated as uncertain, never shown as accepted', async () => {
    const f = fixture(async () => ({ data: { ok: true } }));
    await assert.rejects(f.client.submit('普', payload), { safeCode: 'invalid_response' });
    assert.equal(f.client.receipts().length, 0);
    assert.ok(f.client.pending());
});
