// Supabase配置
const SUPABASE_URL = 'https://assqothmzcsusnksdnmm.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImFzc3FvdGhtemNzdXNua3Nkbm1tIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzgzMzMwODEsImV4cCI6MjA5MzkwOTA4MX0.2OxbVdQQBANlv5_vmxitzR5CG79FrD3VPSFzX9laF9M';
const supabaseClient = (typeof supabase !== 'undefined' && supabase.createClient)
    ? supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY)
    : window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// 价格配置
const PRICES = {
    base: {
        '3fen': { free: 190, specified: 210, cos: 230 },
        '4fen': { free: 160, specified: 180, cos: 200 }
    },
    addons: {
        '卸妆': 30,
        '睫毛': 5,
        'Pan粉去黄': 30,
        '面罩': 5,
        '疤痕': 25,
        '口配': 15,
        '重肌理': 30,
        '面纹': 0, // 待定
        '加急': 100
    }
};

// 妆面类别提示
const MAKEUP_HINTS = {
    free: '不可指定色系，无指定要求，可选男养/女养/攻/受，不接受修改，一键出图',
    specified: '可指定性格，最多3条禁忌+3条要求，定妆前发图确认，修改只能加深不能减淡，内容以纸质纸条为准',
    cos: '需提供清晰无遮挡角色图片，最多3条禁忌+3条要求，定妆前发图确认，修改只能加深不能减淡'
};

// DOM Elements
const form = document.getElementById('orderForm');
const totalPriceEl = document.getElementById('totalPrice');
const totalPriceFinalEl = document.getElementById('totalPriceFinal');
const makeupHintEl = document.getElementById('makeupHint');
const submitBtn = document.getElementById('submitBtn');
const agreeNotice = document.getElementById('agreeNotice');
const normalStatus = document.getElementById('normalStatus');

// Conditional fields
const tabooSection = document.getElementById('tabooSection');
const requirementSection = document.getElementById('requirementSection');
const referenceSection = document.getElementById('referenceSection');
const colorScheme = document.getElementById('colorScheme');

// 口配数量
const addonKoupei = document.getElementById('addonKoupei');
const koupeiQty = document.getElementById('koupeiQty');

const DRAFT_KEY = 'bjd_order_draft';
const IMG_KEY = 'bjd_order_images';
let savedImages = [];

function saveDraft() {
    const data = {};
    data.orderType = document.querySelector('input[name="orderType"]:checked')?.value;
    data.size = document.querySelector('input[name="size"]:checked')?.value;
    data.makeupType = document.querySelector('input[name="makeupType"]:checked')?.value;
    data.dollInfo = form.querySelector('[name="dollInfo"]').value;
    data.attribute = form.querySelector('[name="attribute"]').value;
    data.gender = form.querySelector('[name="gender"]').value;
    data.colorScheme = form.querySelector('[name="colorScheme"]').value;
    data.taboo1 = form.querySelector('[name="taboo1"]').value;
    data.taboo2 = form.querySelector('[name="taboo2"]').value;
    data.taboo3 = form.querySelector('[name="taboo3"]').value;
    data.requirement1 = form.querySelector('[name="requirement1"]').value;
    data.requirement2 = form.querySelector('[name="requirement2"]').value;
    data.requirement3 = form.querySelector('[name="requirement3"]').value;
    data.addons = Array.from(form.querySelectorAll('input[name="addon"]:checked')).map(cb => cb.value);
    data.koupeiQty = form.querySelector('[name="koupeiQty"]').value;
    data.freeItems = Array.from(form.querySelectorAll('input[name="freeItem"]:checked')).map(cb => cb.value);
    data.glitter = form.querySelector('[name="glitter"]').value;
    data.accessories = form.querySelector('[name="accessories"]').value;
    data.xianyuId = form.querySelector('[name="xianyuId"]').value;
    data.receiverName = form.querySelector('[name="receiverName"]').value;
    data.contact1 = form.querySelector('[name="contact1"]').value;
    data.contact2 = form.querySelector('[name="contact2"]').value;
    data.shipping = form.querySelector('[name="shipping"]').value;
    localStorage.setItem(DRAFT_KEY, JSON.stringify(data));
}

function loadDraft() {
    const raw = localStorage.getItem(DRAFT_KEY);
    if (!raw) return;
    try {
        const data = JSON.parse(raw);
        if (data.orderType) {
            const radio = form.querySelector(`input[name="orderType"][value="${data.orderType}"]`);
            if (radio) radio.checked = true;
        }
        if (data.size) {
            const radio = form.querySelector(`input[name="size"][value="${data.size}"]`);
            if (radio) radio.checked = true;
        }
        if (data.makeupType) {
            const radio = form.querySelector(`input[name="makeupType"][value="${data.makeupType}"]`);
            if (radio) radio.checked = true;
        }
        const textFields = ['dollInfo', 'taboo1', 'taboo2', 'taboo3', 'requirement1', 'requirement2', 'requirement3', 'accessories', 'xianyuId', 'receiverName', 'contact1', 'contact2', 'shipping'];
        textFields.forEach(name => {
            if (data[name]) {
                const el = form.querySelector(`[name="${name}"]`);
                if (el) el.value = data[name];
            }
        });
        const selectFields = ['attribute', 'gender', 'colorScheme', 'glitter'];
        selectFields.forEach(name => {
            if (data[name]) {
                const el = form.querySelector(`[name="${name}"]`);
                if (el) el.value = data[name];
            }
        });
        if (data.addons && data.addons.length > 0) {
            data.addons.forEach(val => {
                const cb = form.querySelector(`input[name="addon"][value="${val}"]`);
                if (cb) {
                    cb.checked = true;
                    if (cb.id === 'addonKoupei') {
                        koupeiQty.disabled = false;
                    }
                }
            });
        }
        if (data.koupeiQty) koupeiQty.value = data.koupeiQty;
        if (data.freeItems && data.freeItems.length > 0) {
            data.freeItems.forEach(val => {
                const cb = form.querySelector(`input[name="freeItem"][value="${val}"]`);
                if (cb) cb.checked = true;
            });
        }
    } catch (e) {}
}

function clearDraft() {
    localStorage.removeItem(DRAFT_KEY);
}

// 初始化
document.addEventListener('DOMContentLoaded', () => {
    loadDraft();
    loadSavedImages();
    updatePrice();
    updatePriceLabels();
    updateConditionalFields();
    updateMakeupHint();
    setupEventListeners();
    checkNormalStatus();
    startSmartPolling();
    form.addEventListener('input', saveDraft);
    form.addEventListener('change', saveDraft);

    if (new URLSearchParams(window.location.search).get('resubmit') === '1') {
        const banner = document.createElement('div');
        banner.style.cssText = 'background:#fff5f5;border:1px solid #f0c0c0;border-radius:12px;padding:14px 18px;margin-bottom:16px;text-align:center;color:#721c24;font-size:14px;';
        banner.textContent = '这是被拒绝订单的重新投递，已自动填入之前的信息，请修改后重新提交';
        form.parentElement.insertBefore(banner, form.querySelector('header')?.nextSibling || form.firstChild);
        window.history.replaceState({}, '', 'form.html');
    }
});

// 轮询相关
let pollTimer = null;

function startSmartPolling() {
    if (pollTimer) clearTimeout(pollTimer);
    const delay = getPollingDelay();
    pollTimer = setTimeout(async () => {
        await checkNormalStatus();
        startSmartPolling();
    }, delay);
}

function getPollingDelay() {
    // 倒计时最后10秒：1秒（快速同步开放状态）
    if (!isNormalOpen && normalOpenTime) {
        const diff = normalOpenTime - new Date();
        if (diff > 0 && diff <= 10000) return 1000;
    }
    // 刚开放后的头10秒：2秒
    if (isNormalOpen && normalLimit > 0 && normalRemaining > 0 && normalRemaining < normalLimit) return 2000;
    // 其他时候：10秒（用户会自己刷新）
    return 10000;
}

// 倒计时相关
let countdownInterval = null;
let normalOpenTime = null;
let isNormalOpen = true;
let normalLimit = 0;
let normalRemaining = -1;

// 检查普单开放状态
async function checkNormalStatus() {
    try {
        const { data: settings, error } = await supabaseClient
            .from('settings')
            .select('*')
            .eq('id', 1)
            .single();

        if (error) throw error;

        const statusText = document.getElementById('normalStatus');
        const countdownDisplay = document.getElementById('countdownDisplay');
        const countdownText = document.getElementById('countdownText');

        normalLimit = settings.normal_limit || 0;

        // 查剩余名额
        if (normalLimit > 0) {
            const { count } = await supabaseClient
                .from('orders')
                .select('*', { count: 'exact', head: true })
                .eq('order_type', '普单')
                .neq('status', 'rejected');
            normalRemaining = normalLimit - (count || 0);
        }

        if (!settings.normal_open) {
            isNormalOpen = false;

            if (settings.normal_open_time) {
                normalOpenTime = new Date(settings.normal_open_time);

                if (statusText) {
                    const limitText = normalLimit > 0 ? `（限${normalLimit}单）` : '';
                    statusText.textContent = `普单将于 ${normalOpenTime.toLocaleString('zh-CN')} 开放${limitText}，可提前填写信息`;
                    statusText.classList.add('show');
                }

                if (!countdownInterval) {
                    updateCountdown();
                    countdownInterval = setInterval(updateCountdown, 1000);
                }
            } else {
                if (statusText) {
                    statusText.textContent = '普单已满，当前仅接受钞能力单';
                    statusText.classList.add('show');
                }
                if (countdownDisplay) {
                    countdownDisplay.style.display = 'none';
                }
            }

            updateSubmitButton();
        } else {
            isNormalOpen = true;
            normalOpenTime = null;

            if (normalLimit > 0 && normalRemaining <= 0) {
                if (statusText) {
                    statusText.textContent = '普单已抢完，当前仅接受钞能力单';
                    statusText.classList.add('show');
                }
                updateSubmitButton();
            } else {
                if (statusText) {
                    if (normalLimit > 0 && normalRemaining > 0) {
                        statusText.textContent = `普单剩余 ${normalRemaining} 个名额`;
                        statusText.classList.add('show');
                    } else {
                        statusText.classList.remove('show');
                    }
                }
                updateSubmitButton();
            }

            if (countdownDisplay) {
                countdownDisplay.style.display = 'none';
            }

            if (countdownInterval) {
                clearInterval(countdownInterval);
                countdownInterval = null;
            }
        }
    } catch (error) {
        // Supabase不可用时静默处理，不影响用户填写
    }
}

function updateCountdown() {
    const countdownDisplay = document.getElementById('countdownDisplay');
    const countdownText = document.getElementById('countdownText');
    const selectedType = document.querySelector('input[name="orderType"]:checked').value;

    if (!normalOpenTime || selectedType !== 'normal') {
        if (countdownDisplay) countdownDisplay.style.display = 'none';
        return;
    }

    const now = new Date();
    const diff = normalOpenTime - now;

    if (diff <= 0) {
        // 时间到了
        isNormalOpen = true;
        if (countdownDisplay) countdownDisplay.style.display = 'none';
        if (countdownInterval) {
            clearInterval(countdownInterval);
            countdownInterval = null;
        }
        updateSubmitButton();
        return;
    }

    const hours = Math.floor(diff / 3600000);
    const minutes = Math.floor((diff % 3600000) / 60000);
    const seconds = Math.floor((diff % 60000) / 1000);

    if (countdownDisplay) countdownDisplay.style.display = 'block';
    if (countdownText) {
        const parts = [];
        if (hours > 0) parts.push(`${hours}时`);
        parts.push(`${minutes}分`);
        parts.push(`${seconds}秒`);
        countdownText.textContent = `距离开放还有 ${parts.join('')}，可先填写信息`;
    }
}

function updateSubmitButton() {
    const selectedType = document.querySelector('input[name="orderType"]:checked').value;
    const agreed = agreeNotice.checked;

    if (selectedType === 'normal' && !isNormalOpen) {
        submitBtn.disabled = true;
        submitBtn.textContent = '等待开放...';
    } else if (selectedType === 'normal' && normalLimit > 0 && normalRemaining <= 0) {
        submitBtn.disabled = true;
        submitBtn.textContent = '普单已抢完';
    } else {
        submitBtn.disabled = !agreed;
        submitBtn.textContent = '提交小纸条';
    }
}

function setupEventListeners() {
    // 尺寸变化
    document.querySelectorAll('input[name="size"]').forEach(radio => {
        radio.addEventListener('change', () => {
            updatePrice();
            updatePriceLabels();
        });
    });

    // 妆面类别变化
    document.querySelectorAll('input[name="makeupType"]').forEach(radio => {
        radio.addEventListener('change', () => {
            updatePrice();
            updateConditionalFields();
            updateMakeupHint();
        });
    });

    // 加购项变化
    document.querySelectorAll('input[name="addon"]').forEach(checkbox => {
        checkbox.addEventListener('change', (e) => {
            // 口配特殊处理
            if (e.target.id === 'addonKoupei') {
                koupeiQty.disabled = !e.target.checked;
                if (!e.target.checked) {
                    koupeiQty.value = 1;
                }
            }
            updatePrice();
        });
    });

    // 口配数量变化
    koupeiQty.addEventListener('change', updatePrice);

    // 同意条款
    agreeNotice.addEventListener('change', updateSubmitButton);

    // 订单类别变化时更新价格、提交按钮和倒计时
    document.querySelectorAll('input[name="orderType"]').forEach(radio => {
        radio.addEventListener('change', () => {
            updatePrice();
            updateSubmitButton();
            updateCountdown();
        });
    });

    // 参考图选择后保存+预览
    const fileInput = document.querySelector('input[name="referenceImages"]');
    if (fileInput) {
        fileInput.addEventListener('change', saveImages);
    }

    // 表单提交
    form.addEventListener('submit', handleSubmit);
}

function saveImages() {
    const fileInput = document.querySelector('input[name="referenceImages"]');
    if (!fileInput || !fileInput.files.length) return;

    savedImages = [];
    const promises = [];
    for (const file of fileInput.files) {
        promises.push(new Promise((resolve) => {
            const reader = new FileReader();
            reader.onload = (e) => {
                savedImages.push({ name: file.name, type: file.type, data: e.target.result });
                resolve();
            };
            reader.readAsDataURL(file);
        }));
    }
    Promise.all(promises).then(() => {
        try {
            localStorage.setItem(IMG_KEY, JSON.stringify(savedImages));
        } catch (e) {
            // localStorage满了就算了，不影响正常使用
        }
        renderImagePreview();
    });
}

function loadSavedImages() {
    try {
        const raw = localStorage.getItem(IMG_KEY);
        if (!raw) return;
        savedImages = JSON.parse(raw);
        if (savedImages.length > 0) renderImagePreview();
    } catch (e) {}
}

function renderImagePreview() {
    const preview = document.getElementById('imagePreview');
    if (!preview) return;
    if (savedImages.length === 0) {
        preview.innerHTML = '';
        return;
    }
    preview.innerHTML = savedImages.map((img, i) => `
        <div style="position:relative;display:inline-block;">
            <img src="${img.data}" style="width:60px;height:60px;object-fit:cover;border-radius:8px;border:1px solid #e8e0eb;">
            <span onclick="removeImage(${i})" style="position:absolute;top:-6px;right:-6px;width:18px;height:18px;background:#dc3545;color:white;border-radius:50%;font-size:12px;line-height:18px;text-align:center;cursor:pointer;">×</span>
        </div>
    `).join('');
}

function removeImage(index) {
    savedImages.splice(index, 1);
    try { localStorage.setItem(IMG_KEY, JSON.stringify(savedImages)); } catch(e) {}
    renderImagePreview();
}

function updatePrice() {
    const orderType = document.querySelector('input[name="orderType"]:checked').value;
    const size = document.querySelector('input[name="size"]:checked').value;
    const makeupType = document.querySelector('input[name="makeupType"]:checked').value;

    // 基础价
    let basePrice = PRICES.base[size][makeupType];

    // 钞单基础价×2
    if (orderType === 'chao') {
        basePrice *= 2;
    }

    // 加购项
    let addonPrice = 0;
    document.querySelectorAll('input[name="addon"]:checked').forEach(checkbox => {
        const value = checkbox.value;
        if (value === '口配') {
            addonPrice += PRICES.addons[value] * parseInt(koupeiQty.value || 1);
        } else {
            addonPrice += PRICES.addons[value];
        }
    });

    const total = basePrice + addonPrice;

    totalPriceEl.textContent = `¥${total}`;
    totalPriceFinalEl.textContent = `¥${total}`;
}

function updatePriceLabels() {
    const size = document.querySelector('input[name="size"]:checked').value;
    const prices = PRICES.base[size];

    document.querySelectorAll('input[name="makeupType"]').forEach(radio => {
        const priceEl = radio.parentElement.querySelector('.card-price');
        if (priceEl) {
            priceEl.textContent = `¥${prices[radio.value]}`;
        }
    });
}

function updateConditionalFields() {
    const makeupType = document.querySelector('input[name="makeupType"]:checked').value;
    const isFree = makeupType === 'free';

    // 禁忌、要求、参考图 - 仅指定/cos可填
    [tabooSection, requirementSection, referenceSection].forEach(section => {
        if (isFree) {
            section.classList.add('disabled');
            section.querySelectorAll('input').forEach(input => {
                input.disabled = true;
                input.value = '';
            });
        } else {
            section.classList.remove('disabled');
            section.querySelectorAll('input').forEach(input => {
                input.disabled = false;
            });
        }
    });

    // 色系 - 自由妆锁定为"自由发挥"
    if (isFree) {
        colorScheme.value = '自由发挥';
        colorScheme.disabled = true;
    } else {
        colorScheme.disabled = false;
    }
}

function updateMakeupHint() {
    const makeupType = document.querySelector('input[name="makeupType"]:checked').value;
    makeupHintEl.textContent = MAKEUP_HINTS[makeupType];
}

function handleSubmit(e) {
    e.preventDefault();

    if (!agreeNotice.checked) {
        alert('请先阅读并同意注意事项');
        return;
    }

    // 收集表单数据
    const formData = new FormData(form);
    const data = {};

    // 基本字段
    data.orderType = formData.get('orderType') === 'chao' ? '钞能力单' : '普单';
    data.size = formData.get('size') === '3fen' ? '三分' : '四分';
    data.makeupType = {
        'free': '全自由妆',
        'specified': '指定妆',
        'cos': 'COS妆'
    }[formData.get('makeupType')];

    data.dollInfo = formData.get('dollInfo');
    data.attribute = formData.get('attribute') || '不填';
    data.gender = formData.get('gender');
    data.colorScheme = formData.get('colorScheme');

    // 禁忌和要求
    data.taboos = [
        formData.get('taboo1'),
        formData.get('taboo2'),
        formData.get('taboo3')
    ].filter(Boolean);

    data.requirements = [
        formData.get('requirement1'),
        formData.get('requirement2'),
        formData.get('requirement3')
    ].filter(Boolean);

    // 加购项
    data.addons = formData.getAll('addon');
    if (data.addons.includes('口配')) {
        const idx = data.addons.indexOf('口配');
        data.addons[idx] = `口配×${formData.get('koupeiQty')}`;
    }

    // 免费项
    data.freeItems = formData.getAll('freeItem');
    data.glitter = formData.get('glitter');

    // 物流
    data.accessories = formData.get('accessories');
    data.xianyuId = formData.get('xianyuId');
    data.receiverName = formData.get('receiverName');
    data.contact1 = formData.get('contact1');
    data.contact2 = formData.get('contact2');
    data.shipping = formData.get('shipping');

    // 价格
    data.totalPrice = totalPriceFinalEl.textContent;

    // 生成文字版小纸条
    const textVersion = generateTextVersion(data);

    // 保存当前数据到全局变量
    window.currentOrderData = data;

    // 显示预览
    showPreview(data, textVersion);
}

function generateTextVersion(data) {
    let text = `【送妆小纸条】
序号：（待确认后生成）
订单类别：${data.orderType}
尺寸：${data.size}
妆面类别：${data.makeupType}
娃社+官名+肤色：${data.dollInfo}
属性：${data.attribute}
性别：${data.gender}
色系：${data.colorScheme}`;

    if (data.taboos.length > 0) {
        text += `\n禁忌：${data.taboos.join('、')}`;
    }

    if (data.requirements.length > 0) {
        text += `\n要求：${data.requirements.join('、')}`;
    }

    text += `\n加购项：${data.addons.length > 0 ? data.addons.join('、') : '无'}`;
    text += `\n免费项：${data.freeItems.length > 0 ? data.freeItems.join('、') : '自由发挥'}`;
    text += `\n闪粉：${data.glitter}`;
    text += `\n随箱物品：${data.accessories || '无'}`;
    text += `\n闲鱼ID：${data.xianyuId}`;
    text += `\n收件人全名：${data.receiverName}`;
    text += `\n联系方式：${data.contact1} / ${data.contact2}`;
    text += `\n快递：${data.shipping}`;
    text += `\n\n预估总价：${data.totalPrice}`;
    text += `\n（面纹价格待店主确认）`;

    return text;
}

function showPreview(data, textVersion) {
    // 创建预览弹窗
    const modal = document.createElement('div');
    modal.className = 'preview-modal';
    modal.innerHTML = `
        <div class="preview-content">
            <h2>小纸条预览</h2>
            <p class="preview-note">请确认信息无误后提交</p>
            <div class="preview-text">
                <pre>${textVersion}</pre>
            </div>
            <div class="preview-actions">
                <button class="btn-copy" onclick="copyText()">复制文字版</button>
                <button class="btn-confirm" onclick="confirmSubmit()">确认提交</button>
                <button class="btn-cancel" onclick="closePreview()">返回修改</button>
            </div>
        </div>
    `;

    // 添加样式
    const style = document.createElement('style');
    style.textContent = `
        .preview-modal {
            position: fixed;
            top: 0;
            left: 0;
            right: 0;
            bottom: 0;
            background: rgba(0,0,0,0.6);
            display: flex;
            align-items: center;
            justify-content: center;
            z-index: 1000;
            padding: 20px;
        }
        .preview-content {
            background: white;
            border-radius: 16px;
            padding: 24px;
            max-width: 500px;
            width: 100%;
            max-height: 80vh;
            overflow-y: auto;
        }
        .preview-content h2 {
            color: #8b5a7b;
            margin-bottom: 8px;
        }
        .preview-note {
            color: #888;
            font-size: 14px;
            margin-bottom: 16px;
        }
        .preview-text {
            background: #f8f5fa;
            border-radius: 12px;
            padding: 16px;
            margin-bottom: 20px;
        }
        .preview-text pre {
            white-space: pre-wrap;
            font-family: inherit;
            font-size: 14px;
            line-height: 1.6;
            color: #333;
        }
        .preview-actions {
            display: flex;
            flex-direction: column;
            gap: 10px;
        }
        .preview-actions button {
            padding: 14px;
            border-radius: 10px;
            font-size: 16px;
            font-weight: 500;
            cursor: pointer;
            border: none;
        }
        .btn-copy {
            background: #f5f0ff;
            color: #8b5a7b;
        }
        .btn-confirm {
            background: linear-gradient(135deg, #8b5a7b 0%, #a06b8b 100%);
            color: white;
        }
        .btn-cancel {
            background: #f0f0f0;
            color: #666;
        }
    `;
    document.head.appendChild(style);
    document.body.appendChild(modal);

    // 保存文字版到全局变量供复制
    window.currentTextVersion = textVersion;
}

function copyText() {
    navigator.clipboard.writeText(window.currentTextVersion).then(() => {
        alert('已复制到剪贴板！');
    }).catch(() => {
        // 降级方案
        const textarea = document.createElement('textarea');
        textarea.value = window.currentTextVersion;
        document.body.appendChild(textarea);
        textarea.select();
        document.execCommand('copy');
        document.body.removeChild(textarea);
        alert('已复制到剪贴板！');
    });
}

async function confirmSubmit() {
    const data = window.currentOrderData;
    if (!data) {
        alert('数据错误，请重新填写');
        closePreview();
        return;
    }

    const confirmBtn = document.querySelector('.btn-confirm');
    const cancelBtn = document.querySelector('.btn-cancel');
    if (confirmBtn) {
        confirmBtn.disabled = true;
        confirmBtn.textContent = '排队中...';
    }
    if (cancelBtn) cancelBtn.disabled = true;

    // 随机延迟0-2秒，把并发请求打散
    await new Promise(r => setTimeout(r, Math.random() * 2000));

    if (confirmBtn) confirmBtn.textContent = '正在提交...';

    // 普单提交前快速检查库存
    if (data.orderType === '普单' && normalLimit > 0) {
        try {
            const { count } = await supabaseClient
                .from('orders')
                .select('*', { count: 'exact', head: true })
                .eq('order_type', '普单')
                .neq('status', 'rejected');
            if (count >= normalLimit) {
                alert('很抱歉，普单已被抢完啦！');
                if (confirmBtn) { confirmBtn.disabled = false; confirmBtn.textContent = '确认提交'; }
                if (cancelBtn) cancelBtn.disabled = false;
                normalRemaining = 0;
                updateSubmitButton();
                closePreview();
                return;
            }
        } catch (e) {
            // 检查失败不阻塞，靠数据库trigger兜底
        }
    }

    const orderData = {
        status: 'pending',
        order_type: data.orderType,
        size: data.size,
        makeup_type: data.makeupType,
        doll_info: data.dollInfo,
        attribute: data.attribute,
        gender: data.gender,
        color_scheme: data.colorScheme,
        taboos: data.taboos || [],
        requirements: data.requirements || [],
        addons: data.addons || [],
        free_items: data.freeItems || [],
        glitter: data.glitter,
        accessories: data.accessories,
        xianyu_id: data.xianyuId,
        receiver_name: data.receiverName,
        contact1: data.contact1,
        contact2: data.contact2,
        shipping: data.shipping,
        total_price: data.totalPrice
    };

    try {
        const fileInput = document.querySelector('input[name="referenceImages"]');
        const hasNewFiles = fileInput && fileInput.files.length > 0;
        const hasSavedImages = savedImages.length > 0;

        if (hasNewFiles || hasSavedImages) {
            if (confirmBtn) confirmBtn.textContent = '正在上传图片...';
            const imageUrls = [];

            if (hasNewFiles) {
                for (const file of fileInput.files) {
                    const ext = file.name.split('.').pop();
                    const fileName = `${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`;
                    const { error: uploadError } = await supabaseClient.storage
                        .from('reference-images')
                        .upload(fileName, file);
                    if (!uploadError) {
                        const { data: urlData } = supabaseClient.storage
                            .from('reference-images')
                            .getPublicUrl(fileName);
                        imageUrls.push(urlData.publicUrl);
                    }
                }
            } else if (hasSavedImages) {
                for (const img of savedImages) {
                    const resp = await fetch(img.data);
                    const blob = await resp.blob();
                    const ext = img.name.split('.').pop() || 'jpg';
                    const fileName = `${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`;
                    const { error: uploadError } = await supabaseClient.storage
                        .from('reference-images')
                        .upload(fileName, blob);
                    if (!uploadError) {
                        const { data: urlData } = supabaseClient.storage
                            .from('reference-images')
                            .getPublicUrl(fileName);
                        imageUrls.push(urlData.publicUrl);
                    }
                }
            }

            if (imageUrls.length > 0) {
                orderData.reference_images = imageUrls;
            }
        }

        if (confirmBtn) confirmBtn.textContent = '正在提交...';

        const timeoutPromise = new Promise((_, reject) =>
            setTimeout(() => reject(new Error('提交超时，请检查网络后重试')), 20000)
        );

        const insertPromise = supabaseClient
            .from('orders')
            .insert([orderData])
            .select();

        const { data: result, error } = await Promise.race([insertPromise, timeoutPromise]);

        if (error) throw error;

        if (!result || result.length === 0) {
            throw new Error('服务器未返回确认数据，订单可能未成功提交，请刷新后检查');
        }

        alert('提交成功！\n\n订单已提交，请等待店主审核确认。\n确认后会生成订单编号，届时请凭编号去闲鱼拍万能拍。\n\n您可以在"订单查询"页面用联系方式查看订单状态。');

        closePreview();
        clearDraft();
        savedImages = [];
        try { localStorage.removeItem(IMG_KEY); } catch(e) {}
        document.getElementById('imagePreview').innerHTML = '';

        document.getElementById('orderForm').reset();
        document.getElementById('agreeNotice').checked = false;
        document.getElementById('submitBtn').disabled = true;
        updatePrice();
    } catch (error) {
        console.error('提交失败:', error);
        const errMsg = error.message || '';
        if (errMsg.includes('NORMAL_ORDER_FULL') || errMsg.includes('普单已抢完')) {
            alert('很抱歉，普单已被抢完啦！');
            normalRemaining = 0;
            updateSubmitButton();
            closePreview();
        } else {
            alert('提交失败，请稍后重试\n\n错误信息: ' + (errMsg || '网络错误'));
            if (confirmBtn) {
                confirmBtn.disabled = false;
                confirmBtn.textContent = '确认提交';
            }
            if (cancelBtn) cancelBtn.disabled = false;
        }
    }
}

function closePreview() {
    const modal = document.querySelector('.preview-modal');
    if (modal) {
        modal.remove();
    }
}
