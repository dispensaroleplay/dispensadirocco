const sharp = require("sharp");
const path = require("path");
const fs = require("fs");

const logo = path.join("site", "assets", "logo.webp");
const out = path.join("site", "assets", "icons");
fs.mkdirSync(out, { recursive: true });

async function makeIcon(size, file, { maskable = false } = {}) {
  const pad = maskable ? Math.round(size * 0.18) : Math.round(size * 0.1);
  const inner = size - pad * 2;
  const bg = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}"><rect width="100%" height="100%" fill="#080705"/></svg>`
  );
  const circle = await sharp(logo).resize(inner, inner, { fit: "cover" }).png().toBuffer();
  await sharp(bg)
    .composite([{ input: circle, top: pad, left: pad }])
    .png()
    .toFile(path.join(out, file));
  console.log(file, (fs.statSync(path.join(out, file)).size / 1024).toFixed(1) + " KB");
}

(async () => {
  await makeIcon(192, "icon-192.png");
  await makeIcon(512, "icon-512.png");
  await makeIcon(512, "icon-maskable-512.png", { maskable: true });
  await makeIcon(180, "apple-touch-icon.png");
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
