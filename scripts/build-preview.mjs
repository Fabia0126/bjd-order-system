import fs from 'node:fs';

// Deliberately fails closed. Preview must never silently use production.
const testURL = 'https://pvtlmabvtvyuyuycwovc.supabase.co';
const target = process.env.BJD_DEPLOY_TARGET;
if (target !== 'test') throw new Error('This build command is for the isolated test preview only');
if (process.env.VERCEL_ENV === 'production') throw new Error('Refusing test configuration on production deployment');
const url = process.env.BJD_SUPABASE_URL;
const anonKey = process.env.BJD_SUPABASE_ANON_KEY;
if (url !== testURL || !anonKey) throw new Error('Missing designated isolated public configuration');
if (anonKey.startsWith('eyJ')) {
    const claims = JSON.parse(Buffer.from(anonKey.split('.')[1], 'base64url').toString());
    if (claims.role !== 'anon') throw new Error('Refusing privileged frontend credential');
} else if (!anonKey.startsWith('sb_publishable_')) throw new Error('Refusing unknown credential type');
fs.writeFileSync(new URL('../runtime-config.js', import.meta.url),
    'window.BJD_PUBLIC_CONFIG = ' + JSON.stringify({ url, anonKey }) + ';\n');
console.log('Isolated public runtime configuration generated; credential values omitted.');
