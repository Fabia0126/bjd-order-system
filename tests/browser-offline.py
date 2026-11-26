"""Synthetic browser checks. Every network request is intercepted."""
import asyncio
import json
from pathlib import Path
from urllib.parse import urlparse
from playwright.async_api import async_playwright

ROOT = Path(__file__).resolve().parent.parent
INIT = r"""
window.BJD_PUBLIC_CONFIG = {url:'https://fixture.supabase.co', anonKey:'fixture-public-only'};
window.__calls = [];
window.__xss = false;
window.__drop = false;
const fixtureFetch = window.fetch;
window.fetch = (input, options) => String(input).includes('open-meteo.com')
  ? Promise.resolve({ok:true,json:async()=>{throw Error('<img src=x onerror="window.__xss=true">');}})
  : fixtureFetch(input,options);
window.__fixtureClient = {
  from: () => {throw Error('Direct table access prohibited');},
  rpc: async (name, params) => {
    window.__calls.push({name, params:structuredClone(params)});
    if (name === 'campaign_status') return {data: {
      server_time:new Date().toISOString(), triple_open:true,
      campaign:{id:'fixture',open_at:new Date(Date.now()-1000).toISOString(),close_at:new Date(Date.now()+600000).toISOString()}
    }};
    if (name === 'submit_entry') {
      if (window.__drop) {window.__drop=false; throw Error('lost response');}
      return {data:{ok:true,entry_id:'11111111-1111-4111-8111-111111111111',
        status:params.p_pool === '三倍钞' ? 'reviewing' : 'received',price:190,
        received_at:new Date().toISOString(),replay:false}};
    }
    if (name === 'request_upload') return {data:{bucket:'reference-images',
      slots:Array.from({length:6},(_,i)=>'entries/11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222/'+(i+1)),
      max_bytes:5242880,mime:['image/png']}};
    if (name === 'attach_images') return {data:{ok:true,images:params.p_paths.length}};
    if (name === 'lookup_entry') return {data:{
      entry_id:'11111111-1111-4111-8111-111111111111',pool:'普',status:'received',price:190,
      received_at:new Date().toISOString(),payload:{xianyu_id:'<img src=x onerror="window.__xss=true">',
        doll_info:'</pre><script>window.__xss=true</script>',size:'3fen',makeup:'free'}
    }};
    throw Error('Unknown fixture RPC');
  },
  storage:{from: () => ({upload:async (path, file, options) => {
    window.__calls.push({name:'upload',path,options});
    return window.__occupied ? {error:{statusCode:409}} : {data:{path}};
  }})}
};
"""

async def main():
    checks = []
    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True)
        context = await browser.new_context()
        await context.add_init_script(INIT)
        async def route_handler(route):
            parsed = urlparse(route.request.url)
            target = (ROOT / parsed.path.lstrip('/')).resolve()
            if parsed.hostname == 'fixture.invalid' and target.is_relative_to(ROOT) and target.is_file():
                if target.name.startswith('supabase-js-'):
                    await route.fulfill(content_type='application/javascript',body='window.supabase={createClient:()=>window.__fixtureClient};')
                else:
                    await route.fulfill(path=str(target))
            else:
                await route.fulfill(status=404, body='Blocked by offline fixture')
        await context.route('**/*', route_handler)
        page = await context.new_page()
        page.on('dialog', lambda dialog: dialog.dismiss())
        for form in ['form.html', 'form-3x.html']:
            await page.goto('https://fixture.invalid/'+form)
            await page.wait_for_function('window.bjdSite && bjdForm.status !== null')
            for name, value in {'dollInfo':'<img src=x onerror="window.__xss=true">',
                 'xianyuId':'虚构单主','receiverName':'虚构姓名','contact1':'fictional-one',
                 'contact2':'fictional-two'}.items():
                await page.locator('[name="'+name+'"]').fill(value)
            await page.locator('#agreeNotice').check()
            await page.locator('#previewBtn').click()
            assert await page.locator('.preview-text img').count() == 0
            assert '<img' in await page.locator('.preview-text').inner_text()
            assert await page.locator('.preview-modal .btn-confirm').count() == 0
            assert await page.evaluate('window.__calls.filter(x=>x.name === "submit_entry").length') == 0
            await page.evaluate('closePreview()')
            await page.evaluate('Promise.all([handleSubmit({preventDefault(){}}),handleSubmit({preventDefault(){}})])')
            calls = await page.evaluate('window.__calls.filter(x=>x.name === "submit_entry")')
            assert len(calls) == 1
            assert len(calls[0]['params']['p_token']) == 43
            assert 'status' not in calls[0]['params']['p_payload']
            assert 'total_price' not in calls[0]['params']['p_payload']
            assert calls[0]['params']['p_pool'] == ('三倍钞' if form=='form-3x.html' else '普')
            assert await page.locator('#submissionReceipt input[readonly]').count() == 1
            assert not await page.evaluate('window.__xss')
            checks.append(form+': preview text, RPC-only, one submit, private credential')

        await page.goto('https://fixture.invalid/status.html')
        await page.locator('#searchInput').fill('a'*43)
        await page.locator('#queryButton').click()
        await page.wait_for_selector('.order-result')
        assert await page.locator('.order-result img,.order-result script,.resubmit-btn').count() == 0
        assert '<img' in await page.locator('.order-result').inner_text()
        assert not await page.evaluate('window.__xss')
        lookup = await page.evaluate('window.__calls.filter(x=>x.name === "lookup_entry")')
        assert lookup[-1]['params'] == {'p_token':'a'*43}
        assert 'token=' not in page.url
        checks.append('lookup: credential only, DOM text, no resubmit, no URL credential')

        await page.goto('https://fixture.invalid/form.html')
        await page.wait_for_function('bjdForm.status !== null')
        await page.evaluate('window.__drop=true')
        await page.evaluate("""bjdForm.submit({pool:'普',payload:{campaign_id:'fixture',size:'3fen',makeup:'free',
          xianyu_id:'虚构',receiver_name:'虚构',contact1:'fictional'}})""")
        first = await page.evaluate('window.__calls.find(x=>x.name === "submit_entry").params')
        await page.reload()
        await page.wait_for_function('bjdForm.status !== null')
        await page.get_by_role('button',name='恢复原投递',exact=True).click()
        await page.wait_for_selector('#submissionReceipt input[readonly]')
        second = await page.evaluate('window.__calls.find(x=>x.name === "submit_entry").params')
        assert first == second
        checks.append('lost response + reload: original ID, token and payload recovered')

        await page.goto('https://fixture.invalid/form.html')
        await page.wait_for_function('bjdForm.status !== null')
        await page.evaluate("""async () => {
          const r=await bjdSite.rpc.submit('普',{campaign_id:'fixture',size:'3fen',makeup:'free',xianyu_id:'虚构',contact1:'fictional',receiver_name:'虚构'});
          const f=new File([Uint8Array.from([137,80,78,71,13,10,26,10])],'fixture.png',{type:'image/png'});
          await bjdForm.uploadImages(r,[f]); await bjdForm.uploadImages(r,[f]);
        }""")
        names = await page.evaluate('window.__calls.map(x=>x.name)')
        assert names.count('request_upload') == names.count('upload') == names.count('attach_images') == 1
        upload = await page.evaluate('window.__calls.find(x=>x.name === "upload")')
        binding = await page.evaluate('window.__calls.find(x=>x.name === "attach_images")')
        slot = 'entries/11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222/1'
        assert upload['path'] == slot
        assert upload['options'] == {'upsert':False,'contentType':'image/png'}
        assert binding['params']['p_paths'] == [slot]
        checks.append('fixed slots: exact extensionless path, no overwrite, same binding reused')

        await page.goto('https://fixture.invalid/form.html')
        await page.wait_for_function('bjdForm.status !== null')
        rejected = await page.evaluate("""async () => {
          window.__occupied=true;
          const r=await bjdSite.rpc.submit('普',{campaign_id:'fixture',size:'3fen',makeup:'free',xianyu_id:'虚构占位',contact1:'fictional',receiver_name:'虚构'});
          const f=new File([Uint8Array.from([137,80,78,71,13,10,26,10])],'other.png',{type:'image/png'});
          try { await bjdForm.uploadImages(r,[f]); return false; } catch { return true; }
        }""")
        assert rejected
        assert await page.evaluate('window.__calls.filter(x=>x.name === "attach_images").length') == 0
        checks.append('occupied slot: ambiguous conflict never marked uploaded or bound')
        await page.goto('https://fixture.invalid/weather.html')
        await page.wait_for_selector('#weatherErrorDetail')
        assert '<img' in await page.locator('#weatherErrorDetail').inner_text()
        assert await page.locator('#weatherErrorDetail img').count() == 0
        assert not await page.evaluate('window.__xss')
        checks.append('weather error: untrusted error rendered as text')
        await browser.close()
    print(json.dumps({'synthetic_only':True,'real_network_requests':0,'checks':checks},ensure_ascii=False))

asyncio.run(main())
