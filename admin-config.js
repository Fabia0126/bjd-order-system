// 后台公共配置：与前台 bjd-site.js 同一规则。
// 有 window.BJD_PUBLIC_CONFIG（预览/测试替换 runtime-config.js）就用它；
// 没有时只有正式域名才用下面的正式公开配置，其他域名一律停止连接。
(function () {
    'use strict';
    const PROD = { url: 'https://assqothmzcsusnksdnmm.supabase.co', anonKey: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImFzc3FvdGhtemNzdXNua3Nkbm1tIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzgzMzMwODEsImV4cCI6MjA5MzkwOTA4MX0.2OxbVdQQBANlv5_vmxitzR5CG79FrD3VPSFzX9laF9M' };
    const production = ['afamakeup.top', 'www.afamakeup.top'].includes(location.hostname);
    const cfg = window.BJD_PUBLIC_CONFIG || (production ? PROD : null);
    let ok = false;
    try {
        const u = new URL(cfg.url);
        ok = u.protocol === 'https:' && u.hostname.endsWith('.supabase.co') && !!cfg.anonKey;
    } catch (e) {}
    window.BJD_ADMIN_CONFIG = ok ? Object.freeze({ url: cfg.url, anonKey: cfg.anonKey }) : null;
})();
