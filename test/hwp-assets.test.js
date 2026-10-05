const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { assets } = require("../tools/hwp-assets.cjs");
test("배포할 HWP 엔진·글꼴·라이선스는 검증한 버전 그대로다", () => {
  for (const [name, , sha] of assets) {
    const bytes = fs.readFileSync(path.join(__dirname, "../public/vendor/hwp-v0.2.2", name));
    assert.equal(createHash("sha256").update(bytes).digest("hex"), sha, name);
  }
});
