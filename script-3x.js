// Supabase配置
const SUPABASE_URL = 'https://assqothmzcsusnksdnmm.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImFzc3FvdGhtemNzdXNua3Nkbm1tIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzgzMzMwODEsImV4cCI6MjA5MzkwOTA4MX0.2OxbVdQQBANlv5_vmxitzR5CG79FrD3VPSFzX9laF9M';
const bjdSite = BJDPage.connect(SUPABASE_URL, SUPABASE_ANON_KEY);
window.bjdSite = bjdSite;
const supabaseClient = bjdSite.client;

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
        '面纹': 0,
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

const DRAFT_KEY = 'bjd_order_draft_3x';
const IMG_KEY = 'bjd_order_images_3x';
let savedImages = [];
const bjdForm = new BJDForm.Controller(bjdSite, {
    form,
    getSavedImages: () => savedImages,
    onComplete: () => {
        closePreview();
        window.currentOrderData = null;
        try { clearDraft(); localStorage.removeItem(IMG_KEY); } catch {}
        savedImages = [];
        renderImagePreview();
        form.reset();
        agreeNotice.checked = false;
        updatePrice();
        updateConditionalFields();
    }
});

function saveDraft() {
    const data = {};
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
    checkPremiumStatus();
    form.addEventListener('input', saveDraft);
    form.addEventListener('change', saveDraft);
});

function checkPremiumStatus() { bjdForm.start(); }
function updateSubmitButton() { bjdForm.updateAvailability(); }

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
        } catch (e) {}
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
    BJDSecurity.renderImagePreview(preview, savedImages, removeImage);
}

function removeImage(index) {
    savedImages.splice(index, 1);
    try { localStorage.setItem(IMG_KEY, JSON.stringify(savedImages)); } catch(e) {}
    renderImagePreview();
}

function updatePrice() {
    const size = document.querySelector('input[name="size"]:checked').value;
    const makeupType = document.querySelector('input[name="makeupType"]:checked').value;

    // 基础价 ×3
    let basePrice = PRICES.base[size][makeupType] * 3;

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

    const formData = new FormData(form);
    const data = {};
    try { data.rpcSnapshot = bjdForm.snapshot(); }
    catch (error) { alert(error.message); return; }


    data.orderType = '三倍超';
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

    data.addons = formData.getAll('addon');
    if (data.addons.includes('口配')) {
        const idx = data.addons.indexOf('口配');
        data.addons[idx] = `口配×${formData.get('koupeiQty')}`;
    }

    data.freeItems = formData.getAll('freeItem');
    data.glitter = formData.get('glitter');

    data.accessories = formData.get('accessories');
    data.xianyuId = formData.get('xianyuId');
    data.receiverName = formData.get('receiverName');
    data.contact1 = formData.get('contact1');
    data.contact2 = formData.get('contact2');
    data.shipping = formData.get('shipping');

    data.totalPrice = totalPriceFinalEl.textContent;

    const textVersion = generateTextVersion(data);

    window.currentOrderData = data;

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
    const modal = document.createElement('div');
    modal.className = 'preview-modal';
    modal.innerHTML = `
        <div class="preview-content">
            <h2>小纸条预览</h2>
            <p class="preview-note">请确认信息无误后提交</p>
            <div class="preview-text">
                <pre></pre>
            </div>
            <div class="preview-actions">
                <button class="btn-copy" onclick="copyText()">复制文字版</button>
                <button class="btn-confirm" onclick="confirmSubmit()">确认提交</button>
                <button class="btn-cancel" onclick="closePreview()">返回修改</button>
            </div>
        </div>
    `;

    BJDSecurity.setText(modal.querySelector('.preview-text pre'), textVersion);

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

    window.currentTextVersion = textVersion;
}

function copyText() {
    navigator.clipboard.writeText(window.currentTextVersion).then(() => {
        alert('已复制到剪贴板！');
    }).catch(() => {
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
    const snapshot = window.currentOrderData?.rpcSnapshot;
    if (!snapshot) { alert('请重新核对小纸条。'); return; }
    await bjdForm.submit(snapshot);
}

function closePreview() {
    const modal = document.querySelector('.preview-modal');
    if (modal) {
        modal.remove();
    }
}
