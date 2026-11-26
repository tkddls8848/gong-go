# 관심사업 추적 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 본공고·사전공고를 관심사업으로 저장하고, 재공고·수의계약까지 이어 그 사업의 현재 단계·일정·개찰결과(유찰사유, 업체별 순위·금액·평가점수)를 한 화면에서 확인한다.

**Architecture:** 새 Worker 경로 `GET /api/business-status`(`src/business-status.js`)가 계약과정통합공개서비스로 같은 사업의 공고 사슬을 찾고 낙찰정보서비스로 개찰결과를 받아 정규화 JSON으로 돌려준다. 브라우저 모듈 `public/tracked.js`가 관심사업을 localStorage에 두고, 조회 대상만 골라 그 경로를 부르고, 목록·상세 HTML을 만든다. `public/app.js`는 레일 항목·저장 토글·보기 전환만 조립한다.

**Tech Stack:** Cloudflare Worker(ESM, `src/`), 브라우저 IIFE 모듈(CJS로도 require 가능, `public/`), `node --test`, Playwright 스모크(`tools/browser-smoke.cjs`).

**Spec:** `docs/superpowers/specs/2026-11-26-favorite-notices-design.md`

## Global Constraints

- 새 dependency 없음. 최상위 모듈(src, public 등) 사이 런타임 import 없음.
- `public/`은 전부 배포된다 — 테스트는 `test/`, Worker 테스트는 `src/` 옆.
- 사용자에게 내부 오류·스택·상류 원문을 보이지 않는다. 실패를 성공·"개찰 전"·"재공고 없음"으로 보이지 않는다.
- 상류 문자열(공고명·업체명·사유)은 화면에 넣기 전에 반드시 `html()`로 이스케이프한다.
- 상류 경로: 통합공개 `/1230000/ao/CntrctProcssIntgOpenService/getCntrctProcssIntgOpen{Thng|Frgcpt|Servc|Cnstwk}`, 낙찰정보 `/1230000/as/ScsbidInfoService/…`. 원점 `https://apis.data.go.kr`, 키는 `env.DATA_GO_KR_SERVICE_KEY`, `type=json`.
- 통합공개 `inqryDiv`: 1=`bidNtceNo`, 2=`bfSpecRgstNo`, 3=`orderPlanNo`. 낙찰정보 업무구분별 목록은 `inqryDiv=4`+`bidNtceNo`.
- 요청당 상류 호출 상한 `MAX_UPSTREAM_CALLS = 40`(무료 Worker subrequest 50 미만).
- localStorage 키 `gong-go:tracked-businesses`, 값 `{ version: 1, items: [...] }`.
- 저장 진입점은 본공고(`mode: "bid"`)·사전공고(`mode: "pre"`) 행만. 발주계획 없음.
- main 푸시 = 운영 배포. 작업은 브랜치 `feature/tracked-businesses`에서 하고 main에 푸시하지 않는다.

## Review Focus

1. 상류 `body.items`가 배열이 아니라 단건 객체·`{ item: … }`·빈 문자열로 온다 → 행 배열로 읽혀야 한다(Task 1 `readItems` 테스트).
2. 서비스 키 미승인: 상류가 HTTP 200에 XML(`SERVICE_KEY_IS_NOT_REGISTERED_ERROR`)이나 `resultCode` "30"을 준다 → `not_authorized` 오류여야 하고 빈 결과가 되면 안 된다(Task 2 테스트).
3. localStorage에 깨진 JSON·다른 version·필드가 빠진 항목 → 던지지 않고 빈 목록이나 유효 항목만으로 시작한다(Task 3 테스트).
4. 참가업체 수백 곳(469곳 실제 확인) → 업체 페이지를 상한까지만 받고 `biddersTruncated: true`, 화면에 "상위 N곳만 표시"(Task 2·4 테스트).
5. 사전공고로 저장한 사업의 본공고 행을 또 누른다 → 새 항목이 아니라 이미 저장된 사업으로 본다(마지막 결과의 공고 목록에 그 번호가 있으면)(Task 3 테스트).

---

### Task 1: 상류 응답 정규화 (모델 호출·네트워크 없음)

**Files:**
- Create: `src/business-status-normalize.js`
- Test: `src/business-status-normalize.test.mjs`
- Also: `docs/superpowers/specs/2026-11-26-favorite-notices-design.md`를 이 브랜치 첫 커밋에 함께 넣는다.

**Interfaces:**
- Produces (모두 named export):
  - `readItems(json) -> object[]` — `json.response.body.items`가 배열/단건 객체/`{ item: 배열|객체 }`/빈 값이면 각각 배열로. `resultCode`가 `"00"`이 아니면 `UpstreamError`를 던진다.
  - `class UpstreamError extends Error { code: "not_authorized" | "upstream" }` — `resultCode` "30"·"31"·"32"·"20" 또는 본문 텍스트에 `SERVICE_KEY`/`Unauthorized`/`NOT_REGISTERED`가 있으면 `not_authorized`, 나머지 `upstream`.
  - `readUpstream(response: Response) -> Promise<object[]>` — `response.ok`가 아니거나 JSON이 아니면(XML 포함) 위 규칙으로 `UpstreamError`.
  - `num(value) -> number|null` — `""`·공백·숫자 아님 → `null`.
  - `noticeState(progrsDivCdNm) -> "opened"|"failed"|"rebid"|"other"` — `개찰완료`/`유찰`/`재입찰`.
  - `chainNotices(rows, max = 8) -> NoticeSummary[]` — 통합공개 행에서 `bidNtceNo`가 빈 행은 버리고, 같은 번호는 가장 큰 `bidNtceOrd`만, `bidNtceDt` 오름차순, 최근 `max`건.
    `NoticeSummary = { bidNtceNo, ord, title, postedAt, method, bidMethod, state: "before", stateLabel: "", openedAt: "", reason: "", winners }` (`method`=`cntrctCnclsMthdNm`, `bidMethod`=`bidMthdNm`, `title`=`bidNtceNm`).
  - `parseWinners(text) -> { rank, name, bizno, amount, rate }[]` — `"[1^모아맘보육재단^2208264545^김광자^830575896^97.001^1^2026-11-23 12:30:00]"` 형식. 여러 건은 `][`/`],[` 구분 모두 허용. 필드 수가 6 미만인 조각은 버린다.
  - `bidders(rows) -> Bidder[]` — 개찰완료 행을 `opengRank` 오름차순으로. `Bidder = { rank, name, bizno, amount, rate, remark, techScore, priceScore, totalScore }` (`prcbdrNm`, `prcbdrBizno`, `bidprcAmt`, `bidprcrt`, `rmrk`, `techEvlVal`, `bidPrceEvlVal`, `totalEvlAmtVal`; 수치는 `num`).

- [ ] **Step 1: 브랜치를 만든다**

Run: `git switch -c feature/tracked-businesses`
Expected: `Switched to a new branch 'feature/tracked-businesses'`

- [ ] **Step 2: 실패하는 테스트를 쓴다** — 설계 문서의 실제 표본을 그대로 쓴다.

```js
import assert from "node:assert/strict";
import test from "node:test";
import { readItems, readUpstream, UpstreamError, num, noticeState, chainNotices, parseWinners, bidders } from "./business-status-normalize.js";

const wrap = (items, resultCode = "00") => ({ response: { header: { resultCode, resultMsg: "정상" }, body: { items, totalCount: 1 } } });

test("items가 배열·단건·item 감싸기·빈 값이어도 행 배열로 읽는다", () => {
  const row = { bidNtceNo: "R26BK01832601" };
  assert.deepEqual(readItems(wrap([row])), [row]);
  assert.deepEqual(readItems(wrap(row)), [row]);
  assert.deepEqual(readItems(wrap({ item: row })), [row]);
  assert.deepEqual(readItems(wrap({ item: [row, row] })), [row, row]);
  assert.deepEqual(readItems(wrap("")), []);
  assert.deepEqual(readItems({ response: { header: { resultCode: "00" }, body: { totalCount: 0 } } }), []);
});

test("키 미승인은 not_authorized, 그 밖의 상류 실패는 upstream이다", async () => {
  assert.throws(() => readItems(wrap([], "30")), (e) => e instanceof UpstreamError && e.code === "not_authorized");
  assert.throws(() => readItems(wrap([], "99")), (e) => e.code === "upstream");
  const xml = new Response("<OpenAPI_ServiceResponse><cmmMsgHeader><returnAuthMsg>SERVICE_KEY_IS_NOT_REGISTERED_ERROR</returnAuthMsg></cmmMsgHeader></OpenAPI_ServiceResponse>", { status: 200 });
  await assert.rejects(readUpstream(xml), (e) => e.code === "not_authorized");
  await assert.rejects(readUpstream(new Response("Unauthorized", { status: 401 })), (e) => e.code === "not_authorized");
  await assert.rejects(readUpstream(new Response("busy", { status: 503 })), (e) => e.code === "upstream");
});

test("사전규격 사슬은 공고일 순으로 1차·재공고·수의계약을 낸다", () => {
  const rows = [
    { bidNtceNo: "R26BK01779016", bidNtceOrd: "000", bidNtceNm: "직장어린이집", bidNtceDt: "2026-10-19 16:23:29", cntrctCnclsMthdNm: "일반경쟁", bidMthdNm: "전자입찰", bidwinrInfoList: "" },
    { bidNtceNo: "R26BK01756351", bidNtceOrd: "000", bidNtceNm: "직장어린이집", bidNtceDt: "2026-10-07 07:06:18", cntrctCnclsMthdNm: "일반경쟁", bidMthdNm: "전자입찰", bidwinrInfoList: "" },
    { bidNtceNo: "R26BK01847773", bidNtceOrd: "000", bidNtceNm: "직장어린이집", bidNtceDt: "2026-11-23 10:56:31", cntrctCnclsMthdNm: "수의계약", bidMthdNm: "전자시담", bidwinrInfoList: "[1^모아맘보육재단^2208264545^김광자^830575896^97.001^1^2026-11-23 12:30:00]" },
    { bidNtceNo: "", bidNtceOrd: "", bidNtceDt: "" },
  ];
  const notices = chainNotices(rows);
  assert.deepEqual(notices.map((n) => n.bidNtceNo), ["R26BK01756351", "R26BK01779016", "R26BK01847773"]);
  assert.equal(notices[2].method, "수의계약");
  assert.deepEqual(notices[2].winners, [{ rank: 1, name: "모아맘보육재단", bizno: "2208264545", amount: 830575896, rate: 97.001 }]);
});

test("정정 차수는 가장 큰 차수 한 건만 남는다", () => {
  const base = { bidNtceNo: "R26BK01410643", bidNtceNm: "i-League", cntrctCnclsMthdNm: "일반경쟁" };
  const notices = chainNotices([{ ...base, bidNtceOrd: "000", bidNtceDt: "2026-03-20 13:59:00" }, { ...base, bidNtceOrd: "001", bidNtceDt: "2026-03-23 16:31:57" }]);
  assert.equal(notices.length, 1);
  assert.equal(notices[0].ord, "001");
});

test("협상 계약은 점수, 적격심사류는 금액·투찰률을 숫자로 읽는다", () => {
  const negotiated = bidders([
    { opengRank: "2", prcbdrNm: "주식회사 넷마루", prcbdrBizno: "4948601095", bidprcAmt: "", bidprcrt: "", rmrk: "정상", techEvlVal: "82.0667", bidPrceEvlVal: "10", totalEvlAmtVal: "92.0667" },
    { opengRank: "1", prcbdrNm: "(주)휴넷", prcbdrBizno: "2148638356", bidprcAmt: "", bidprcrt: "", rmrk: "정상", techEvlVal: "83.7333", bidPrceEvlVal: "9.9366", totalEvlAmtVal: "93.6699" },
  ]);
  assert.deepEqual(negotiated[0], { rank: 1, name: "(주)휴넷", bizno: "2148638356", amount: null, rate: null, remark: "정상", techScore: 83.7333, priceScore: 9.9366, totalScore: 93.6699 });
  const priced = bidders([{ opengRank: "1", prcbdrNm: "주식회사 에스엔에스", prcbdrBizno: "5228801128", bidprcAmt: "72915000", bidprcrt: "88.27", rmrk: "정상", techEvlVal: "", bidPrceEvlVal: "", totalEvlAmtVal: "" }]);
  assert.equal(priced[0].amount, 72915000);
  assert.equal(priced[0].rate, 88.27);
  assert.equal(priced[0].totalScore, null);
});

test("진행 구분과 낙찰자 목록을 방어적으로 읽는다", () => {
  assert.equal(noticeState("개찰완료"), "opened");
  assert.equal(noticeState("유찰"), "failed");
  assert.equal(noticeState("재입찰"), "rebid");
  assert.equal(noticeState("기타"), "other");
  assert.equal(parseWinners("").length, 0);
  assert.equal(parseWinners("[1^A^1^C^100^90.1^1^x],[2^B^2^D^200^91^1^y]").length, 2);
  assert.equal(parseWinners("[1^A^2]").length, 0);
  assert.equal(num(" "), null);
  assert.equal(num("12.5"), 12.5);
});
```

- [ ] **Step 3: 실패를 확인한다**

Run: `npm test -- src/business-status-normalize.test.mjs`
Expected: FAIL — `Cannot find module` (파일 없음)

- [ ] **Step 4: `src/business-status-normalize.js`를 구현한다** — 위 Interfaces의 함수를 그대로 export. 외부 import 없음.

- [ ] **Step 5: 통과를 확인한다**

Run: `npm test -- src/business-status-normalize.test.mjs`
Expected: PASS (6 tests)

- [ ] **Step 6: 커밋**

```bash
git add docs/superpowers/specs/2026-11-26-favorite-notices-design.md src/business-status-normalize.js src/business-status-normalize.test.mjs
git commit -m "관심사업 추적: 낙찰정보·계약과정 응답을 정규화한다"
```

---

### Task 2: Worker 경로 `/api/business-status`

**Files:**
- Create: `src/business-status.js`
- Modify: `src/worker.js` (상수 `BUSINESS_STATUS_PATH = "/api/business-status"`, `routeRequest`에서 `LIVE_PATH` 바로 아래에 라우팅 — 게이트 뒤)
- Test: `src/business-status.test.mjs`, `src/worker.test.mjs`(게이트 확인 1건 추가)

**Interfaces:**
- Consumes: Task 1의 모든 export.
- Produces: `export async function handleBusinessStatus(request, env, url, context) -> Response`
  - 405(GET 외, `Allow: GET`), 501(키 없음, 메시지는 `handleLive`와 같은 형식), 400(입력 오류).
  - 입력: `bidNtceNo`·`specNo`·`planNo`는 `/^[A-Z0-9]{8,20}$/`, 둘 중 하나(`bidNtceNo` 또는 `specNo`) 필수. `businessType` ∈ `물품|외자|용역|공사`(선택).
  - 200 본문:
    ```
    { businessType: string, chainKey: { kind: "spec"|"plan", no } | null, stage: "spec"|"bid",
      notices: NoticeSummary[], current: Current | null, partial: "" | "chain" | "limit" }
    Current = NoticeSummary & { participants: number|null, notice: string, bidders: Bidder[], biddersTruncated: boolean }
    ```
  - 오류 본문: `{ code: "not_authorized" | "upstream", message }`, HTTP 502. 메시지(정확히): not_authorized → `"낙찰·계약과정 조회 권한이 없습니다. 서비스 키의 활용신청을 확인하세요."`, upstream → `"공고 진행 정보를 확인하지 못했습니다. 잠시 뒤 다시 확인하세요."`
  - 상수: `MAX_UPSTREAM_CALLS = 40`, `MAX_CHAIN_NOTICES = 8`, `BIDDER_PAGE_SIZE = 100`, `MAX_BIDDER_PAGES = 3`, 업무구분 탐색 순서 = 받은 값 → `용역, 물품, 공사, 외자`, 캐시 5분(`handleLive`와 같은 방식: 성공만 `caches.default`, 키는 검증된 인자만 정해진 순서, 응답은 `Cache-Control: no-store`).

처리 순서(설계 문서 "Worker" 절):
1. `specNo`가 없고 `planNo`도 없으면 통합공개 `inqryDiv=1`로 업무구분을 탐색(첫 적중에서 멈춤) → `bfSpecRgstNo`·`orderPlanNo`. 모든 업무구분이 0건이면 `businessType: ""`, `chainKey: null`, 공고 목록은 저장 공고 한 건(`state: "before"`).
2. 연결 키가 있으면 `inqryDiv=2`(spec 우선) 또는 `3`으로 사슬 조회(업무구분을 모르면 여기서도 탐색). 이 단계만 실패하면 저장 공고 하나로 계속하고 `partial: "chain"`.
3. `chainNotices`로 정리. 공고가 없고 `specNo`로 불렀으면 `stage: "spec"`, `current: null`.
4. 각 공고에 낙찰정보 업무구분별 목록(`inqryDiv=4`) 1회 → 행이 없으면 `before`, 있으면 가장 큰 `rbidNo` 행으로 `state`·`stateLabel`·`openedAt`(=`opengDt`)·`reason`(=`opengRsltNtcCntnts`).
5. 현재 공고(마지막)만 추가 조회: `failed` → `getOpengResultListInfoFailing`(`bidClsfcNo`는 4의 행 값)으로 `reason`=`nobidRsn`; `opened` → `getOpengResultListInfoOpengCompt`를 `MAX_BIDDER_PAGES`까지(`totalCount`보다 적게 받으면 `biddersTruncated: true`); `rebid` → `getOpengResultListInfoRebid`의 `rbidRsn`. `participants`=`prtcptCnum`.
6. 호출 수가 상한에 닿으면 더 부르지 않고 지금까지로 응답하며 `partial: "limit"`.
7. 1단계·4단계·5단계의 `UpstreamError`는 오류 응답(위 본문). 2단계만 예외적으로 부분 성공.

- [ ] **Step 1: 실패하는 테스트를 쓴다** — `src/business-status.test.mjs`. 상류는 URL의 오퍼레이션 이름·인자로 분기하는 `globalThis.fetch` 스텁(worker.test.mjs의 `stubFetch` 방식을 이 파일에 복사). `caches`는 정의하지 않는다(캐시 없이 동작해야 함).

```js
test("사전규격 사슬을 따라 수의계약 공고를 현재 공고로 삼는다", async (t) => {
  // 스텁: 통합공개 Servc inqryDiv=2&bfSpecRgstNo=R26BD00278954 → Task 1의 세 행
  //       낙찰정보 OpengResultListInfoServc inqryDiv=4: 756351·779016 → 유찰 행, 847773 → 개찰완료 행
  //       OpengCompt bidNtceNo=R26BK01847773 → 1행(모아맘보육재단, 830575896, 97.001)
  const body = await call(t, "/api/business-status?specNo=R26BD00278954&businessType=%EC%9A%A9%EC%97%AD");
  assert.equal(body.stage, "bid");
  assert.deepEqual(body.chainKey, { kind: "spec", no: "R26BD00278954" });
  assert.deepEqual(body.notices.map((n) => n.state), ["failed", "failed", "opened"]);
  assert.equal(body.current.bidNtceNo, "R26BK01847773");
  assert.equal(body.current.bidders[0].name, "모아맘보육재단");
  assert.equal(body.partial, "");
});

test("업무구분을 모르면 첫 적중에서 탐색을 멈추고 찾은 값을 돌려준다", async (t) => {
  // 통합공개 inqryDiv=1 R26BK01832601: Servc만 1행(bfSpecRgstNo·orderPlanNo 빈 값, 수의계약), 나머지 0건
  // 낙찰정보 Servc inqryDiv=4 → 유찰 행(bidClsfcNo "0"), Failing → nobidRsn "단독응찰"
  const { body, calls } = await callWithCalls(t, "/api/business-status?bidNtceNo=R26BK01832601");
  assert.equal(body.businessType, "용역");
  assert.equal(body.chainKey, null);
  assert.equal(body.current.state, "failed");
  assert.equal(body.current.reason, "단독응찰");
  assert.equal(calls.filter((c) => /getCntrctProcssIntgOpenThng/.test(c.url)).length, 0, "용역이 먼저라 물품은 부르지 않는다");
});

test("키 미승인은 개찰 전으로 바뀌지 않고 not_authorized 502다", async (t) => {
  // 모든 상류 → 200 + XML SERVICE_KEY_IS_NOT_REGISTERED_ERROR
  const response = await raw(t, "/api/business-status?bidNtceNo=R26BK01832601");
  assert.equal(response.status, 502);
  assert.equal((await response.json()).code, "not_authorized");
});

test("사슬 조회만 실패하면 저장 공고로 계속하고 partial=chain이다", async (t) => {
  // 통합공개 inqryDiv=1 R26BK01779016 → Servc 1행(bfSpecRgstNo R26BD00278954), inqryDiv=2 → HTTP 503
  // 낙찰정보 Servc inqryDiv=4 R26BK01779016 → 유찰 행, Failing → nobidRsn "무응찰"
  const body = await call(t, "/api/business-status?bidNtceNo=R26BK01779016");
  assert.equal(body.partial, "chain");
  assert.deepEqual(body.notices.map((n) => n.bidNtceNo), ["R26BK01779016"]);
  assert.equal(body.current.reason, "무응찰");
});

test("참가업체가 많으면 페이지 상한까지만 받고 잘렸다고 표시한다", async (t) => {
  // OpengCompt totalCount "469", 페이지마다 100행
  assert.equal(body.current.bidders.length, 300);
  assert.equal(body.current.biddersTruncated, true);
});

test("상류 호출은 상한 40을 넘지 않는다", async (t) => {
  // 사슬 20건(chainNotices가 8로 자름), 모든 공고 재입찰, 업무구분 미지정
  assert.ok(calls.length <= 40);
});

test("입력 검증", async (t) => {
  for (const path of ["/api/business-status", "/api/business-status?bidNtceNo=abc", "/api/business-status?bidNtceNo=R26BK01832601&businessType=기타"]) assert.equal((await raw(t, path)).status, 400);
  assert.equal((await raw(t, "/api/business-status?bidNtceNo=R26BK01832601", { method: "POST" })).status, 405);
});
```

`src/worker.test.mjs`의 live 게이트 테스트(126행 부근) 옆에 추가:

```js
assert.equal((await worker.fetch(request("/api/business-status?bidNtceNo=R26BK01832601"), envOf({ DATA_GO_KR_SERVICE_KEY: "key" }))).status, 401);
assert.equal((await authed("/api/business-status?bidNtceNo=R26BK01832601")).status, 501);
```

- [ ] **Step 2: 실패를 확인한다**

Run: `npm test -- src/business-status.test.mjs src/worker.test.mjs`
Expected: FAIL — 모듈 없음, worker 경로는 자산으로 떨어져 401/501 단언 실패

- [ ] **Step 3: `src/business-status.js`의 `handleBusinessStatus`를 구현하고 `src/worker.js`에 라우팅한다.** 호출 수는 handler 안의 카운터를 감싼 `upstream(path, params)` 한 함수로만 센다.

- [ ] **Step 4: 통과를 확인한다**

Run: `npm test`
Expected: PASS (전체)

- [ ] **Step 5: Worker 연결·번들 검증**

Run: `npm run test:runtime` → Expected: 성공 종료(0)
Run: `npx wrangler deploy --dry-run` → Expected: `--dry-run: exiting now.`

- [ ] **Step 6: 커밋**

```bash
git add src/business-status.js src/business-status.test.mjs src/worker.js src/worker.test.mjs
git commit -m "관심사업 추적: 같은 사업의 공고 사슬과 개찰결과를 돌려주는 경로를 더한다"
```

---

### Task 3: 브라우저 저장소·조회 대상 선별

**Files:**
- Create: `public/tracked.js`
- Test: `test/tracked.test.js`

**Interfaces:**
- Consumes: Task 2의 응답 본문 형태.
- Produces: `GongTracked.createTracked({ storage = scope.localStorage, fetchJson, now = () => Date.now(), html, concurrency = 3 })` → 아래를 가진 객체. CJS `module.exports = { createTracked }`, 브라우저 `scope.GongTracked`(notice-view.js와 같은 IIFE 틀).
  - `items() -> Item[]`(사본), `count() -> number`
  - `Item = { id, savedFrom: "bid"|"pre", savedNo, title, institution, detailUrl, businessType, chainKey, schedule, savedAt, result, checkedAt, error }`
    - `id` = `${savedFrom}:${savedNo}`. `schedule`: 본공고는 `row.bidSchedule`(없으면 `{ bidClseDt: row.closeAt }`), 사전공고는 `{ opninRgstClseDt: row.closeAt }`.
    - 사전공고 항목은 저장 때 `chainKey = { kind: "spec", no: row.announcementNumber }`, `businessType = row.businessType`. 본공고는 둘 다 빈 값(`""`, `null`)으로 시작.
  - `isSaved(row) -> boolean` — 같은 `id`, 같은 `chainKey.no`(사전공고 행), 또는 어떤 항목의 `result.notices`에 `row.announcementNumber`가 있으면 true.
  - `toggle(row) -> { saved: boolean, item: Item|null }` — `isSaved`면 해당 항목 제거, 아니면 추가(발주계획 행은 `{ saved: false, item: null }`). 같은 번호를 다시 저장하면 스냅숏을 새 행 값으로 바꾼다.
  - `remove(id)`
  - `dueItems(nowMs = now()) -> Item[]` — 설계 문서 "조회 시점" 규칙: 확인한 적 없음·`error` 있음·`result.stage === "spec"`·현재 공고 `failed`/`rebid` → 대상. `opened` → 대상 아님. `before`: 현재 공고가 `savedNo`이면 기준 시각(`opengDt`, 없으면 `bidClseDt`)이 지났거나 없을 때 대상, 다른 공고(재공고)면 대상.
  - `applyResult(id, body, receivedAt)` — `result`·`checkedAt` 저장, `error` 비움, `body.businessType`·`body.chainKey`가 있으면 항목에 채운다.
  - `applyError(id, { code, message })` — `error`만 바꾸고 직전 `result`는 둔다.
  - `refresh({ all = false } = {}) -> Promise<void>` — 대상(또는 전부)을 `concurrency`개씩 `fetchJson(url)`. URL: `/api/business-status?` + (`chainKey.kind === "spec"`이면 `specNo`, `plan`이면 `planNo`, 그리고 본공고 저장이면 `bidNtceNo=savedNo`) + 알면 `businessType`. 진행 중에 다시 부르면 같은 Promise를 돌려준다. `fetchJson`이 던지면 `applyError` — 오류의 `code`가 `not_authorized`가 아니면 `code: "upstream"`.
  - 시각 해석: 일정 값 `"2026-11-20 11:00:00"`은 KST로 읽는다(`+09:00`).

- [ ] **Step 1: 실패하는 테스트를 쓴다** — 메모리 `storage`(`getItem`/`setItem`)와 가짜 `fetchJson`.

```js
const { createTracked } = require("../public/tracked.js");
const { html } = require("../public/format.js");
const memory = (initial) => { const map = new Map(initial ? [["gong-go:tracked-businesses", initial]] : []); return { getItem: (k) => map.get(k) ?? null, setItem: (k, v) => map.set(k, v), map }; };
const NOW = Date.parse("2026-11-26T10:00:00+09:00");
const bidRow = { mode: "bid", announcementNumber: "R26BK01779016", title: "직장어린이집", institution: "국방연", closeAt: "2026-10-28 10:00:00", bidSchedule: { bidClseDt: "2026-10-28 10:00:00", opengDt: "2026-10-30 11:00:00" } };
const preRow = { mode: "pre", announcementNumber: "R26BD00278954", businessType: "용역", title: "직장어린이집", institution: "국방연", closeAt: "2026-10-04 23:59:00" };

test("본공고·사전공고는 저장되고 발주계획은 저장되지 않는다", () => {
  const tracked = createTracked({ storage: memory(), html, now: () => NOW });
  assert.equal(tracked.toggle(bidRow).saved, true);
  assert.equal(tracked.toggle(preRow).item.chainKey.no, "R26BD00278954");
  assert.deepEqual(tracked.toggle({ mode: "plan", announcementNumber: "R26DD1" }), { saved: false, item: null });
  assert.equal(tracked.count(), 2);
  assert.equal(tracked.toggle(bidRow).saved, false);
  assert.equal(tracked.count(), 1);
});

test("깨진 저장값·다른 버전·필드 빠진 항목은 버리고 시작한다", () => {
  for (const bad of ["{", JSON.stringify({ version: 2, items: [{}] }), JSON.stringify({ version: 1, items: [null, { savedNo: 1 }, "x"] })]) {
    assert.equal(createTracked({ storage: memory(bad), html }).count(), 0);
  }
});

test("사전공고 사업의 결과에 나온 본공고 행은 이미 저장된 것으로 본다", () => {
  const tracked = createTracked({ storage: memory(), html, now: () => NOW });
  const { item } = tracked.toggle(preRow);
  tracked.applyResult(item.id, { stage: "bid", businessType: "용역", chainKey: item.chainKey, notices: [{ bidNtceNo: "R26BK01779016", state: "failed" }], current: { bidNtceNo: "R26BK01779016", state: "failed" }, partial: "" }, NOW);
  assert.equal(tracked.isSaved(bidRow), true);
  tracked.toggle(bidRow);
  assert.equal(tracked.count(), 0, "같은 사업이므로 해제된다");
});

test("조회 대상: 개찰 예정이 지난 공고·유찰·사전규격 단계는 대상, 개찰완료·미래 일정은 아니다", () => {
  const tracked = createTracked({ storage: memory(), html, now: () => NOW });
  const add = (no, schedule) => tracked.toggle({ ...bidRow, announcementNumber: no, bidSchedule: schedule }).item.id;
  const result = (no, state) => ({ stage: "bid", businessType: "용역", chainKey: null, notices: [{ bidNtceNo: no, state }], current: { bidNtceNo: no, state }, partial: "" });
  const never = add("R26BK00000001", { opengDt: "2026-12-01 11:00:00" });               // 확인한 적 없음 → 대상
  const past = add("R26BK00000002", { opengDt: "2026-11-20 11:00:00" });                // before + 개찰 예정 지남 → 대상
  const future = add("R26BK00000003", { bidClseDt: "2026-12-01 10:00:00", opengDt: "2026-12-01 11:00:00" }); // before + 미래 → 아님
  const noDate = add("R26BK00000004", {});                                               // before + 일정 없음 → 대상
  const opened = add("R26BK00000005", { opengDt: "2026-11-20 11:00:00" });              // opened → 아님
  const failed = add("R26BK00000006", { opengDt: "2026-11-20 11:00:00" });              // failed → 대상
  const spec = tracked.toggle(preRow).item.id;                                           // stage spec → 대상
  for (const [id, no, state] of [[past, "R26BK00000002", "before"], [future, "R26BK00000003", "before"], [noDate, "R26BK00000004", "before"], [opened, "R26BK00000005", "opened"], [failed, "R26BK00000006", "failed"]]) tracked.applyResult(id, result(no, state), NOW);
  tracked.applyResult(spec, { stage: "spec", businessType: "용역", chainKey: { kind: "spec", no: "R26BD00278954" }, notices: [], current: null, partial: "" }, NOW);
  assert.deepEqual(tracked.dueItems(NOW).map((item) => item.id).sort(), [never, past, noDate, failed, spec].sort());
});

test("조회 실패는 직전 결과를 지우지 않고 오류만 남긴다", async () => {
  let fail = false;
  const body = { stage: "bid", businessType: "용역", chainKey: null, notices: [{ bidNtceNo: "R26BK01779016", state: "failed" }], current: { bidNtceNo: "R26BK01779016", state: "failed" }, partial: "" };
  const fetchJson = async () => { if (fail) throw Object.assign(new Error("x"), { code: "not_authorized" }); return body; };
  const tracked = createTracked({ storage: memory(), html, now: () => NOW, fetchJson });
  tracked.toggle(bidRow);
  await tracked.refresh();
  fail = true;
  await tracked.refresh({ all: true });
  const [item] = tracked.items();
  assert.equal(item.result.current.state, "failed");
  assert.equal(item.error.code, "not_authorized");
});

test("refresh는 겹쳐 부르면 한 번만 돈다", async () => {
  let calls = 0;
  const tracked = createTracked({ storage: memory(), html, now: () => NOW, fetchJson: async () => { calls += 1; return { stage: "bid", businessType: "", chainKey: null, notices: [], current: null, partial: "" }; } });
  tracked.toggle(bidRow);
  await Promise.all([tracked.refresh(), tracked.refresh()]);
  assert.equal(calls, 1);
});
```

- [ ] **Step 2: 실패를 확인한다**

Run: `npm test -- test/tracked.test.js`
Expected: FAIL — `Cannot find module '../public/tracked.js'`

- [ ] **Step 3: `public/tracked.js`에 위 Interfaces를 구현한다** (보기 함수는 Task 4).

- [ ] **Step 4: 통과를 확인한다**

Run: `npm test -- test/tracked.test.js`
Expected: PASS

- [ ] **Step 5: 커밋**

```bash
git add public/tracked.js test/tracked.test.js
git commit -m "관심사업 추적: 브라우저 저장소와 조회 대상 선별을 더한다"
```

---

### Task 4: 관심사업 목록·상세 HTML

**Files:**
- Modify: `public/tracked.js` (같은 생성 함수에 보기 함수 추가)
- Test: `test/tracked.test.js`

**Interfaces:**
- Produces (createTracked 반환 객체에 추가):
  - `statusLine(item, nowMs = now()) -> { label: string, tone: "wait"|"done"|"fail"|"error" }`
  - `historyLine(item) -> string` — 공고가 2건 이상일 때만, 아니면 `""`.
  - `resultSummary(item) -> string`
  - `renderList(nowMs = now()) -> string` — `<table>` 하나. 열: 사업명(상세 URL이 안전하면 링크 아님 — 버튼 `data-tracked-id`로 상세 펼침) · 수요기관 · 현재 공고 번호 · 상태(`statusLine`, 아래 줄에 `historyLine`) · 결과(`resultSummary`) · 해제 버튼(`data-untrack-id`). 항목이 없으면 `<p class="tracked-empty">저장한 관심사업이 없습니다. 본공고·사전공고 목록의 ☆를 눌러 저장하세요.</p>`.
  - `renderDetail(id) -> string` — 공고 이력 표(번호·게시일·계약방법·상태·사유 또는 낙찰자) + 현재 공고 업체 표(순위·업체명·사업자번호·투찰금액·투찰률·기술·가격·종합·비고). 점수 세 열은 업체 중 하나라도 점수가 있을 때만, 금액·투찰률 열은 하나라도 값이 있을 때만. `biddersTruncated`면 표 아래 `상위 ${bidders.length}곳만 표시합니다. 전체는 나라장터에서 확인하세요.`. `partial === "chain"`이면 `이어진 공고를 확인하지 못했습니다. 저장한 공고만 표시합니다.`. `chainKey === null`이면 `사전규격·발주계획 연결 정보가 없어 이 공고만 추적합니다.`
  - 모든 상류 문자열은 `html()`을 거친다.

`statusLine` 문구(정확히; `MM/DD`는 KST, `D-n`은 KST 날짜 차, 0이면 `D-day`):

| 조건 | label | tone |
| --- | --- | --- |
| `error.code === "not_authorized"` | `조회 권한 없음(서비스 키 활용신청 확인)` | error |
| 그 밖의 `error`, 직전 결과 없음 | `결과를 확인하지 못했습니다. 잠시 뒤 다시 확인하세요.` | error |
| 확인한 적 없음 | `확인 전` | wait |
| `stage === "spec"`, 의견등록 마감 전 | `사전규격 · 의견등록 마감 D-n` | wait |
| `stage === "spec"`, 마감 후 | `본공고 대기` | wait |
| 현재 `before`, 입찰 마감 전 | `입찰 마감 D-n` | wait |
| 현재 `before`, 마감 후·개찰 전 | `개찰 대기` | wait |
| 현재 `before`, 일정 없음 | `일정 정보 없음` | wait |
| 현재 `before`, 개찰 예정 지남 | `개찰 결과 대기` | wait |
| 현재 `opened`, `method === "수의계약"` | `수의계약 · 낙찰 MM/DD` | done |
| 현재 `opened` | `개찰완료 MM/DD` | done |
| 현재 `failed`, `chainKey` 있음 | `유찰 MM/DD · 재공고 대기` | fail |
| 현재 `failed`, `chainKey` 없음 | `유찰 MM/DD` | fail |
| 현재 `rebid` | `재입찰 MM/DD` | wait |
| 현재 `other` | `stateLabel` 그대로 | wait |

오류가 있지만 직전 결과가 있으면 직전 결과의 label 뒤에 ` · 최근 확인 실패`를 붙이고 tone은 error.
(재공고가 현재 공고면 저장 스냅숏 일정은 쓰지 않는다 — 그 공고는 일정 없음으로 본다.)

`historyLine`: 첫 공고 `1차`, 이후 `method === "수의계약"`이면 `수의계약`, 아니면 `${i + 1}차`; 뒤에 상태어(`failed` 유찰, `opened` 개찰완료 — 수의계약이고 `winners`가 있으면 낙찰, `rebid` 재입찰, 나머지 진행 중)를 붙여 ` → `로 잇는다. 예: `1차 유찰 → 2차 유찰 → 수의계약 낙찰`.

`resultSummary`: 현재 `opened`이고 업체가 있으면 1위 기준 — 종합점수가 있으면 `1위 ${name} ${totalScore}점 · ${participants}개사`, 아니면 투찰률이 있으면 `1위 ${name}(${rate}%) · ${participants}개사`, 아니면 `1위 ${name} · ${participants}개사`(`participants`가 없으면 ` · n개사` 생략); 업체가 없고 `winners`가 있으면 `${name} ${rate}%`; `failed`면 `reason`(없으면 `-`); 그 밖 `-`.

- [ ] **Step 1: 실패하는 테스트를 쓴다** — 위 표의 행마다 `statusLine` 단언 하나씩, 그리고:

```js
test("협상 계약은 점수 열을, 최저가류는 금액 열을 보인다", () => { /* renderDetail 문자열에 "종합" 유무, "투찰금액" 유무 */ });
test("업체가 잘렸으면 상위 N곳 안내를 보인다", () => { /* biddersTruncated true, 300곳 → "상위 300곳만 표시" */ });
test("사슬 이력 줄", () => { assert.equal(tracked.historyLine(item), "1차 유찰 → 2차 유찰 → 수의계약 낙찰"); });
test("상류 문자열은 이스케이프한다", () => { /* name: "<img src=x onerror=1>" → renderDetail에 "<img" 없음 */ });
test("빈 목록 안내", () => { assert.match(tracked.renderList(), /저장한 관심사업이 없습니다/); });
```

- [ ] **Step 2: 실패를 확인한다**

Run: `npm test -- test/tracked.test.js`
Expected: FAIL — `tracked.statusLine is not a function`

- [ ] **Step 3: 보기 함수를 구현한다.**

- [ ] **Step 4: 통과를 확인한다**

Run: `npm test -- test/tracked.test.js`
Expected: PASS

- [ ] **Step 5: 커밋**

```bash
git add public/tracked.js test/tracked.test.js
git commit -m "관심사업 추적: 상태 줄·이력·업체 표를 그린다"
```

---

### Task 5: 화면 연결·문서

**Files:**
- Modify: `public/index.html` — `<script src="tracked.js"></script>`를 `notice-view.js` 다음에. 레일의 `#mode-toggle` 바로 아래 `<button id="tracked-toggle" class="tracked-toggle" type="button" aria-pressed="false">관심사업 <span id="tracked-count"></span></button>`. `<main>`의 `.results-header` 다음에 `<section id="tracked-view" hidden><div class="tracked-tools"><button id="tracked-refresh" class="secondary-btn btn-sm" type="button">결과 새로 확인</button><p id="tracked-status" class="hint" role="status" aria-live="polite"></p></div><div id="tracked-list"></div></section>`. 모달 제목 줄에 `<button id="modal-track-btn" class="track-btn" type="button" aria-pressed="false">☆ 관심사업</button>`.
- Modify: `public/app.js` — 조립과 컨트롤만.
- Modify: `public/style.css` — `.tracked-*`, `.track-btn`, tone별 색(`wait`/`done`/`fail`/`error`)을 기존 변수 체계로.
- Modify: `tools/browser-smoke.cjs` — `/api/business-status` 대역과 시나리오.
- Modify: `docs/code-map.md`(브라우저 표에 tracked.js, Worker 표에 business-status.js·business-status-normalize.js), `docs/search.md`(관심사업 절: 저장 위치가 브라우저라 기기마다 따로임, 자동 조회 규칙, 연결 정보 없는 공고), `docs/operations.md`(서비스 키에 낙찰정보서비스·계약과정통합공개서비스 활용신청 필요).

**Interfaces:**
- Consumes: Task 3·4의 `createTracked` 객체 전부.
- app.js가 하는 일:
  - `const tracked = GongTracked.createTracked({ html, fetchJson: getJson })` — `getJson`(public/http.js)이 비정상 응답에서 던지는 오류에 서버 본문의 `code`를 실어 보내지 않으면, `fetchJson`을 app.js에서 감싸 502 본문의 `code`를 오류 객체에 붙인다.
  - `renderRows`의 제목 셀에 본공고·사전공고 행만 `<button class="track-btn" data-track-index="${i}" aria-pressed>`(☆/★). 누르면 `tracked.toggle(row)` 후 버튼·`#tracked-count` 갱신.
  - `#tracked-toggle`을 누르면 관심사업 보기: `#tracked-view` 보임, `.table-scroll`·`.pagination` 숨김, 결과 제목 `관심사업`, 모드 버튼은 모두 비활성 표시, `tracked.refresh()` 후 다시 그림. 모드 버튼을 누르면 원래 보기로(`applyMode`가 숨김을 되돌린다).
  - `#tracked-list` 클릭 위임: `data-tracked-id` → 그 행 아래 `renderDetail` 펼침/접기, `data-untrack-id` → `remove` 후 다시 그림.
  - `#tracked-refresh` → `tracked.refresh({ all: true })`, 도는 동안 버튼 비활성, `#tracked-status`에 `n건 확인 중입니다.` → 끝나면 비움.
  - 모달이 열릴 때 `#modal-track-btn`을 그 행 상태로 맞추고(발주계획이면 숨김), 누르면 토글.

- [ ] **Step 1: 브라우저 스모크에 실패하는 시나리오를 넣는다** — `/api/business-status`는 `{ stage: "bid", businessType: "물품", chainKey: null, notices: [{ bidNtceNo: "MATCH-001", state: "opened", method: "일반경쟁", openedAt: "2026-09-20 11:00:00" }], current: { bidNtceNo: "MATCH-001", state: "opened", openedAt: "2026-09-20 11:00:00", participants: 2, bidders: [{ rank: 1, name: "업체A", amount: 1000, rate: 88.1, techScore: null, priceScore: null, totalScore: null, remark: "정상" }], biddersTruncated: false }, partial: "" }`로 답하고 호출 수를 센다. 기존 CSV 검색이 끝난 뒤:

```js
await page.locator("#results .track-btn").first().click();
assert.equal(await page.locator("#tracked-count").textContent(), "1");
await page.locator("#tracked-toggle").click();
await page.waitForFunction(() => document.querySelector("#tracked-list").textContent.includes("개찰완료"));
assert.match(await page.locator("#tracked-list").textContent(), /1위 업체A\(88\.1%\)/);
assert.equal(await page.locator(".table-scroll").isVisible(), false);
await page.locator("[data-tracked-id]").first().click();
assert.match(await page.locator("#tracked-list").textContent(), /투찰금액/);
await page.locator(".mode-toggle-btn[data-mode='bid']").click();
assert.equal(await page.locator("#tracked-view").isVisible(), false);
```

- [ ] **Step 2: 실패를 확인한다**

Run: `npm run test:browser`
Expected: FAIL — `#results .track-btn` 없음(타임아웃)

- [ ] **Step 3: index.html·app.js·style.css를 위 Interfaces대로 바꾼다.**

- [ ] **Step 4: 모든 검증을 돌린다**

Run: `npm test` → Expected: PASS
Run: `npm run test:browser` → Expected: 성공 종료(0)
Run: `npm run test:runtime` → Expected: 성공 종료(0)
Run: `npx wrangler deploy --dry-run` → Expected: `--dry-run: exiting now.`

- [ ] **Step 5: 문서를 고친다** (code-map·search·operations, 위 Files 대로).

- [ ] **Step 6: 커밋**

```bash
git add public/index.html public/app.js public/style.css tools/browser-smoke.cjs docs/code-map.md docs/search.md docs/operations.md
git commit -m "관심사업 추적: 레일 항목·저장 토글·관심사업 보기를 화면에 연결한다"
```

---

## 배포 전 (사용자 몫, 코드 작업 아님)

- data.go.kr에서 서비스 키에 **조달청_나라장터 낙찰정보서비스**, **조달청_나라장터 계약과정통합공개서비스** 활용신청이 승인됐는지 확인한다. 승인 전에 배포하면 관심사업 화면이 "조회 권한 없음"을 보인다(다른 기능에는 영향 없음).
- 브랜치를 main에 합치는 것은 사용자가 결정한다(푸시 = 배포).
