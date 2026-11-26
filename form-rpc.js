(function () {
    'use strict';
    function element(tag, text, className) {
        const node = document.createElement(tag);
        if (text !== undefined) node.textContent = String(text ?? '');
        if (className) node.className = className;
        return node;
    }

    class Controller {
        constructor(site, options) {
            this.site = site;
            this.form = options.form;
            this.getSavedImages = options.getSavedImages;
            this.onComplete = options.onComplete;
            this.status = null;
            this.busy = false;
            this.serverBase = null;
            this.clockBase = 0;
            this.timer = null;
            this.confirmed = null;
            this.panel = element('section', undefined, 'form-section');
            this.panel.id = 'submissionReceipt';
            this.panel.hidden = true;
            this.form.after(this.panel);
        }

        pool() {
            return ({ normal: '普', chao: '钞', chao3x: '三倍钞' })[
                this.form.querySelector('[name="orderType"]:checked')?.value
            ];
        }

        snapshot() {
            const form = new FormData(this.form);
            const pool = this.pool();
            if (!pool) throw new Error('请先选择投递类别。');
            const payload = {
                size: form.get('size'), makeup: form.get('makeupType'),
                addons: form.getAll('addon'), koupei_qty: Number(form.get('koupeiQty') || 1),
                taboos: ['taboo1', 'taboo2', 'taboo3'].map(key => form.get(key)).filter(Boolean),
                requirements: ['requirement1', 'requirement2', 'requirement3'].map(key => form.get(key)).filter(Boolean),
                free_items: form.getAll('freeItem')
            };
            const fields = {
                dollInfo: 'doll_info', attribute: 'attribute', gender: 'gender', colorScheme: 'color_scheme',
                glitter: 'glitter', accessories: 'accessories', xianyuId: 'xianyu_id',
                receiverName: 'receiver_name', contact1: 'contact1', contact2: 'contact2', shipping: 'shipping'
            };
            for (const [field, name] of Object.entries(fields)) payload[name] = String(form.get(field) || '');
            if (payload.makeup === 'free') payload.color_scheme = '自由发挥';
            if (pool !== '三倍钞') {
                if (!this.status?.campaign?.id) throw new Error('暂未取得本次活动信息，请刷新状态后再试。');
                payload.campaign_id = this.status.campaign.id;
            }
            return { pool, payload };
        }

        async refresh() {
            try {
                const data = await this.site.rpc.campaignStatus();
                const stamp = Date.parse(data.server_time);
                if (!Number.isFinite(stamp) || typeof data.triple_open !== 'boolean') throw new Error();
                this.status = data;
                this.serverBase = stamp;
                this.clockBase = performance.now();
            } catch { this.status = null; }
            this.updateAvailability();
        }

        start() {
            if (this.timer) return;
            this.refresh();
            this.timer = setInterval(() => this.updateAvailability(), 100);
            this.poll = setInterval(() => { if (!document.hidden) this.refresh(); }, 15000);
            document.addEventListener('visibilitychange', () => { if (!document.hidden) this.refresh(); });
            try {
                const pending = this.site.rpc.pending();
                if (pending) {
                    this.panel.hidden = false;
                    this.panel.append(element('p', '上一笔投递尚未取得回执。请恢复原投递，不要重新创建。'));
                    const resume = element('button', '恢复原投递');
                    resume.type = 'button';
                    resume.addEventListener('click', () => this.submit(null, true));
                    this.panel.append(resume);
                } else {
                    const records = this.site.rpc.receipts();
                    const last = records.at(-1);
                    if (last) this.showReceipt({ ...last.receipt, token: last.token, requestId: last.requestId }, true);
                }
            } catch { /* Submission itself fails closed if durable storage is unavailable. */ }
        }

        updateAvailability() {
            const button = document.getElementById('submitBtn');
            const note = document.getElementById('normalStatus');
            const countdown = document.getElementById('countdownDisplay');
            const text = document.getElementById('countdownText');
            let open = false;
            let showCountdown = false;
            let message = '正在核对活动状态，可先填写资料。';
            const pool = this.pool();
            if (this.status && pool === '三倍钞') {
                open = this.status.triple_open;
                message = open ? '三倍钞独立审核，不参加抽奖。' : '三倍钞当前暂停接单。';
            } else if (this.status?.campaign) {
                const campaign = this.status.campaign;
                const now = this.serverBase + performance.now() - this.clockBase;
                const start = Date.parse(campaign.open_at);
                const end = Date.parse(campaign.close_at);
                if (Number.isFinite(start) && Number.isFinite(end) && end > start) {
                    showCountdown = true;
                    open = now >= start && now < end;
                    if (now < start) message = '距离开放约 ' + Math.ceil((start - now) / 1000) + ' 秒，可提前核对预览。';
                    else if (open) message = '正在收件，还剩约 ' + ((end - now) / 1000).toFixed(1) + ' 秒；以服务器收件为准。';
                    else message = '本次收件已结束，已投递者请凭查询凭据查看进度。';
                }
            } else if (!this.status) message = '活动状态暂不可用，可先填写资料，稍后再试。';
            if (pool !== '三倍钞' && this.status?.campaign?.demo === true) message = '【演练批次，不参与正式开单】' + message;
            const environmentReady = this.site.rpc.canPrepareSubmission();
            const maintenance = this.status?.maintenance === true;
            if (maintenance) message = BJDRpc.ERROR_TEXT.maintenance;
            if (!environmentReady) message = BJDRpc.ERROR_TEXT.secure_context_required;
            if (note) { note.textContent = message; note.classList.add('show'); }
            if (text) text.textContent = message;
            if (countdown) countdown.style.display = showCountdown ? 'block' : 'none';
            const agreed = document.getElementById('agreeNotice').checked;
            // Preview may be prepared before opening. Only its confirm action
            // submits; the database, not the local countdown, decides admission.
            button.disabled = maintenance || !environmentReady || this.busy || !agreed || !this.status || (!this.status.campaign && pool !== '三倍钞');
            button.textContent = !environmentReady ? '请使用HTTPS链接投递'
                : (maintenance ? '维护中，暂不收件' : (this.busy ? '正在提交…' : (open ? '核对并投递小纸条' : '提前核对小纸条')));
            const confirm = document.querySelector('.btn-confirm');
            if (confirm) {
                let pending = false;
                try { pending = !!this.site.rpc.pending(); } catch { /* RPC saves before sending. */ }
                confirm.disabled = maintenance || !environmentReady || this.busy || (!open && !pending);
                confirm.textContent = !environmentReady ? '请使用HTTPS链接投递'
                    : (maintenance ? '维护中，暂不收件' : (this.busy ? '正在提交…' : (open || pending ? '确认投递' : '等待开放／本次已结束')));
            }
        }

        imageFiles() {
            const input = this.form.querySelector('[name="referenceImages"]');
            if (input?.files?.length) return Array.from(input.files);
            return this.getSavedImages().map(image => {
                const data = BJDSecurity.safePreviewDataURL(image.data);
                if (!data) throw new Error('参考图格式无效，请重新选择。');
                const [header, body] = data.split(',');
                const bytes = Uint8Array.from(atob(body), char => char.charCodeAt(0));
                return new File([bytes], image.name || 'reference.jpg', { type: header.slice(5).split(';')[0] });
            });
        }

        validateImages(files) {
            if (files.length > 6) throw new Error('每笔最多6张参考图，请减少后再投递。');
            for (const file of files) {
                if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type) || file.size > 5242880 || !file.size) {
                    throw new Error('参考图须为JPEG、PNG或WebP，每张不超过5MB。');
                }
            }
        }

        async submit(snapshot, recover = false) {
            if (this.busy) return;
            this.busy = true;
            this.updateAvailability();
            let receipt;
            try {
                // Text admission always precedes decoding/hash/upload work.
                const input = this.form.querySelector('[name="referenceImages"]');
                let files = recover ? [] : (input?.files?.length ? Array.from(input.files) : null);
                if (files) this.validateImages(files);
                else if (this.getSavedImages().length > 6) throw new Error('每笔最多6张参考图。');
                receipt = recover ? await this.site.rpc.recover()
                    : await this.site.rpc.submit(snapshot.pool, snapshot.payload);
                if (!receipt) throw new Error('当前没有需要恢复的投递。');
                this.confirmed = receipt;
                this.showReceipt(receipt);
                if (files === null) files = this.imageFiles();
                this.validateImages(files);
                if (files.length) {
                    await this.uploadImages(receipt, files);
                    this.imageNote.textContent = '参考图已绑定。';
                } else if (recover) {
                    this.imageNote.textContent = '原文字投递已恢复；如需补图，请在原收件起30分钟内选择参考图并点击补传。';
                } else {
                    this.imageNote.textContent = '本次未附参考图；如需补图，可在原收件起30分钟内补传。';
                }
                if (!recover) this.onComplete();
            } catch (error) {
                if (receipt) {
                    this.imageNote.textContent = '文字已收件，参考图尚未确认绑定。请保留此回执，在截止前重试补图。';
                } else alert(error.safeCode ? error.message : (snapshot ? '投递暂未确认，请使用恢复原投递，不要重新创建。' : error.message));
            } finally { this.busy = false; this.updateAvailability(); }
        }

        showReceipt(receipt, restored = false) {
            this.confirmed = receipt;
            this.panel.hidden = false;
            const demo = receipt.demo === true || String(receipt.order_id || '').startsWith('DEMO-');
            this.panel.replaceChildren(element('h2', demo ? '演练投递回执 · 非正式订单' : (restored ? '本设备保存的最近回执' : '服务器已收件')));
            const states = { received: '已收到投递，请等待开奖。收件成功不等于中签。',
                reviewing: '三倍钞等待审核；暂未生成正式编号。', won: '原投递已中签／审核通过，请到查询页查看正式编号。',
                not_selected: '本次未中签。', rejected: '本次未通过审核。' };
            this.panel.append(element('p', demo ? '这是演练记录，不参与正式开单，不生成BJD正式编号。' : (states[receipt.status] || '请到查询页查看最新进度。')));
            this.panel.append(element('p', '服务器计价：¥' + receipt.price));
            const token = element('input');
            token.readOnly = true; token.value = receipt.token; token.setAttribute('aria-label', '本人查询凭据');
            token.style.cssText = 'width:100%;font-family:monospace;';
            const copy = element('button', '复制并保存查询凭据');
            copy.type = 'button';
            copy.addEventListener('click', async () => {
                try { await navigator.clipboard.writeText(receipt.token); copy.textContent = '已复制，请仅本人保存'; }
                catch { token.focus(); token.select(); copy.textContent = '请长按凭据复制保存'; }
            });
            const link = element('a', '凭查询凭据查看进度'); link.href = 'status.html';
            this.imageNote = element('p', restored ? '这是本机保存的收件回执，最新进度请前往查询页。' : '正在处理参考图…');
            const images = element('input'); images.type = 'file'; images.multiple = true;
            images.accept = 'image/jpeg,image/png,image/webp'; images.setAttribute('aria-label', '选择待补传参考图');
            const supplement = element('button', '补传参考图'); supplement.type = 'button';
            supplement.addEventListener('click', async () => {
                if (this.busy) return;
                this.busy = true; supplement.disabled = true;
                try {
                    const files = Array.from(images.files);
                    if (!files.length) throw new Error('请先选择参考图。');
                    this.validateImages(files);
                    await this.uploadImages(receipt, files);
                    this.imageNote.textContent = '参考图已绑定。';
                } catch (error) { this.imageNote.textContent = error.safeCode ? error.message : '补图未确认，请保留原文件与回执后重试。'; }
                finally { this.busy = false; supplement.disabled = false; this.updateAvailability(); }
            });
            this.panel.append(token, copy, element('p', '凭据仅供本人保存，不放进公开名单。'), link, this.imageNote, images, supplement);
        }

        async uploadImages(receipt, files) {
            const key = 'bjd.image-manifest.v1.' + this.site.project + '.' + receipt.requestId;
            const hashes = [];
            for (const file of files) {
                const digest = await crypto.subtle.digest('SHA-256', await file.arrayBuffer());
                hashes.push(Array.from(new Uint8Array(digest), v => v.toString(16).padStart(2, '0')).join('') + ':' + file.type);
            }
            let manifest = JSON.parse(localStorage.getItem(key) || 'null');
            if (manifest && manifest.protocol !== 'fixed-slots-v1') throw new Error('这笔补图使用旧版授权，请保留查询凭据联系阿发核验，不要重复上传。');
            if (manifest && JSON.stringify(manifest.hashes) !== JSON.stringify(hashes)) throw new Error('请使用原来的参考图和顺序重试，不能覆盖已上传的清单。');
            if (!manifest) {
                const ticket = await this.site.rpc.rpc('request_upload', { p_token: receipt.token });
                const slots = BJDSecurity.uploadSlots(ticket, receipt.entry_id);
                const paths = slots.slice(0, files.length);
                manifest = { protocol: 'fixed-slots-v1', hashes, slots, paths, uploaded: [], attached: false };
                localStorage.setItem(key, JSON.stringify(manifest));
            }
            const slots = BJDSecurity.uploadSlots({ bucket: 'reference-images', slots: manifest.slots }, receipt.entry_id);
            if (manifest.paths.length !== files.length || manifest.paths.some((path, index) => path !== slots[index])) {
                throw new Error('补图恢复清单与原槽位不一致，请保留回执核验。');
            }
            if (manifest.attached) return;
            for (let i = 0; i < files.length; i++) {
                if (manifest.uploaded.includes(i)) continue;
                let timer;
                let outcome;
                try {
                    outcome = await Promise.race([
                        this.site.client.storage.from('reference-images').upload(manifest.paths[i], files[i], { upsert: false, contentType: files[i].type }),
                        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('上传尚未确认。')), 20000); })
                    ]);
                } finally { clearTimeout(timer); }
                // A fixed slot may have been filled by another device holding
                // the same credential. A conflict alone does not prove that
                // this file was stored, so never bind it as a fresh success.
                if (outcome.error) throw new Error('上传尚未确认；若槽位已占用，请保留原图和回执核验。');
                manifest.uploaded.push(i);
                localStorage.setItem(key, JSON.stringify(manifest));
            }
            const bound = await this.site.rpc.rpc('attach_images', { p_token: receipt.token, p_paths: manifest.paths });
            if (bound.ok !== true || bound.images !== manifest.paths.length) throw new Error('绑定尚未确认。');
            manifest.attached = true;
            localStorage.setItem(key, JSON.stringify(manifest));
        }
    }
    window.BJDForm = Object.freeze({ Controller });
})();
