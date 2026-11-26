(function (root, factory) {
    'use strict';
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    else root.BJDRpc = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';
    const ERROR_TEXT = Object.freeze({
        not_open: '本次投递还未开放，可以先准备好小纸条。',
        closed: '本次投递或补图时间已经结束。',
        invalid_pool: '投递类别无效，请重新选择。',
        invalid_payload: '填写内容未通过校验，请检查后再试。',
        conflict: '这次投递与原请求不一致，请先恢复原投递，不要重复创建。',
        invalid_token: '查询凭据无效，请检查是否完整复制。',
        storage_unavailable: '无法保存投递恢复信息，请允许此网站存储后再提交。',
        secure_context_required: '当前页面无法安全投递，请使用有效的HTTPS链接和新版浏览器。本次尚未发送。',
        pending_request: '上一笔投递结果尚未确认，请先恢复原投递。',
        network_unknown: '暂未拿到服务器回执。恢复凭据已保留，请重试原投递，不要另建一笔。',
        invalid_response: '服务器回执暂时无法识别，请保留查询凭据并恢复原投递。',
        too_many: '图片或上传凭证数量已达到本次限制，请先检查原补图记录。',
        invalid_state: '当前投递状态不允许此操作，请重新查询进度。',
        forbidden: '当前账号没有此操作权限。',
        maintenance: '网站维护中，暂不收件。请保留原投递和查询凭据，稍后恢复原投递。'
    });
    const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
    const UUID_RE = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;

    function failure(code) {
        const error = new Error(ERROR_TEXT[code] || ERROR_TEXT.network_unknown);
        error.safeCode = code;
        return error;
    }

    function canonical(value) {
        if (value === null || typeof value !== 'object') return JSON.stringify(value);
        if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
        return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
    }

    function randomToken(crypto) {
        const bytes = crypto.getRandomValues(new Uint8Array(32));
        return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    }

    function uuid(crypto) {
        const a = crypto.getRandomValues(new Uint8Array(16));
        a[6] = (a[6] & 15) | 64;
        a[8] = (a[8] & 63) | 128;
        const text = Array.from(a, v => v.toString(16).padStart(2, '0')).join('');
        return text.slice(0, 8) + '-' + text.slice(8, 12) + '-' + text.slice(12, 16) + '-'
            + text.slice(16, 20) + '-' + text.slice(20);
    }

    class Client {
        constructor(client, options) {
            this.client = client;
            this.storage = options.storage;
            this.crypto = options.crypto;
            this.key = 'bjd.submissions.v1.' + options.project;
            this.timeout = options.timeout ?? 20000;
            this.inFlight = null;
            this.inFlightKey = null;
        }

        read() {
            let value;
            try { value = JSON.parse(this.storage.getItem(this.key) || '[]'); }
            catch { throw failure('storage_unavailable'); }
            if (!Array.isArray(value)) throw failure('storage_unavailable');
            if (value.some(item => !item || !TOKEN_RE.test(item.token) || !UUID_RE.test(item.requestId))) {
                throw failure('storage_unavailable');
            }
            return value;
        }

        write(records) {
            try {
                const text = JSON.stringify(records);
                this.storage.setItem(this.key, text);
                if (this.storage.getItem(this.key) !== text) throw new Error();
            } catch { throw failure('storage_unavailable'); }
        }

        save(record) {
            const records = this.read();
            const index = records.findIndex(item => item.requestId === record.requestId);
            if (index < 0) records.push(record);
            else records[index] = record;
            this.write(records);
        }

        pending() {
            return this.read().find(item => ['submitting', 'unknown'].includes(item.state)) || null;
        }

        receipts() {
            return this.read().filter(item => item.receipt).map(item => ({
                requestId: item.requestId, token: item.token, pool: item.pool, receipt: item.receipt
            }));
        }

        canPrepareSubmission() {
            return (typeof isSecureContext !== 'boolean' || isSecureContext)
                && typeof this.crypto?.getRandomValues === 'function'
                && typeof this.crypto?.subtle?.digest === 'function';
        }

        async rpc(name, parameters = {}) {
            let timer;
            try {
                const result = await Promise.race([
                    this.client.rpc(name, parameters),
                    new Promise((_, reject) => {
                        timer = setTimeout(() => reject(failure('network_unknown')), this.timeout);
                    })
                ]);
                if (result.error) {
                    const message = String(result.error.message || '');
                    // Raw server errors may contain user data or request details.
                    throw failure(Object.hasOwn(ERROR_TEXT, message) ? message : 'network_unknown');
                }
                if (!result.data || typeof result.data !== 'object') throw failure('invalid_response');
                return result.data;
            } catch (error) {
                throw error.safeCode ? error : failure('network_unknown');
            } finally { clearTimeout(timer); }
        }

        campaignStatus() { return this.rpc('campaign_status'); }

        lookup(token) {
            const value = String(token || '').trim();
            if (!TOKEN_RE.test(value)) return Promise.reject(failure('invalid_token'));
            return this.rpc('lookup_entry', { p_token: value });
        }

        submit(pool, payload) {
            const key = canonical({ pool, payload });
            if (this.inFlight) return key === this.inFlightKey
                ? this.inFlight : Promise.reject(failure('pending_request'));
            this.inFlightKey = key;
            this.inFlight = this.performSubmit(pool, payload).finally(() => {
                this.inFlight = null;
                this.inFlightKey = null;
            });
            return this.inFlight;
        }

        async performSubmit(pool, payload) {
            if (!this.canPrepareSubmission()) throw failure('secure_context_required');
            const digest = await this.crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical({ pool, payload })));
            const fingerprint = Array.from(new Uint8Array(digest), v => v.toString(16).padStart(2, '0')).join('');
            const pending = this.pending();
            if (pending && pending.fingerprint !== fingerprint) throw failure('pending_request');
            const record = pending || {
                requestId: uuid(this.crypto), token: randomToken(this.crypto),
                pool, payload: JSON.parse(JSON.stringify(payload)), fingerprint, state: 'submitting'
            };
            record.state = 'submitting';
            // Persist before the first network call. A lost response or reload
            // must not invent a new ID, token or payload.
            this.save(record);
            try {
                const result = await this.rpc('submit_entry', {
                    p_request_id: record.requestId, p_token: record.token,
                    p_pool: record.pool, p_payload: record.payload
                });
                if (result.ok !== true || typeof result.entry_id !== 'string'
                    || !['received', 'reviewing', 'won', 'not_selected', 'rejected'].includes(result.status)) {
                    throw failure('invalid_response');
                }
                record.receipt = result;
                record.state = 'confirmed';
                // Full contact information is only needed for uncertain retries.
                delete record.payload;
                this.save(record);
                return { ...result, token: record.token, requestId: record.requestId };
            } catch (error) {
                record.state = ['not_open', 'closed', 'invalid_pool', 'invalid_payload', 'invalid_token'].includes(error.safeCode)
                    ? 'rejected' : 'unknown';
                if (record.state === 'rejected') delete record.payload;
                this.save(record);
                throw error;
            }
        }

        async recover() {
            const record = this.pending();
            if (!record) return null;
            return this.submit(record.pool, record.payload);
        }
    }

    return Object.freeze({ Client, canonical, ERROR_TEXT, TOKEN_RE });
});
