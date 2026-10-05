// 고정 버전 자산의 SHA-256 검사. 복구 시에만 --download를 명시한다.
const fs = require("node:fs/promises");
const path = require("node:path");
const { createHash } = require("node:crypto");
const base = path.resolve(__dirname, "../public/vendor/hwp-v0.2.2");
const release = "https://github.com/sanguneo/rhwptopdf/releases/download/v0.2.2/";
const source = "https://raw.githubusercontent.com/sanguneo/rhwptopdf/v0.2.2/";
const fonts = "https://raw.githubusercontent.com/google/fonts/main/ofl/";
const assets = [
  ["rhwptopdf.umd.js", release + "rhwptopdf.umd.js", "7913400eae742e9f15f320fc377d5961a63216840f290a4c280fbe731ec3c0cd"],
  ["rhwptopdf.umd_bg.wasm", release + "rhwptopdf.umd_bg.wasm", "7a3e1e3e3a8d2a5bea64feac7bd8a2b556687a70874003fcf2aa6677e92f83a7"],
  ["LICENSE.txt", source + "LICENSE", "c7d8aba61d93cb269c9d1bb5870bb27e83c8a5d8b857567bb37dd0d237d8ec19"],
  ["NOTICE.txt", source + "NOTICE", "c7e2abb77931d36d535db700917213279bc1f5755c01b759473d2419778123b1"],
  ["NanumGothic-Regular.ttf", fonts + "nanumgothic/NanumGothic-Regular.ttf", "76f45ef4a6bcff344c837c95a7dcc26e017e38b5846d5ae0cdcb5b86be2e2d31"],
  ["NanumGothic-OFL.txt", fonts + "nanumgothic/OFL.txt", "eeacf16032901d0ed0456876ec77b8f0fda6b3fecec7d972f8543eb602e6c30f"],
  ["NanumMyeongjo-Regular.ttf", fonts + "nanummyeongjo/NanumMyeongjo-Regular.ttf", "7ed9e8653a8ed04285d51dc343ffea6eb3d9c73afc27383ea8929ee4ffd03205"],
  ["NanumMyeongjo-OFL.txt", fonts + "nanummyeongjo/OFL.txt", "8eb1c1019fe7fe6d0b6e7d7bbbba1d9cbdd969d8c5f26455708f6cfb8a77284c"]
];
async function main() {
  let total = 0;
  for (const [name, url, expected] of assets) {
    let bytes;
    if (process.argv.includes("--download")) {
      const response = await fetch(url, { signal: AbortSignal.timeout(60000) });
      if (!response.ok) throw new Error(`${name}: HTTP ${response.status}`);
      bytes = Buffer.from(await response.arrayBuffer());
    } else bytes = await fs.readFile(path.join(base, name));
    if (createHash("sha256").update(bytes).digest("hex") !== expected) throw new Error(`${name}: SHA-256 mismatch; asset was not written`);
    if (process.argv.includes("--download")) { await fs.mkdir(base, { recursive: true }); await fs.writeFile(path.join(base, name), bytes); }
    total += bytes.length;
  }
  console.log(`Verified ${assets.length} HWP assets: ${total} bytes`);
}
if (require.main === module) main().catch((e) => { console.error(e.message); process.exitCode = 1; });
module.exports = { assets };
