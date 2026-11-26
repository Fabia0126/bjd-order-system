(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    else root.BJDReceiptUI = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';
    const orderStates = Object.freeze({
        pending: ['待审核', 'pending'], approved: ['等待中', 'approved'],
        working: ['正在施工', 'working'], packing: ['已确认待打包', 'packing'],
        completed: ['已完成', 'completed'], rejected: ['已拒绝', 'rejected']
    });
    function isDemo(entry) { return entry.demo === true || String(entry.order_id || '').startsWith('DEMO-'); }
    function state(entry) {
        let value;
        if (entry.status === 'won') value = Object.hasOwn(orderStates, entry.order_status) ? orderStates[entry.order_status] : orderStates.approved;
        else {
            const states = { received: ['已收件待开奖', 'received'], reviewing: ['待审核', 'pending'],
                not_selected: ['未中签', 'rejected'], rejected: ['已拒绝', 'rejected'] };
            value = Object.hasOwn(states, entry.status) ? states[entry.status] : ['状态待查询', 'received'];
        }
        return { label: value[0], tone: value[1] };
    }
    function badges(entry) {
        const group = document.createElement('span'); group.className = 'badge-group';
        const info = state(entry), badge = document.createElement('span');
        badge.className = 'status-badge status-' + info.tone; badge.textContent = info.label;
        group.append(badge);
        if (isDemo(entry)) {
            const demo = document.createElement('span'); demo.className = 'demo-badge'; demo.textContent = '演练'; group.append(demo);
        }
        return group;
    }
    return Object.freeze({ state, isDemo, badges });
});
