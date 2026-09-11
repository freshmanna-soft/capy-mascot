// Dev-only helper: launches the mascot via Playwright's Electron driver and
// grabs a screenshot, so its actual rendered output can be inspected without
// eyeballing the live floating window on the desktop.
const { _electron: electron } = require('playwright');
const path = require('node:path');

(async () => {
  const app = await electron.launch({ args: [path.join(__dirname)] });
  const win = await app.firstWindow();
  await win.waitForTimeout(1500); // let the entrance rise/reveal settle
  await win.screenshot({ path: path.join(__dirname, 'mascot-screenshot.png') });
  await app.close();
})();
