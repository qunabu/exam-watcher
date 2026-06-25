const { chromium } = require('playwright');
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36';
const log = (...a) => console.log(new Date().toISOString().slice(11,19), ...a);

(async () => {
  const b = await chromium.launch({ headless: true, args: ['--no-sandbox','--disable-dev-shm-usage'] });
  const ctx = await b.newContext({ storageState: process.env.STORAGE_STATE, userAgent: UA });
  const page = await ctx.newPage();
  page.on('framenavigated', (f) => { if (f === page.mainFrame()) log('  → nav:', f.url().slice(0,90)); });

  log('goto /reservation');
  await page.goto('https://info-kierowca.pl/reservation', { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(e=>log('goto err',e.message));
  await page.waitForTimeout(3000);
  log('landed at:', page.url());

  if (!/\/login|\/logged-out/.test(page.url())) { log('STILL LOGGED IN — portal session alive'); await b.close(); return; }

  // Dump the interactive controls on the login page so we see the real login button
  const controls = await page.evaluate(() =>
    [...document.querySelectorAll('a,button,[role=button]')]
      .map(e => ({ tag:e.tagName, text:(e.textContent||'').trim().slice(0,40), href:e.getAttribute('href')||'' }))
      .filter(c => c.text || c.href).slice(0,30));
  log('login-page controls:'); controls.forEach(c => log('   ', JSON.stringify(c)));

  // Click the login.gov.pl method CARD specifically (not the generic button)
  const target = await page.evaluate(() => {
    const cards = [...document.querySelectorAll('mat-card,[class*=card],a,button')];
    const m = cards.find(e => /login\.gov\.pl/i.test(e.textContent||'') && !/edo/i.test(e.textContent||''));
    if (m) { m.scrollIntoView(); m.click(); return (m.textContent||'').trim().slice(0,50); }
    return null;
  });
  log('clicked login.gov.pl card:', target);

  for (let i=0;i<10;i++){ await page.waitForTimeout(2000); }  // let redirect chain settle (~20s)
  log('FINAL url:', page.url());
  log('logged back in?', !/\/login|\/logged-out/.test(page.url()) && /info-kierowca\.pl/.test(page.url()));
  // Dump what the IdP page is asking for
  const info = await page.evaluate(() => ({
    title: document.title,
    h: [...document.querySelectorAll('h1,h2,h3')].map(e=>e.textContent.trim()).filter(Boolean).slice(0,6),
    bodyText: (document.body.innerText||'').replace(/\s+/g,' ').slice(0,500),
    controls: [...document.querySelectorAll('a,button,[role=button],input[type=submit]')].map(e=>(e.textContent||e.value||'').trim()).filter(Boolean).slice(0,25),
  }));
  log('IdP title:', info.title);
  log('IdP headings:', JSON.stringify(info.h));
  log('IdP controls:', JSON.stringify(info.controls));
  log('IdP body:', info.bodyText);
  await b.close();
})();
