import { chromium } from 'playwright-core';
const b = await chromium.launch({
  executablePath: '/root/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome',
  args: ['--no-sandbox'],
});
for (const p of ['index','admin','gallery','paste','share','preview','webdav','login']) {
  const ctx = await b.newContext({viewport:{width:390,height:844}});
  const pg = await ctx.newPage();
  await pg.goto('http://127.0.0.1:8788/'+p+'.html',{waitUntil:'load'});
  await pg.waitForTimeout(1000);
  const r = await pg.evaluate(()=>{
    const t = document.querySelector('.theme-admin-toggle, .theme-auto-inline-toggle');
    const parent = t ? t.parentElement : null;
    return {
      toggle: t ? t.className : 'none',
      parentCls: parent ? parent.className : 'none',
      inHeaderContent: !!(t && t.closest('.header-content')),
      faLoaded: [...document.fonts].some(f=>/Font Awesome/i.test(f.family)),
    };
  });
  console.log(p.padEnd(9), 'toggle='+r.toggle.padEnd(28), 'parent='+r.parentCls.padEnd(18), 'inHeaderContent='+r.inHeaderContent, 'FA='+r.faLoaded);
  await ctx.close();
}
await b.close();
