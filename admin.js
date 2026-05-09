// Supabase配置
const SUPABASE_URL = 'https://assqothmzcsusnksdnmm.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImFzc3FvdGhtemNzdXNua3Nkbm1tIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzgzMzMwODEsImV4cCI6MjA5MzkwOTA4MX0.2OxbVdQQBANlv5_vmxitzR5CG79FrD3VPSFzX9laF9M';

let supabaseClient = null;
try {
    if (typeof supabase !== 'undefined' && supabase.createClient) {
        supabaseClient = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
    } else if (typeof window.supabase !== 'undefined') {
        supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
    } else {
        alert('Supabase库未加载！请刷新页面');
    }
} catch (e) {
    alert('Supabase初始化失败: ' + e.message);
}

// 订单状态
const STATUS = {
    pending: '待审核',
    approved: '等待中',
    working: '正在施工',
    packing: '已确认待打包',
    completed: '订单完成',
    rejected: '已拒绝'
};

// 状态流转
const STATUS_FLOW = {
    pending: ['approved', 'rejected'],
    approved: ['working'],
    working: ['packing'],
    packing: ['completed'],
    completed: [],
    rejected: []
};

let currentFilter = 'all';
let allOrders = [];

// 获取订单
async function fetchOrders() {
    try {
        const { data, error } = await supabaseClient
            .from('orders')
            .select('*')
            .order('submit_time', { ascending: false });

        if (error) throw error;
        allOrders = data || [];
        renderOrders(currentFilter);
        updateStats();
    } catch (error) {
        console.error('获取订单失败:', error);
    }
}

// 获取设置
async function fetchSettings() {
    try {
        const { data, error } = await supabaseClient
            .from('settings')
            .select('*')
            .eq('id', 1)
            .single();

        if (error) throw error;
        return data;
    } catch (error) {
        console.error('获取设置失败:', error);
        return { normal_open: true, normal_limit: 0, normal_open_time: null };
    }
}

// 生成订单编号
function generateOrderId() {
    const approvedOrders = allOrders.filter(o => o.status !== 'pending' && o.status !== 'rejected');
    const nextNum = approvedOrders.length + 1;
    const date = new Date();
    const dateStr = `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, '0')}`;
    return `BJD${dateStr}-${String(nextNum).padStart(3, '0')}`;
}

// 渲染订单列表
function renderOrders(filter = 'all') {
    const orderList = document.getElementById('orderList');

    let filtered = allOrders;
    if (filter !== 'all') {
        filtered = allOrders.filter(o => o.status === filter);
    }

    // 排序：待审核优先
    filtered.sort((a, b) => {
        if (a.status === 'pending' && b.status !== 'pending') return -1;
        if (b.status === 'pending' && a.status !== 'pending') return 1;
        return new Date(b.submit_time) - new Date(a.submit_time);
    });

    if (filtered.length === 0) {
        orderList.innerHTML = `
            <div class="empty-state">
                <p>暂无${filter === 'all' ? '' : STATUS[filter]}订单</p>
                <p class="hint">客户提交小纸条后会显示在这里</p>
            </div>
        `;
        return;
    }

    orderList.innerHTML = filtered.map(order => `
        <div class="order-card" onclick="openOrder('${order.id}')">
            <div class="order-header">
                <span class="order-id">
                    ${order.order_id || '<span class="pending">待生成编号</span>'}
                </span>
                <span class="order-status status-${order.status}">${STATUS[order.status]}</span>
            </div>
            <div class="order-info">
                <span>🎭 ${order.makeup_type}</span>
                <span>📏 ${order.size}</span>
                <span>🎪 ${(order.doll_info || '').substring(0, 15)}${(order.doll_info || '').length > 15 ? '...' : ''}</span>
                <span>👤 ${order.receiver_name}</span>
            </div>
            <div class="order-price">
                <span class="price-value">${order.total_price}</span>
                <span class="order-time">${formatTime(order.submit_time)}</span>
            </div>
        </div>
    `).join('');
}

function formatTime(timeStr) {
    if (!timeStr) return '';
    const date = new Date(timeStr);
    const month = date.getMonth() + 1;
    const day = date.getDate();
    const hours = String(date.getHours()).padStart(2, '0');
    const mins = String(date.getMinutes()).padStart(2, '0');
    return `${month}/${day} ${hours}:${mins}`;
}

function updateStats() {
    document.getElementById('statPending').textContent = allOrders.filter(o => o.status === 'pending').length;
    document.getElementById('statApproved').textContent = allOrders.filter(o => o.status === 'approved').length;
    document.getElementById('statWorking').textContent = allOrders.filter(o => o.status === 'working').length;
    document.getElementById('statCompleted').textContent = allOrders.filter(o => o.status === 'completed').length;

    const normalCount = allOrders.filter(o => o.order_type === '普单' && o.status !== 'rejected').length;
    const countEl = document.getElementById('currentNormalCount');
    if (countEl) countEl.textContent = normalCount;
}

// 打开订单详情
function openOrder(id) {
    const order = allOrders.find(o => o.id === id);
    if (!order) return;

    const modal = document.getElementById('orderModal');
    const detail = document.getElementById('orderDetail');
    const actions = document.getElementById('orderActions');

    detail.innerHTML = `
        <div class="detail-section">
            <h3>订单信息</h3>
            <div class="detail-content">
                <div class="detail-row"><span class="detail-label">订单编号</span><span class="detail-value">${order.order_id || '待生成'}</span></div>
                <div class="detail-row"><span class="detail-label">订单类别</span><span class="detail-value">${order.order_type}</span></div>
                <div class="detail-row"><span class="detail-label">尺寸</span><span class="detail-value">${order.size}</span></div>
                <div class="detail-row"><span class="detail-label">妆面类别</span><span class="detail-value">${order.makeup_type}</span></div>
            </div>
        </div>
        <div class="detail-section">
            <h3>娃头信息</h3>
            <div class="detail-content">
                <div class="detail-row"><span class="detail-label">娃社+官名+肤色</span><span class="detail-value">${order.doll_info}</span></div>
                <div class="detail-row"><span class="detail-label">属性</span><span class="detail-value">${order.attribute}</span></div>
                <div class="detail-row"><span class="detail-label">性别</span><span class="detail-value">${order.gender}</span></div>
            </div>
        </div>
        <div class="detail-section">
            <h3>妆面要求</h3>
            <div class="detail-content">
                <div class="detail-row"><span class="detail-label">色系</span><span class="detail-value">${order.color_scheme}</span></div>
                ${order.taboos && order.taboos.length > 0 ? `<div class="detail-row"><span class="detail-label">禁忌</span><span class="detail-value">${order.taboos.join('、')}</span></div>` : ''}
                ${order.requirements && order.requirements.length > 0 ? `<div class="detail-row"><span class="detail-label">要求</span><span class="detail-value">${order.requirements.join('、')}</span></div>` : ''}
            </div>
        </div>
        <div class="detail-section">
            <h3>加购 & 免费项</h3>
            <div class="detail-content">
                <div class="detail-row"><span class="detail-label">加购项</span><span class="detail-value">${order.addons && order.addons.length > 0 ? order.addons.join('、') : '无'}</span></div>
                <div class="detail-row"><span class="detail-label">免费项</span><span class="detail-value">${order.free_items && order.free_items.length > 0 ? order.free_items.join('、') : '自由发挥'}</span></div>
                <div class="detail-row"><span class="detail-label">闪粉</span><span class="detail-value">${order.glitter}</span></div>
            </div>
        </div>
        <div class="detail-section">
            <h3>物流信息</h3>
            <div class="detail-content">
                <div class="detail-row"><span class="detail-label">随箱物品</span><span class="detail-value">${order.accessories || '无'}</span></div>
                <div class="detail-row"><span class="detail-label">闲鱼ID</span><span class="detail-value">${order.xianyu_id}</span></div>
                <div class="detail-row"><span class="detail-label">收件人</span><span class="detail-value">${order.receiver_name}</span></div>
                <div class="detail-row"><span class="detail-label">联系方式</span><span class="detail-value">${order.contact1} / ${order.contact2}</span></div>
                <div class="detail-row"><span class="detail-label">快递</span><span class="detail-value">${order.shipping}</span></div>
            </div>
        </div>
        <div class="detail-section">
            <h3>价格</h3>
            <div class="detail-content">
                <div class="detail-row"><span class="detail-label">总价</span><span class="detail-value" style="color: #d485a8; font-size: 18px;">${order.total_price}</span></div>
            </div>
        </div>
    `;

    const nextStatuses = STATUS_FLOW[order.status] || [];
    if (order.status === 'pending') {
        actions.innerHTML = `
            <button class="btn-approve" onclick="updateOrderStatus('${order.id}', 'approved')">✓ 通过并生成编号</button>
            <button class="btn-reject" onclick="updateOrderStatus('${order.id}', 'rejected')">✗ 拒绝</button>
        `;
    } else if (nextStatuses.length > 0) {
        actions.innerHTML = nextStatuses.map(status => `
            <button class="btn-status" onclick="updateOrderStatus('${order.id}', '${status}')">${STATUS[status]}</button>
        `).join('');
    } else {
        actions.innerHTML = '<p style="color: #888; text-align: center; width: 100%;">该订单已完成/已拒绝</p>';
    }

    modal.classList.add('show');
    window.currentOrderId = id;
}

function closeModal() {
    document.getElementById('orderModal').classList.remove('show');
}

// 更新订单状态
async function updateOrderStatus(id, newStatus) {
    try {
        const updateData = {
            status: newStatus,
            last_update: new Date().toISOString()
        };

        // 如果是审核通过，生成订单编号
        if (newStatus === 'approved') {
            updateData.order_id = generateOrderId();
        }

        const { error } = await supabaseClient
            .from('orders')
            .update(updateData)
            .eq('id', id);

        if (error) throw error;

        closeModal();
        await fetchOrders();
    } catch (error) {
        console.error('更新失败:', error);
        alert('更新失败: ' + error.message);
    }
}

// 普单设置
async function openSettings() {
    try {
        alert('正在获取设置...');
        const settings = await fetchSettings();
        alert('设置获取成功: ' + JSON.stringify(settings));

        document.getElementById('normalOn').classList.toggle('active', settings.normal_open);
        document.getElementById('normalOff').classList.toggle('active', !settings.normal_open);
        document.getElementById('normalLimit').value = settings.normal_limit || 0;

        if (settings.normal_open_time) {
            const dt = new Date(settings.normal_open_time);
            document.getElementById('normalOpenTime').value = dt.toISOString().slice(0, 16);
        } else {
            document.getElementById('normalOpenTime').value = '';
        }

        const normalCount = allOrders.filter(o => o.order_type === '普单' && o.status !== 'rejected').length;
        document.getElementById('currentNormalCount').textContent = normalCount;

        document.getElementById('settingsModal').classList.add('show');
    } catch (error) {
        alert('openSettings错误: ' + error.message);
    }
}

function closeSettings() {
    saveSettings();
    document.getElementById('settingsModal').classList.remove('show');
}

function setNormalStatus(isOpen) {
    document.getElementById('normalOn').classList.toggle('active', isOpen);
    document.getElementById('normalOff').classList.toggle('active', !isOpen);
}

async function saveSettings() {
    const settings = {
        normal_open: document.getElementById('normalOn').classList.contains('active'),
        normal_limit: parseInt(document.getElementById('normalLimit').value) || 0,
        normal_open_time: document.getElementById('normalOpenTime').value || null,
        updated_at: new Date().toISOString()
    };

    try {
        const { error } = await supabaseClient
            .from('settings')
            .update(settings)
            .eq('id', 1);

        if (error) throw error;
    } catch (error) {
        console.error('保存设置失败:', error);
    }
}

// 导出订单
function exportOrders() {
    if (allOrders.length === 0) {
        alert('暂无订单可导出');
        return;
    }

    const headers = [
        '订单编号', '状态', '订单类别', '尺寸', '妆面类别',
        '娃社+官名+肤色', '属性', '性别', '色系',
        '禁忌', '要求', '加购项', '免费项', '闪粉',
        '随箱物品', '闲鱼ID', '收件人', '联系方式1', '联系方式2',
        '快递', '总价', '提交时间'
    ];

    const rows = allOrders.map(o => [
        o.order_id || '待生成',
        STATUS[o.status] || o.status,
        o.order_type,
        o.size,
        o.makeup_type,
        o.doll_info,
        o.attribute,
        o.gender,
        o.color_scheme,
        (o.taboos || []).join('；'),
        (o.requirements || []).join('；'),
        (o.addons || []).join('；'),
        (o.free_items || []).join('；'),
        o.glitter,
        o.accessories || '',
        o.xianyu_id,
        o.receiver_name,
        o.contact1,
        o.contact2,
        o.shipping,
        o.total_price,
        o.submit_time ? new Date(o.submit_time).toLocaleString('zh-CN') : ''
    ]);

    const BOM = '﻿';
    const csvContent = BOM + [
        headers.join(','),
        ...rows.map(row => row.map(cell => `"${String(cell).replace(/"/g, '""')}"`).join(','))
    ].join('\n');

    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `BJD订单_${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
}

// 筛选标签
document.querySelectorAll('.tab').forEach(tab => {
    tab.addEventListener('click', () => {
        document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
        tab.classList.add('active');
        currentFilter = tab.dataset.filter;
        renderOrders(currentFilter);
    });
});

// 初始化
document.addEventListener('DOMContentLoaded', async () => {
    try {
        console.log('开始加载...');
        await fetchOrders();
        console.log('加载完成，订单数:', allOrders.length);
        // 每10秒刷新一次
        setInterval(fetchOrders, 10000);
    } catch (error) {
        console.error('初始化失败:', error);
        alert('加载失败: ' + error.message);
    }
});

// 全局错误捕获
window.onerror = function(msg, url, line, col, error) {
    alert('JS错误: ' + msg + '\n行号: ' + line);
    return false;
};
