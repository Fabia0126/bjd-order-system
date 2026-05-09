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

// 初始化
document.addEventListener('DOMContentLoaded', () => {
    updatePrice();
    updateConditionalFields();
    setupEventListeners();
    checkNormalStatus(); // 检查普单状态
    setInterval(checkNormalStatus, 5000); // 每5秒检查一次
});

// 检查普单开放状态
async function checkNormalStatus() {
    try {
        const { data: settings, error } = await supabaseClient
            .from('settings')
            .select('*')
            .eq('id', 1)
            .single();

        if (error) throw error;

        const normalRadio = document.querySelector('input[name="orderType"][value="normal"]');
        const chaoRadio = document.querySelector('input[name="orderType"][value="chao"]');
        const statusText = document.getElementById('normalStatus');

        if (!settings.normal_open) {
            // 普单关闭
            normalRadio.disabled = true;
            normalRadio.parentElement.querySelector('.card-content').style.opacity = '0.5';

            // 如果当前选的是普单，自动切换到钞单
            if (normalRadio.checked) {
                chaoRadio.checked = true;
                updatePrice();
            }

            // 显示提示
            if (statusText) {
                if (settings.normal_open_time) {
                    const openTime = new Date(settings.normal_open_time);
                    statusText.textContent = `普单未开放，下次开放时间：${openTime.toLocaleString('zh-CN')}`;
                } else {
                    statusText.textContent = '普单已满，当前仅接受钞能力单';
                }
                statusText.classList.add('show');
            }
        } else {
            // 普单开放
            normalRadio.disabled = false;
            normalRadio.parentElement.querySelector('.card-content').style.opacity = '1';
            if (statusText) {
                statusText.classList.remove('show');
            }
        }
    } catch (error) {
        console.log('获取设置失败，使用默认状态');
    }
}

function setupEventListeners() {
    // 订单类别变化
    document.querySelectorAll('input[name="orderType"]').forEach(radio => {
        radio.addEventListener('change', updatePrice);
    });

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
    agreeNotice.addEventListener('change', () => {
        submitBtn.disabled = !agreeNotice.checked;
    });

    // 表单提交
    form.addEventListener('submit', handleSubmit);
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
    // 获取当前订单数据
    const data = window.currentOrderData;
    if (!data) {
        alert('数据错误，请重新填写');
        closePreview();
        return;
    }

    // 准备数据库数据
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
        // 保存到 Supabase
        const { data: result, error } = await supabaseClient
            .from('orders')
            .insert([orderData])
            .select();

        if (error) throw error;

        // 显示成功提示
        alert('提交成功！\n\n订单已提交，请等待店主审核确认。\n确认后会生成订单编号，届时请凭编号去闲鱼拍万能拍。\n\n您可以在"订单查询"页面用联系方式查看订单状态。');

        closePreview();

        // 重置表单
        document.getElementById('orderForm').reset();
        document.getElementById('agreeNotice').checked = false;
        document.getElementById('submitBtn').disabled = true;
        updatePrice();
    } catch (error) {
        console.error('提交失败:', error);
        alert('提交失败，请稍后重试\n\n错误信息: ' + error.message);
    }
}

function closePreview() {
    const modal = document.querySelector('.preview-modal');
    if (modal) {
        modal.remove();
    }
}
