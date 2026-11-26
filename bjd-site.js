(function () {
    'use strict';
    function connect(defaultURL, defaultKey) {
        const config = window.BJD_PUBLIC_CONFIG;
        const production = ['afamakeup.top', 'www.afamakeup.top'].includes(location.hostname);
        if (!config && !production) {
            const note = document.createElement('p');
            note.textContent = '此预览尚未配置隔离测试环境，暂不连接数据库。';
            document.body.prepend(note);
            throw new Error('Missing isolated preview configuration');
        }
        const url = config ? config.url : defaultURL;
        const key = config ? config.anonKey : defaultKey;
        const parsed = new URL(url);
        if (parsed.protocol !== 'https:' || !parsed.hostname.endsWith('.supabase.co') || !key) {
            throw new Error('Invalid public database configuration');
        }
        const client = window.supabase.createClient(url, key, { auth: {
            persistSession: false, autoRefreshToken: false, detectSessionInUrl: false
        } });
        const rpc = new BJDRpc.Client(client, {
            storage: localStorage, crypto: window.crypto, project: parsed.hostname
        });
        return Object.freeze({ client, rpc, project: parsed.hostname });
    }
    window.BJDPage = Object.freeze({ connect });
})();
