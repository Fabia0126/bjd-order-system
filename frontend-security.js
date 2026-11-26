(function (root, factory) {
    'use strict';
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    else root.BJDSecurity = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';

    // HTML text/quoted attribute contexts only. Never interpolate into inline
    // JavaScript, CSS, or a URL; use DOM listeners and validate URLs separately.
    function escapeHTML(value) {
        return String(value ?? '').replace(/[&<>"']/g, char => ({
            '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
        })[char]);
    }

    function setText(element, value) {
        element.textContent = String(value ?? '');
        return element;
    }

    function csvCell(value) {
        let text = String(value ?? '');
        // Quoting CSV alone does not stop spreadsheet formula execution.
        if (/^[\s\u0000-\u001f\u007f]*[=+\-@]/u.test(text)
            || /^[\u0000-\u001f\u007f]/u.test(text)) text = "'" + text;
        return '"' + text.replace(/"/g, '""') + '"';
    }

    function csvDocument(headers, rows) {
        return '\ufeff' + [headers, ...rows].map(row => row.map(csvCell).join(',')).join('\r\n');
    }

    function safePreviewDataURL(value) {
        if (typeof value !== 'string') return null;
        return /^data:image\/(?:jpeg|png|webp|gif|avif|heic|heif);base64,[A-Za-z0-9+/=\r\n]+$/i.test(value)
            ? value : null;
    }

    function uploadSlots(ticket, entryID) {
        const uuid = '[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}';
        if (!new RegExp('^' + uuid + '$').test(String(entryID))
            || ticket?.bucket !== 'reference-images' || !Array.isArray(ticket.slots)
            || ticket.slots.length !== 6 || typeof ticket.slots[0] !== 'string') {
            throw new Error('上传槽位授权格式无效。');
        }
        const first = ticket.slots[0].match(new RegExp('^entries/' + entryID + '/(' + uuid + ')/1$'));
        if (!first) throw new Error('上传槽位不属于当前投递。');
        const prefix = 'entries/' + entryID + '/' + first[1] + '/';
        if (ticket.slots.some((path, index) => path !== prefix + (index + 1))) {
            throw new Error('上传槽位顺序或范围无效。');
        }
        return Object.freeze([...ticket.slots]);
    }

    function renderImagePreview(container, images, onRemove) {
        container.replaceChildren();
        if (!Array.isArray(images)) return;
        images.forEach((item, index) => {
            const source = safePreviewDataURL(item && item.data);
            if (!source) return;
            const wrapper = document.createElement('div');
            wrapper.style.cssText = 'position:relative;display:inline-block;';
            const image = document.createElement('img');
            image.src = source;
            image.alt = '参考图预览';
            image.style.cssText = 'width:60px;height:60px;object-fit:cover;border-radius:8px;border:1px solid #e8e0eb;';
            const remove = document.createElement('button');
            remove.type = 'button';
            remove.textContent = '×';
            remove.setAttribute('aria-label', '移除此参考图');
            remove.style.cssText = 'position:absolute;top:-6px;right:-6px;width:24px;height:24px;border:0;background:#dc3545;color:white;border-radius:50%;font-size:16px;line-height:24px;text-align:center;cursor:pointer;padding:0;';
            remove.addEventListener('click', () => onRemove(index));
            wrapper.append(image, remove);
            container.append(wrapper);
        });
    }

    return Object.freeze({ escapeHTML, setText, csvCell, csvDocument, safePreviewDataURL, renderImagePreview, uploadSlots });
});
