# 5부. 모듈 경계 — 공유 코드를 두지 않는다 (2026-09-13)

> 당시 조사·결정의 기록입니다. 현재 파일 위치와 작업 기준은 [코드 지도](../code-map.md)를 먼저 확인하세요. 배포 상태·남은 작업·테스트 수치는 작성 당시 기준입니다.

**상태**: 코드 반영 완료 · `npm test` 197/197 통과 · `npx wrangler deploy --dry-run` 통과

## 1. 기준

**각 모듈은 제가 쓰는 것을 제 안에 전부 구현한다. 모듈을 가로지르는 공용 디렉터리는 두지 않는다.**
공유는 해당 기능 모듈 **안에서만** 한다. 이 기준은 README "구성 > 모듈 경계"에도 같은 내용으로
적혀 있고, 새 코드는 그 규칙을 따른다.

여기서 말하는 모듈은 저장소의 최상위 디렉터리다: `collector/`, `downloader/`,
`analyzer/`, `uploader/`, `src/`(Worker), `public/`(조회 화면), `test/`.

## 2. 왜

공용 파일은 편의를 주는 대신 **장애를 전파한다.** `shared/pipeline-utils.js` 한 줄을 고치면 수집·
다운로드·변환·분석·업로드가 동시에 영향권에 들어왔고, `shared/csv-record.js`는 거기에 조회 화면
테스트까지 묶여 있었다. 이 저장소는 단계마다 실행 주체와 시점이 다르다 — 수집은 GitHub Actions
크론 러너에서, 변환·분석은 로컬 PC에서(한글 COM 때문에 Windows), 조회는 Cloudflare Worker에서
돈다. 한 단계를 고치다 다른 단계를 멈추는 것이 가장 비싸고, 그 사고는 대개 배포 뒤 몇 시간 지나
크론이 돌 때 드러난다.

바꿔 말하면 **모듈 사이의 계약은 함수가 아니라 데이터다.** collector와 downloader가 맞춰야 하는
것은 `parseCsv`의 코드가 아니라 `data/`에 저장된 CSV 형식이다. 형식만 같으면 각자 제 파서를
가져도 되고, 그래야 한 쪽의 사정이 다른 쪽을 멈추지 못한다.

## 3. 무엇이 어디로 갔나

`shared/`는 삭제했다. 안에 있던 것은 쓰는 모듈로 옮겼다.

| 옛 위치 | 지금 | 비고 |
|---|---|---|
| `shared/csv-record.js` | `collector/csv-record.js` | 쓰는 쪽. `collector.js`·`compact.js`가 모듈 안에서 공유 |
| (같은 파일의 읽기 부분) | `downloader/attachments.js` 안 | 읽기 전용 사본. `public/rows.js`에는 이미 사본이 있었다 |
| `shared/service-columns.js` | `collector/service-columns.js` | 저장 형식을 정하는 쪽이 컬럼 계약도 갖는다 |
| `shared/pipeline-utils.js` (경로·인덱스) | `collector/store.js` | `collector.js`·`compact.js`가 모듈 안에서 공유 |
| 〃 (인덱스 항목 생성) | `uploader/upload.js` 안 | R2 키로 인덱스를 만드는 쪽의 사본 |
| 〃 (`loadEnv`·`mapPool`·`readJson`·gzip) | `analyzer/analyze.js`, `downloader/attachments.js` 안 | 각자 필요한 것만 (당시에는 `converter/convert.js`도 받았다 — 6부에서 저장소를 떠났다) |
| 〃 (행 필드·`safeFileName`) | `downloader/attachments.js` 안 | 유일한 사용처였다 |
| `shared/nl-filter.js` | `src/ask.js`(ESM) | 운영 Worker의 질의 해석 |

부수 효과로 Worker 번들에서 CJS가 사라졌다. 전에는 ESM 진입점이 `shared/nl-filter.js`(CJS)를
import하고 esbuild가 그것을 이어 붙였는데, 지금은 `src/ask.js`가 ESM이라 그 우회가 없다.

테스트도 같이 옮겼다. `shared/*.test.js`는 각 모듈 옆으로 갔고, 사본이 생긴 곳에는 그 사본을
검증하는 테스트를 새로 뒀다(`downloader/attachments.test.js`, `collector/store.test.js`).

## 4. 받아들인 비용

솔직하게 적어 둔다. 이 결정은 공짜가 아니다.

- **같은 모양의 코드가 여러 곳에 있다.** CSV 파서 3벌(쓰기 1·읽기 2), 인덱스 항목 규칙 2벌,
  `mapPool` 5벌, 질의 해석 2벌. 한 곳을 고쳐도 나머지가 따라오지 않는다 — 그것이 목적이다.
- **한 곳의 개선이 자동으로 퍼지지 않는다.** 파서를 빠르게 고쳐도 다른 사본은 그대로다.
  퍼뜨리려면 각 모듈에서 따로 판단해 따로 고치고, 각 모듈의 테스트로 확인한다.
- **`test/rows.test.js`가 수집기의 직렬화기를 더 이상 쓰지 않는다.** 전에는 "collector가 실제로
  쓰는 함수로 입력을 만든다"는 보증이 있었다. 지금은 같은 **형식**을 테스트 안에서 만든다.
  형식이 갈라지면 이 테스트가 아니라 `downloader/attachments.test.js`의 형식 고정 테스트와
  실제 데이터에서 드러난다.

이 비용을 감수하는 이유는 3부·4부에서 반복해 확인한 것과 같다 — 이 서비스에서 값비싼 실패는
"코드가 조금 중복된 것"이 아니라 "한 단계를 고치다 다른 단계가 조용히 멈춘 것"이다.

## 5. 새 코드를 넣을 때

1. 다른 모듈의 파일을 `require`/`import`하지 않는다. 필요하면 제 모듈 안에 구현한다.
2. 한 모듈 안에서 두 파일 이상이 같은 것을 쓰면 그때만 모듈 안에 공용 파일을 만든다.
   지금 그런 파일은 `collector/csv-record.js`, `collector/store.js`, `collector/service-columns.js`,
   `analyzer/spec-schema.js`, `analyzer/verify.js`,
   `public/rows.js`뿐이고 전부 제 모듈 안에서만 불린다.
3. 사본을 만들면 원본 파일명을 주석에 적고(형식이 같다는 뜻이지 코드가 묶였다는 뜻이 아니다),
   그 사본의 테스트를 함께 둔다.
4. 데이터 계약(README의 표)을 바꿔야 하면 문서를 먼저 고치고 읽는 쪽 사본을 하나씩 따라 고친다.
5. 3부의 "공용화" 항목들(§5 첨부 파일명 안전성 검사, §6 텍스트 정규화)은 이 기준에 따라
   **모듈을 가로질러 합치지 않는다.** 필요한 모듈이 제 안에 갖는다.

## 6. 검증

| 검증 | 결과 |
|---|---|
| `npm test` | 197/197 통과 (이관 전 178 + 사본 검증용 신규 19) |
| `npx wrangler deploy --dry-run` | 번들 성공. 바인딩 `env.DATA`·`env.AI`·`env.ASSETS` 확인 |
| `grep -r "shared/"` | 코드에 남은 참조 없음(문서의 이력 설명만 남김) |
| CLI 진입점 | `convert`·`analyze --dry-run`·`attachments --dry-run`·`compact --dry-run` 정상 종료 |
| `data/` 변경 | 없음 |

---
