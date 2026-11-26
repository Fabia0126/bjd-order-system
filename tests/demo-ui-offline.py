"""Demo labels on public form, receipt and status; synthetic only."""
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
const originalRPC=window.__fixtureClient.rpc;
window.__fixtureClient.rpc=async(name,args)=>{
 const r=await originalRPC(name,args);
 if(name==='campaign_status')r.data.campaign.demo=true;
 if(name==='submit_entry')r.data.demo=true;
 if(name==='lookup_entry'){r.data.demo=true;r.data.order_id='DEMO-fixture-001';r.data.status='won';r.data.order_status='approved';}
 return r;
};
"""

async def main():
    async with async_playwright() as p:
        browser=await p.chromium.launch(headless=True)
        context=await browser.new_context()
        await context.add_init_script(INIT+EXT)
        async def handle(route):
            parsed=urlparse(route.request.url);target=(ROOT/parsed.path.lstrip('/')).resolve()
            if parsed.hostname=='fixture.invalid' and target.is_relative_to(ROOT) and target.is_file():
                if target.name.startswith('supabase-js-'):
                    return await route.fulfill(content_type='application/javascript',body='window.supabase={createClient:()=>window.__fixtureClient};')
                return await route.fulfill(path=str(target))
            return await route.fulfill(status=404,body='offline')
        await context.route('**/*',handle)
        page=await context.new_page()
        await page.goto('https://fixture.invalid/form.html')
        await page.wait_for_function('bjdForm.status !== null')
        assert '演练批次' in await page.locator('#normalStatus').inner_text()
        assert '演练批次' in await page.locator('#countdownText').inner_text()
        await page.evaluate("""bjdForm.submit({pool:'普',payload:{campaign_id:'fixture',size:'3fen',makeup:'free',xianyu_id:'虚构',receiver_name:'虚构',contact1:'fictional'}})""")
        assert '演练投递回执' in await page.locator('#submissionReceipt h2').inner_text()
        assert '不生成BJD正式编号' in await page.locator('#submissionReceipt').inner_text()
        await page.goto('https://fixture.invalid/status.html')
        await page.locator('#searchInput').fill('a'*43)
        await page.locator('#queryButton').click()
        await page.wait_for_selector('.order-result')
        assert '演练' in await page.locator('.result-status').inner_text()
        assert await page.get_by_role('button',name='复制演练编号',exact=True).count()==1
        assert await page.get_by_role('button',name='复制正式编号',exact=True).count()==0
        assert '订单进度' not in await page.locator('.order-result').inner_text()
        await browser.close()
    print(json.dumps({'synthetic_only':True,'real_network_requests':0,'checks':['form_and_bottom_label','receipt_label','lookup_label_and_demo_copy_only']}))

asyncio.run(main())
