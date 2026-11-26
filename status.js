(function () {
    'use strict';
    const input = document.getElementById('searchInput');
    const button = document.getElementById('queryButton');
    const result = document.getElementById('resultSection');
    const saved = document.getElementById('savedReceipts');
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
        row.append(node('span', label, 'info-label'), node('span', value, 'info-value'));
        parent.append(row);
    }
    function showMessage(text) {
        result.classList.add('show');
        result.replaceChildren(node('p', text, 'no-result'));
    }
    function render(entry) {
        if (!entry || !Object.hasOwn(statuses, entry.status)) throw new Error('invalid_response');
        const card = node('section', undefined, 'order-result');
        const heading = node('div', undefined, 'result-header');
        heading.append(node('span', entry.order_id || '投递回执 · 尚无正式编号', 'result-id'),
            node('span', statuses[entry.status], 'result-status'));
        card.append(heading);
        line(card, '类别', entry.pool);
        line(card, '服务器收件时间', time(entry.received_at));
        line(card, '服务器计价', Number.isFinite(entry.price) ? '¥' + entry.price : '待确认');
        if (entry.status === 'won' && Object.hasOwn(orderStatuses, entry.order_status)) {
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
            const copy = node('button', '复制正式编号', 'copy-btn');
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
        showMessage('正在查询这笔投递…');
        try {
            const entry = await rpc.lookup(token);
            if (input.value.trim() === token) render(entry);
            else showMessage('查询凭据已改变，请重新查询。');
        } catch (error) {
            showMessage(error.safeCode ? error.message : '查询暂时不可用，请稍后重试。');
        } finally { busy = false; button.disabled = false; }
    }
    button.addEventListener('click', search);
    input.addEventListener('keydown', event => { if (event.key === 'Enter') search(); });
    try {
        const records = rpc.receipts();
        for (const record of records) {
            const option = node('option', (record.pool || '投递') + ' · ' + time(record.receipt.received_at));
            option.value = record.token;
            saved.append(option);
        }
        saved.hidden = records.length === 0;
        saved.addEventListener('change', () => { input.value = saved.value; });
    } catch { saved.hidden = true; }
})();
