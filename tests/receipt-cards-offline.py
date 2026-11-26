"""Cards, state badges, credential copying and supplement controls; synthetic only."""
import ast
import asyncio
import json
from pathlib import Path
from urllib.parse import urlparse
from playwright.async_api import async_playwright

ROOT=Path(__file__).resolve().parent.parent
tree=ast.parse((ROOT/'tests/browser-offline.py').read_text())
INIT=next(ast.literal_eval(n.value) for n in tree.body if isinstance(n,ast.Assign)
          and any(isinstance(t,ast.Name) and t.id=='INIT' for t in n.targets))
EXT=r"""
const key='bjd.submissions.v1.fixture.supabase.co';
if(!new URL(location.href).searchParams.has('empty')&&!localStorage.getItem(key)){
 localStorage.setItem(key,JSON.stringify(['a','b'].map((c,i)=>({
  requestId:'11111111-1111-4111-8111-11111111111'+i,token:c.repeat(43),pool:i?'钞':'普',campaignId:'1128',state:'confirmed',
  receipt:{ok:true,entry_id:'11111111-1111-4111-8111-111111111111',status:'received',price:190,received_at:'2026-11-28T13:00:01Z'}
 }))));
}
const originalRPC=__fixtureClient.rpc;
__fixtureClient.rpc=async(name,args)=>{
 if(name==='lookup_entry')return {data:{entry_id:'11111111-1111-4111-8111-111111111111',pool:'普',campaign_id:'1128',
  status:'won',order_status:'working',order_id:'BJD-fixture-001',price:190,received_at:'2026-11-28T13:00:01Z',
  payload:{xianyu_id:'虚构单主',doll_info:'<em>literal</em>'},...(window.__entry||{})}};
 return originalRPC(name,args);
};
Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async value=>{window.__copied=value;}}});
"""

async def main():
    checks=[]
    async with async_playwright() as p:
        browser=await p.chromium.launch(headless=True)
        for width in (320,390,600):
            context=await browser.new_context(viewport={'width':width,'height':844})
            await context.add_init_script(INIT+EXT)
            async def handle(route):
                u=urlparse(route.request.url);file=(ROOT/u.path.lstrip('/')).resolve()
                if u.hostname=='fixture.invalid' and file.is_relative_to(ROOT) and file.is_file():
                    if file.name.startswith('supabase-js-'):
                        return await route.fulfill(content_type='application/javascript',body='window.supabase={createClient:()=>window.__fixtureClient};')
                    return await route.fulfill(path=str(file))
                return await route.fulfill(status=404,body='offline')
            await context.route('**/*',handle)
            page=await context.new_page()
            await page.goto('https://fixture.invalid/status.html')
            assert await page.locator('#savedReceipts .record-item').count()==2
            assert await page.locator('select#savedReceipts').count()==0
            await page.locator('.record-item').filter(has_text='1128 · 普').click()
            await page.wait_for_selector('.order-result .status-working')
            assert await page.locator('.record-item.is-selected .status-working').count()==1
            assert await page.locator('.order-result em').count()==0
            assert await page.evaluate('document.documentElement.scrollWidth<=innerWidth')
            await page.reload()
            assert await page.locator('.record-item .status-working').count()==1
            if width==390:
                await page.locator('.record-item').filter(has_text='1128 · 普').click()
                await page.wait_for_selector('.order-result')
                await page.screenshot(path='/Users/claudelu/codex/work/bjd-status-cards-390.png',full_page=True)
                cases=[('reviewing',None,'pending','rgb(255, 243, 205)'),('won','approved','approved','rgb(212, 237, 218)'),
                       ('won','packing','packing','rgb(226, 213, 241)'),('won','completed','completed','rgb(209, 231, 221)'),
                       ('not_selected',None,'rejected','rgb(248, 215, 218)'),('received',None,'received','rgb(246, 232, 241)')]
                for status,order_status,tone,color in cases:
                    await page.evaluate('data=>window.__entry=data',{'status':status,'order_status':order_status})
                    await page.locator('#queryButton').click()
                    badge=page.locator('.order-result .status-'+tone)
                    await badge.wait_for()
                    assert await badge.evaluate('e=>getComputedStyle(e).backgroundColor')==color
            checks.append(str(width)+': local cards query once, refresh cached metadata, badges and no horizontal overflow')

            await page.goto('https://fixture.invalid/form.html')
            await page.wait_for_function('bjdForm.status !== null')
            await page.evaluate("bjdForm.submit({pool:'普',payload:{campaign_id:'fixture',size:'3fen',makeup:'free',xianyu_id:'虚构',receiver_name:'虚构',contact1:'fictional'}})")
            token=page.locator('#submissionReceipt textarea[readonly]')
            raw=await token.input_value()
            assert len(raw)==43
            await page.get_by_role('button',name='复制凭据',exact=True).click()
            assert await page.evaluate('window.__copied')==raw
            assert '已复制' in await page.locator('.copy-feedback').inner_text()
            assert '丢失无法找回' in await page.locator('.credential-warning').inner_text()
            file_input=page.locator('input[aria-label="选择待补传参考图"]')
            assert not await file_input.is_visible()
            async with page.expect_file_chooser() as chooser:
                await page.get_by_role('button',name='选择参考图',exact=True).click()
            picker=await chooser.value
            await picker.set_files([{'name':name,'mimeType':'image/png','buffer':bytes([137,80,78,71,13,10,26,10])} for name in ('one.png','two.png')])
            await page.get_by_role('button',name='补传参考图',exact=True).click()
            await page.wait_for_function("document.querySelector('.upload-status').textContent.includes('已绑定 2 张')",timeout=5000)
            assert '已绑定 2 张' in await page.locator('.upload-status').inner_text()
            assert await page.get_by_role('button',name='已完成绑定',exact=True).is_disabled()
            assert await page.evaluate('document.documentElement.scrollWidth<=innerWidth')
            if width==390:
                await page.locator('#submissionReceipt').screenshot(path='/Users/claudelu/codex/work/bjd-receipt-cards-390.png')
            checks.append(str(width)+': raw credential copied, custom file picker, bound count and no overflow')
            await page.evaluate('localStorage.clear()')
            await page.goto('https://fixture.invalid/status.html?empty=1')
            assert not await page.locator('#localReceipts').is_visible()
            await context.close()
        await browser.close()
    print(json.dumps({'synthetic_only':True,'real_network_requests':0,'checks':checks},ensure_ascii=False))

asyncio.run(main())
