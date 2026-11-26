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
            this.onOpen = options.onOpen || (() => {});
            this.wasAvailable = false;
            this.availableKey = null;
            this.refreshing = null;
            this.status = null;
            this.busy = false;
            this.serverBase = null;
            this.clockBase = 0;
            this.timer = null;
            this.confirmed = null;
            this.panel = element('section', undefined, 'form-section');
            this.panel.id = 'submissionReceipt';
            this.panel.classList.add('receipt-card');
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

        refresh() {
            if (this.refreshing) return this.refreshing;
            clearTimeout(this.poll);
            this.poll = null;
            this.refreshing = (async () => {
                const sent = performance.now();
                try {
                    const data = await this.site.rpc.campaignStatus();
                    const returned = performance.now();
                    const stamp = Date.parse(data.server_time);
                    if (!Number.isFinite(stamp) || typeof data.triple_open !== 'boolean') throw new Error();
                    this.status = data;
                    this.serverBase = stamp;
                    this.clockBase = (sent + returned) / 2;
                } catch { this.status = null; }
                this.updateAvailability();
            })().finally(() => { this.refreshing = null; this.schedulePoll(); });
            return this.refreshing;
        }

        pollInterval() {
            if (!this.status) return 3000;
            const campaign = this.status.campaign;
            if (!campaign || this.pool() === '三倍钞') return 5000;
            const now = this.serverBase + performance.now() - this.clockBase;
            const until = Date.parse(campaign.open_at) - now;
            if (until <= 10000 && now < Date.parse(campaign.close_at)) return 1000;
            return until > 0 && until <= 120000 ? 3000 : 5000;
        }

        schedulePoll() {
            if (!this.timer || this.refreshing || document.hidden) return;
            const delay = this.pollInterval();
            const due = performance.now() + delay;
            if (this.poll && due >= this.pollAt) return;
            clearTimeout(this.poll);
            this.pollAt = due;
            this.poll = setTimeout(() => { this.poll = null; this.refresh(); }, delay);
        }

        start() {
            if (this.timer) return;
            this.timer = setInterval(() => this.updateAvailability(), 50);
            this.refresh();
            document.addEventListener('visibilitychange', () => {
                if (!document.hidden) this.refresh();
                else { clearTimeout(this.poll); this.poll = null; }
            });
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
            let waitText = '';
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
                    if (now < start) {
                        waitText = Math.ceil((start - now) / 1000) + ' 秒';
                        message = '距离开放约 ' + waitText + '，可提前预览小纸条。';
                    }
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
            const available = open && !maintenance && environmentReady;
            const key = pool + ':' + (this.status?.campaign?.id || '');
            if (available && (!this.wasAvailable || this.availableKey !== key)) this.onOpen();
            this.wasAvailable = available;
            this.availableKey = key;
            button.disabled = !available || this.busy || !agreed;
            button.textContent = !environmentReady ? '请使用HTTPS链接投递'
                : (this.busy ? '正在提交…' : (maintenance ? '维护中，暂不收件'
                    : (waitText ? '确认投递 · ' + waitText + '后开放' : '确认投递')));
            for (const live of document.querySelectorAll('.preview-live-status')) live.textContent = message;
            this.schedulePoll();
            return { available };
        }

        async submitCurrent() {
            if (this.busy || !this.updateAvailability().available || !this.form.reportValidity()) return;
            let snapshot;
            try { snapshot = this.snapshot(); }
            catch (error) {
                this.panel.hidden = false;
                this.panel.replaceChildren(element('p', error.message));
                return;
            }
            await this.submit(snapshot);
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
                    this.markImagesBound(files.length);
                } else if (recover) {
                    this.imageNote.textContent = '原文字投递已恢复；如需补图，请在原收件起30分钟内选择参考图并点击补传。';
                } else {
                    this.imageNote.textContent = '本次未附参考图；如需补图，可在原收件起30分钟内补传。';
                }
                if (!recover) this.onComplete();
            } catch (error) {
                if (receipt) {
                    this.imageNote.textContent = '文字已收件，参考图尚未确认绑定。请保留此回执，在截止前重试补图。';
                } else {
                    this.panel.hidden = false;
                    this.panel.replaceChildren(element('h2', '投递状态'), element('p', error.safeCode ? error.message
                        : (snapshot ? '投递暂未确认，请使用恢复原投递，不要重新创建。' : error.message)));
                    try {
                        if (this.site.rpc.pending()) {
                            const resume = element('button', '恢复原投递');
                            resume.type = 'button';
                            resume.addEventListener('click', () => this.submit(null, true));
                            this.panel.append(resume);
                        }
                    } catch { /* The displayed error remains useful without storage. */ }
                }
            } finally { this.busy = false; this.updateAvailability(); }
        }

        showReceipt(receipt, restored = false) {
            this.confirmed = receipt;
            this.panel.hidden = false;
            this.panel.replaceChildren();
            const demo = BJDReceiptUI.isDemo(receipt);
            const header = element('div', undefined, 'receipt-header');
            const heading = element('div', undefined, 'receipt-heading');
            heading.append(element('p', '投递回执', 'receipt-eyebrow'),
                element('h2', demo ? '演练投递回执' : (restored ? '本机保存的回执' : '小纸条已收到'), 'receipt-title'),
                element('p', restored ? '这是本机保存的记录，最新进度请前往查询页。' : '请先保存查询凭据，再离开这个页面。', 'receipt-subtitle'));
            header.append(heading, BJDReceiptUI.badges(receipt));
            const states = { received: '收件成功不等于中签，请等待开奖。', reviewing: '小纸条已收到，等待阿发审核。',
                won: '已中签或审核通过，可在查询页查看正式编号与进度。', not_selected: '本次未中签。', rejected: '本次未通过审核。' };
            this.panel.append(header, element('p', demo ? '这是演练记录，不参与正式开单，不生成BJD正式编号。' : (states[receipt.status] || '请前往查询页查看进度。'), 'receipt-explanation'));
            const price = element('div', undefined, 'receipt-summary');
            price.append(element('span', '本次计价'), element('strong', Number.isFinite(receipt.price) ? '¥' + receipt.price : '待确认'));
            this.panel.append(price);

            const credential = element('div', undefined, 'credential-box');
            const label = element('label', '本人查询凭据', 'credential-label');
            const token = element('textarea', undefined, 'credential-code');
            token.readOnly = true; token.value = receipt.token; token.rows = 3; token.spellcheck = false;
            token.setAttribute('aria-label', '本人查询凭据'); token.setAttribute('autocapitalize', 'none');
            label.append(token);
            const copy = element('button', '复制凭据', 'receipt-button receipt-button-primary credential-copy'); copy.type = 'button';
            const feedback = element('p', '', 'copy-feedback'); feedback.setAttribute('role', 'status');
            copy.addEventListener('click', async () => {
                try { await navigator.clipboard.writeText(receipt.token); feedback.textContent = '已复制，请保存到仅本人可见的地方。'; }
                catch { token.focus(); token.select(); feedback.textContent = '请长按凭据，复制或截图保存。'; }
            });
            credential.append(label, element('p', '这是查询订单的唯一凭据，请立即截图或复制保存。丢失无法找回，手机号不能查单。', 'credential-warning'), copy, feedback);
            const actions = element('div', undefined, 'receipt-actions');
            const link = element('a', '查看订单进度', 'receipt-button receipt-button-secondary'); link.href = 'status.html'; actions.append(link);
            this.panel.append(credential, actions);

            const uploads = element('section', undefined, 'upload-section');
            uploads.append(element('h3', '补传参考图'), element('p', '最多6张 · 单张5MB以内 · JPEG / PNG / WebP；收件后30分钟内可补传，绑定后不可更换。', 'upload-help'));
            const images = element('input'); images.type = 'file'; images.multiple = true; images.hidden = true;
            images.accept = 'image/jpeg,image/png,image/webp'; images.setAttribute('aria-label', '选择待补传参考图');
            const selection = element('p', '尚未选择参考图', 'upload-selection');
            const choose = element('button', '选择参考图', 'receipt-button receipt-button-secondary'); choose.type = 'button';
            choose.addEventListener('click', () => images.click());
            images.addEventListener('change', () => { selection.textContent = images.files.length ? '已选择 ' + images.files.length + ' 张，确认后点击补传。' : '尚未选择参考图'; });
            const supplement = element('button', '补传参考图', 'receipt-button receipt-button-primary'); supplement.type = 'button';
            this.imageNote = element('p', restored ? '绑定状态以最近一次成功回执为准。' : '正在核对参考图…', 'upload-status');
            this.imageNote.setAttribute('role', 'status');
            this.imageChoose = choose; this.imageSend = supplement; this.imageSelection = selection; this.imagesBound = false;
            supplement.addEventListener('click', async () => {
                if (this.busy || this.imagesBound) return;
                this.busy = true; supplement.disabled = true; choose.disabled = true; supplement.textContent = '正在补传…';
                try {
                    const files = Array.from(images.files);
                    if (!files.length) { this.imageNote.textContent = '请先选择参考图。'; return; }
                    this.validateImages(files);
                    await this.uploadImages(receipt, files);
                    this.markImagesBound(files.length);
                } catch (error) { this.imageNote.textContent = error.safeCode ? error.message : '补图未确认，请保留原图与回执，稍后重试。'; }
                finally {
                    this.busy = false; supplement.disabled = this.imagesBound; choose.disabled = this.imagesBound;
                    supplement.textContent = this.imagesBound ? '已完成绑定' : '补传参考图'; this.updateAvailability();
                }
            });
            const controls = element('div', undefined, 'upload-controls'); controls.append(choose, supplement);
            uploads.append(selection, controls, this.imageNote, images); this.panel.append(uploads);
            try {
                const manifest = JSON.parse(localStorage.getItem('bjd.image-manifest.v1.' + this.site.project + '.' + receipt.requestId) || 'null');
                if (manifest?.attached && Array.isArray(manifest.paths)) this.markImagesBound(manifest.paths.length);
            } catch { /* No verified local image count is available. */ }
        }

        markImagesBound(count) {
            this.imagesBound = true;
            this.imageNote.textContent = '参考图已绑定 ' + count + ' 张。';
            this.imageNote.classList.add('is-bound');
            this.imageSelection.textContent = '参考图已保存，无需重复上传。';
            this.imageChoose.disabled = true; this.imageSend.disabled = true; this.imageSend.textContent = '已完成绑定';
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
