#!/usr/bin/env node
// Offscreen Electron rasterizer for the app icon pipeline: loads a
// self-contained render page (defines window.RENDER() -> { name: base64Png })
// in a hidden, CSP-bypassing window, executes it, writes the result JSON,
// and quits. Usage:
//   electron scripts/render-icon-electron.cjs <render.html> <out.json>
"use strict";
const { app, BrowserWindow } = require("electron");
const fs = require("fs");

// Offscreen GPU readback paints CSS/SVG gradients black in toDataURL — force
// software rasterization or every gradient-based icon comes out black.
app.disableHardwareAcceleration();

const [htmlPath, outPath] = process.argv.slice(2);
if (!htmlPath || !outPath) {
  console.error("usage: electron render-icon-electron.cjs <render.html> <out.json>");
  process.exit(2);
}

app.whenReady().then(async () => {
  try {
    const win = new BrowserWindow({
      show: false,
      width: 1100,
      height: 1100,
      useContentSize: true,
      webPreferences: {
        offscreen: true,
        bypassCSP: true,
        backgroundThrottling: false,
      },
    });
    await win.loadFile(htmlPath);
    const result = await win.webContents.executeJavaScript("window.RENDER()", true);
    fs.writeFileSync(outPath, JSON.stringify(result));
    console.log("rendered ->", outPath);
    app.quit();
  } catch (err) {
    console.error(err.message || err);
    app.exit(1);
  }
});
