(function () {
    'use strict';
    const input = document.getElementById('searchInput');
    const button = document.getElementById('queryButton');
    const result = document.getElementById('resultSection');
    const saved = document.getElementById('savedReceipts');
    const localSection = document.getElementById('localReceipts');
    const rpc = window.bjdSite.rpc;
    const statuses = Object.freeze({
        received: '已收件，等待开奖', reviewing: '三倍钞审核中', won: '已中签／审核通过',
        not_selected: '本次未中签', rejected: '未通过审核'
    });
    const orderStatuses = Object.freeze({
        pending: '待审核', approved: '等待中', working: '正在施工',
        packing: '已确认待打包', completed: '订单完成', rejected: '已拒绝'
    });
    let busy = false;

    function node(tag, text, className) {
        const element = document.createElement(tag);
        if (text !== undefined) element.textContent = String(text ?? '');
        if (className) element.className = className;
        return element;
    }
    function time(value) {
        const date = new Date(value);
        return Number.isFinite(date.getTime()) ? date.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }) : '—';
    }
    function line(parent, label, value) {
        const row = node('div', undefined, 'info-row');
        row.append(node('span', label, 'info-label'), node('span', value === null || value === undefined || value === '' ? '—' : value, 'info-value'));
        parent.append(row);
    }
    function showMessage(text) {
        result.classList.add('show');
        result.replaceChildren(node('p', text, 'no-result'));
    }
    function render(entry) {
        if (!entry || !Object.hasOwn(statuses, entry.status)) throw new Error('invalid_response');
        const demo = entry.demo === true || String(entry.order_id || '').startsWith('DEMO-');
        const card = node('section', undefined, 'order-result');
        const heading = node('div', undefined, 'result-header');
        heading.append(node('span', entry.order_id || (demo ? '演练回执 · 非正式订单' : '投递回执 · 尚无正式编号'), 'result-id'),
            BJDReceiptUI.badges(entry));
        heading.lastChild.classList.add('result-status');
        card.append(heading);
        if (demo) card.append(node('p', '这是演练记录，不参与正式开单，不生成BJD正式编号。'));
        line(card, '类别', entry.pool);
        line(card, '批次', entry.campaign_id || (entry.pool === '三倍钞' ? '独立审核' : '待确认'));
        line(card, '收件时间', time(entry.received_at));
        line(card, '计价金额', Number.isFinite(entry.price) ? '¥' + entry.price : '待确认');
        if (!demo && entry.status === 'won' && Object.hasOwn(orderStatuses, entry.order_status)) {
            line(card, '订单进度', orderStatuses[entry.order_status]);
        }
        const p = entry.payload;
        if (p && typeof p === 'object' && !Array.isArray(p)) {
            line(card, '闲鱼 ID', p.xianyu_id);
            line(card, '娃头信息', p.doll_info);
            line(card, '尺寸', p.size_label || ({ '3fen': '三分', '4fen': '四分' })[p.size] || '');
            line(card, '妆面', ({ free: '全自由妆', specified: '指定妆', cos: 'COS妆' })[p.makeup] || '');
        }
        if (entry.status === 'received') card.append(node('p', '收件成功不等于中签，请等待开奖。'));
        if (entry.status === 'not_selected') card.append(node('p', '本次未中签；资料保留情况以活动公告和实际清理状态为准。'));
        if (entry.status === 'won' && entry.order_id) {
            const copy = node('button', demo ? '复制演练编号' : '复制正式编号', 'copy-btn');
            copy.type = 'button';
            copy.addEventListener('click', async () => {
                try { await navigator.clipboard.writeText(String(entry.order_id)); copy.textContent = '已复制'; }
                catch { copy.textContent = '复制未成功，请选中编号复制'; }
            });
            card.append(copy);
        }
        card.append(node('p', '需要修改资料或查询旧订单，请联系阿发核验处理。', 'search-hint'));
        result.classList.add('show');
        result.replaceChildren(card);
    }
    async function search() {
        if (busy) return;
        const token = input.value.trim();
        if (!BJDRpc.TOKEN_RE.test(token)) {
            showMessage('请粘贴完整的43位查询凭据；闲鱼ID、手机号和正式编号不能代替查询凭据。');
            return;
        }
        busy = true;
        button.disabled = true;
        button.textContent = '正在查询…';
        saved.querySelectorAll('button').forEach(b => { b.disabled = true; });
        showMessage('正在查询这笔投递…');
        try {
            const entry = await rpc.lookup(token);
            if (input.value.trim() === token) {
                render(entry);
                try { rpc.rememberLookup(token, entry); renderSaved(token); } catch { /* Query results remain visible if local storage is unavailable. */ }
            }
            else showMessage('查询凭据已改变，请重新查询。');
        } catch (error) {
            showMessage(error.safeCode ? error.message : '查询暂时不可用，请稍后重试。');
        } finally {
            busy = false; button.disabled = false; button.textContent = '查询订单';
            saved.querySelectorAll('button').forEach(b => { b.disabled = false; });
        }
    }
    button.addEventListener('click', search);
    input.addEventListener('keydown', event => { if (event.key === 'Enter') search(); });
    function renderSaved(selectedToken) {
        saved.replaceChildren();
        const records = rpc.receipts();
        for (const record of [...records].reverse()) {
            const item = node('button', undefined, 'record-item'); item.type = 'button'; item.disabled = busy;
            const selected = record.token === selectedToken;
            item.classList.toggle('is-selected', selected); item.setAttribute('aria-pressed', String(selected));
            const top = node('span', undefined, 'record-top');
            top.append(node('span', (record.campaignId || (record.pool === '三倍钞' ? '独立审核' : '批次待查询')) + ' · ' + (record.pool || '投递'), 'record-name'),
                BJDReceiptUI.badges(record.receipt));
            item.append(top, node('span', time(record.receipt.received_at) + ' 收件', 'record-time'));
            item.addEventListener('click', () => { if (!busy) { input.value = record.token; search(); } });
            saved.append(item);
        }
        localSection.hidden = records.length === 0;
    }
    try { renderSaved(); } catch { localSection.hidden = true; }
})();
