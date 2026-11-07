const { chromium } = require('/opt/node-tools/node_modules/playwright');
(async () => {
  const b = await chromium.launch({ args: ['--use-gl=swiftshader','--enable-unsafe-swiftshader','--no-sandbox'] });
  const pg = await b.newPage({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 });
  pg.on('pageerror', e => console.log('ERR', e.message));
  await pg.goto('http://localhost:4173/?debug', { waitUntil: 'load' });
  await pg.waitForTimeout(5000);
  await pg.addStyleTag({ content: 'body > *:not(canvas){visibility:hidden !important}' });
  await pg.evaluate(() => window.__game.setZoom(1.5));
  const want = [['boss',6],['crypt',4],['ruin',1]];
  for (const [n,id] of want) {
    await pg.evaluate((id) => { const g = window.__game; const r = g.dungeon.rooms[id]; g.p.x = r.center.x + 3; g.p.z = r.center.z + 3; }, id);
    await pg.waitForTimeout(3500);
    await pg.screenshot({ path: `mixamo/level/${n}.png` });
  }
  await b.close();
})();
