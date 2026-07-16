/**
 * Icon pipeline for Apex Debug Studio.
 * Renders build/logo.svg ONCE at 1024px via Electron, then downscales with `sips`
 * and assembles build/icon.icns (iconutil), build/icon.ico, and the in-app
 * logo-large / Icon PNGs. Re-run after editing build/logo.svg to refresh all assets.
 * Run: ./node_modules/.bin/electron tools/gen-icons.js
 */
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const SVG = fs.readFileSync(path.join(ROOT, 'build', 'logo.svg'), 'utf8');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ads-icons-'));
const MASTER = path.join(TMP, 'master-1024.png');

function renderMaster() {
  return new Promise((resolve, reject) => {
    const win = new BrowserWindow({
      width: 1024,
      height: 1024,
      useContentSize: true,
      show: false,
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      webPreferences: { offscreen: false },
    });
    const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
      html,body{margin:0;padding:0;background:transparent;width:1024px;height:1024px;overflow:hidden}
      svg{display:block}
    </style></head><body>${SVG}</body></html>`;
    win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
    win.webContents.once('did-finish-load', () => {
      setTimeout(async () => {
        try {
          const img = await win.webContents.capturePage();
          fs.writeFileSync(MASTER, img.toPNG());
          win.destroy();
          resolve();
        } catch (e) { win.destroy(); reject(e); }
      }, 350);
    });
  });
}

function resize(size, out) {
  execSync(`sips -s format png -z ${size} ${size} "${MASTER}" --out "${out}" >/dev/null 2>&1`);
  return fs.readFileSync(out);
}

// Minimal ICO packer (embeds PNG frames).
function buildIco(frames) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(frames.length, 4);
  const dir = Buffer.alloc(16 * frames.length);
  let offset = 6 + dir.length;
  const bodies = [];
  frames.forEach((f, i) => {
    const b = i * 16;
    dir.writeUInt8(f.size >= 256 ? 0 : f.size, b + 0);
    dir.writeUInt8(f.size >= 256 ? 0 : f.size, b + 1);
    dir.writeUInt8(0, b + 2);
    dir.writeUInt8(0, b + 3);
    dir.writeUInt16LE(1, b + 4);
    dir.writeUInt16LE(32, b + 6);
    dir.writeUInt32LE(f.png.length, b + 8);
    dir.writeUInt32LE(offset, b + 12);
    offset += f.png.length;
    bodies.push(f.png);
  });
  return Buffer.concat([header, dir, ...bodies]);
}

app.whenReady().then(async () => {
  await renderMaster();
  console.log('master rendered');

  const sizes = [16, 32, 48, 64, 128, 256, 512, 1024];
  const pngs = {};
  for (const s of sizes) pngs[s] = resize(s, path.join(TMP, `s${s}.png`));
  console.log('downscaled');

  // Welcome logo + app PNGs
  fs.copyFileSync(path.join(ROOT, 'build', 'logo.svg'), path.join(ROOT, 'src', 'renderer', 'logo-large.svg'));
  fs.writeFileSync(path.join(ROOT, 'src', 'renderer', 'logo-large.png'), pngs[512]);
  fs.writeFileSync(path.join(ROOT, 'src', 'renderer', 'Icon.png'), pngs[512]);
  fs.writeFileSync(path.join(ROOT, 'build', 'Icon.png'), pngs[512]);
  fs.writeFileSync(path.join(ROOT, 'build', 'preview.png'), pngs[256]);

  // .icns via iconutil
  const isDir = path.join(ROOT, 'build', 'icon.iconset');
  fs.rmSync(isDir, { recursive: true, force: true });
  fs.mkdirSync(isDir, { recursive: true });
  const map = {
    'icon_16x16.png': 16, 'icon_16x16@2x.png': 32,
    'icon_32x32.png': 32, 'icon_32x32@2x.png': 64,
    'icon_128x128.png': 128, 'icon_128x128@2x.png': 256,
    'icon_256x256.png': 256, 'icon_256x256@2x.png': 512,
    'icon_512x512.png': 512, 'icon_512x512@2x.png': 1024,
  };
  for (const [name, s] of Object.entries(map)) fs.writeFileSync(path.join(isDir, name), pngs[s]);
  try {
    execSync(`iconutil -c icns "${isDir}" -o "${path.join(ROOT, 'build', 'icon.icns')}"`);
    console.log('icns OK');
  } catch (e) { console.error('iconutil failed', e.message); }

  // .ico
  const icoSizes = [16, 32, 48, 64, 128, 256];
  const ico = buildIco(icoSizes.map((s) => ({ size: s, png: pngs[s] })));
  fs.writeFileSync(path.join(ROOT, 'build', 'icon.ico'), ico);
  console.log('ico OK');

  fs.rmSync(isDir, { recursive: true, force: true });
  fs.rmSync(TMP, { recursive: true, force: true });
  console.log('DONE');
  app.quit();
}).catch((e) => { console.error(e); app.quit(); });
