# local-dev 클라우드플레어 배포 계획

`local-dev`(수집기 + CSV 뷰어)를 Cloudflare Pages에 올려 여러 사람이 브라우저로 접근할 수 있게 하는 계획.

- **저장**: gzip 데이터를 Git에 커밋 → Cloudflare Pages가 정적 파일로 서빙
- **수집**: GitHub Actions 크론 (매일 자동) → 바뀐 gzip만 커밋 → Pages 자동 재배포
- **대상**: 기존 `gong-go.pages.dev`와 **별도 Pages 프로젝트** (예: `gong-go-archive`)

> 이전 판은 데이터를 R2에 두는 안이었다. 그 사이 수집기가 날짜별 파일을 이미 gzip으로
> 저장하도록 바뀌어 전체 규모가 수십 MB로 작아졌다. 이 규모에서는 gzip을 그대로 Git에
> 커밋해 Pages 정적 파일로 서빙하는 편이 훨씬 단순하다(R2·바인딩·업로드 스크립트 불필요).
> R2는 데이터가 수 GB로 커질 때의 대안으로 6장에 남겨 둔다.

---

## 1. 현재 구조와 제약

### 구성

| 위치 | 역할 | 실행 환경 |
|---|---|---|
| `/`(루트) | 나라장터 API 실시간 조회 앱 | Pages + Functions (배포 완료) |
| `local-dev/collector/` | 공공데이터 API 수집기 | 로컬 Node / GitHub Actions |
| `local-dev/public/` | 수집된 CSV 뷰어 | 로컬 정적 서버 / Pages |

두 앱은 완전히 분리되어 있다. 루트 앱은 API를 실시간 프록시하고, `local-dev`는 미리 수집한 CSV를 읽는다.

### 이미 끝나 있는 것 (수집기 마이그레이션)

`collector.js`는 다음을 이미 수행했다. 이전 배포계획서의 "슬림본 생성" 상당 부분이 gzip 압축으로 대체된 셈이다.

- `gzip-storage-v1`: 날짜별 파일을 `.csv.gz`로 압축 저장(수백 개, 총 수십 MB).
- `drop-generated-v1`: 파생 컬럼(`id`·`mode`·`title` 등) 제거 → 뷰어가 읽을 때 `displayRow()`로 재생성.
- 프론트(`public/app.js`)는 `fetchCsvGz()` + `DecompressionStream("gzip")`으로 gzip을 브라우저에서 직접 해제.

### 배포를 막던 세 가지 → 해소 방법

1. **데이터가 Git에 없다.** `local-dev/.gitignore`가 `collector/data/`를 통째로 제외했다.
   → **[해결]** 상태 파일만 제외하도록 좁히고 gzip 데이터는 추적한다.
2. **프론트 경로가 로컬 전용.** `DATA_BASE = "../collector/data"`, `file:` 분기와 로컬 안내 문구.
   → **[해결]** `DATA_BASE`를 `/data`로 바꾸고 문구를 정리했다.
3. **접근 통제가 새 프로젝트엔 없다.** 게이트(`_middleware.js`)는 루트 프로젝트에만 적용된다.
   → **[해결]** 루트 게이트를 `local-dev/functions/_middleware.js`로 복사했다.

### 무료 한도 (확인 완료)

| 서비스 | 한도 |
|---|---|
| Pages 파일 수 | 20,000 (Free) |
| Pages 파일 크기 | 25 MiB |
| Pages 빌드 | 500회/월 |
| Pages 이그레스 | **무료** |
| GitHub Actions(공개 저장소) | 무료 |

gzip 수백 개(각 수백 KB)는 20,000 파일·25 MiB 한도에 여유 있게 들어간다. 이그레스가 무료라 CSV를 아무리 내려받아도 전송 비용이 없다.

---

## 2. 목표 아키텍처

```
GitHub Actions 크론 (매일 KST 05:00)
  └ cd local-dev/collector && node collector.js   SYNC_BEGIN으로 최근 35일만 수집
     └ 바뀐 data/**/*.csv.gz + index.json 만 브랜치에 커밋·푸시
        └ Cloudflare Pages (푸시 시 자동 빌드)
           빌드: bash build.sh  →  collector/data 를 public/data 로 복사
           출력: local-dev/public
           ├ _middleware.js   비밀번호 게이트 (루트에서 복사)
           ├ /data/index.json, /data/{pre,bid}/YYYY/MM/DD.csv.gz  ← 정적 서빙
           └ index.html / app.js / style.css
```

게이트(`_middleware.js`)가 모든 요청보다 먼저 실행되므로 `/data/**` gzip도 자동으로 게이트 뒤에 놓인다. 데이터는 Pages가 정적 파일로 직접 서빙하고, 프론트는 `DATA_BASE`를 `/data`로 바꾸는 것만으로 동작한다.

---

## 3. 단계별 실행

1~5단계의 **코드 변경은 이미 브랜치에 반영**되어 있다. 각 단계 끝의 파일이 실제 커밋된 산출물이다. 대시보드/시크릿 작업만 남는다(4장).

### 1단계 — 데이터를 배포 대상으로 편입 ✅

`local-dev/.gitignore`를 상태 파일만 제외하도록 좁혔다.

```
collector/.env
collector/data/sync-state.json
collector/data/sync-errors.json
collector/data/notices.csv
collector/data/notices.legacy.csv
public/data/                 # 빌드 산출물(커밋 대상 아님)
```

`pre/**`·`bid/**`·`index.json`은 이제 추적된다. 첫 적재는 4장 3번(초기 워크플로 실행)에서 러너가 만들어 커밋한다.

### 2단계 — 빌드 시 `/data` 서빙 ✅

데이터가 출력 디렉터리(`public`) 밖(`collector/data`)에 있으므로 빌드 때 복사한다. `local-dev/build.sh`:

- `collector/data/index.json` + `pre/` + `bid/`만 `public/data/`로 복사(상태 파일 제외).
- Pages 설정: 루트 디렉터리 `local-dev`, 빌드 명령 `bash build.sh`, 출력 디렉터리 `public`.

**검증 포인트:** `.csv.gz`는 Pages가 **`Content-Encoding` 없이 원본 바이트로** 서빙해야 한다. 프론트가 직접 `DecompressionStream`으로 해제하므로, Pages가 자동 해제하면 이중 처리로 깨진다. 배포 후 `/data/bid/2025/01/06.csv.gz` 하나만 열어 확인한다(로컬 `python http.server`와 동일 동작이라 대개 문제없음).

### 3단계 — 프론트 경로 정리 ✅

`public/app.js`:

- `DATA_BASE` `../collector/data` → `/data`.
- `file:` 분기와 `python -m http.server` 안내 문구를 배포용 문구로 교체.

### 4단계 — 게이트 이식 ✅

- 루트 `functions/_middleware.js`를 `local-dev/functions/_middleware.js`로 복사.
- Pages 환경변수 `GATE_PASSWORD`(필수), `GATE_COOKIE_NAME`(선택) 설정 → 4장 참조.

### 5단계 — GitHub Actions 크론 ✅

`.github/workflows/collect.yml`:

```yaml
on:
  schedule:
    - cron: "0 20 * * *"   # UTC 20:00 = KST 05:00
  workflow_dispatch:
    inputs:
      begin: { description: "수집 시작일(YYYY-MM-DD). 비우면 최근 35일.", default: "" }
      end:   { description: "수집 종료일(YYYY-MM-DD). 비우면 오늘.",      default: "" }
```

- Node 20 → `collector.js` 실행 → 바뀐 `data/**/*.csv.gz`·`index.json`을 브랜치에 커밋·푸시. Pages가 이 커밋으로 자동 재배포한다.
- **범위 좁히기:** `sync-state.json`을 커밋하지 않으므로 러너는 매번 resume 상태 없이 시작한다. 그대로 두면 전 구간을 매일 재수집하므로, 워크플로가 `SYNC_BEGIN`(환경변수)으로 **최근 35일**만 수집하도록 좁힌다(과거 날짜는 이미 커밋된 gzip을 승계). `collector.js`는 `process.env.SYNC_BEGIN || config.begin` 순으로 범위를 정한다 — `sync.config.json`은 러너에서 건드리지 않는다.
- **빈 빌드 방지:** 변경이 없으면 커밋을 생략한다(`git diff --cached --quiet`).
- **실패 처리:** `sync-errors.json`이 비어있지 않으면 워크플로를 실패시킨다.
- **Secret:** `SERVICE_KEY` 하나면 된다.

> **주의 — 실행 브랜치.** 크론이 프로덕션 데이터를 갱신하려면 **Pages가 빌드하는 브랜치(보통 `main`)에서** 워크플로가 돌아야 한다. 스케줄/`workflow_dispatch`는 기본 브랜치에서 실행되며, 워크플로는 실행된 브랜치(`github.ref_name`)로 커밋한다. 따라서 이 변경을 `main`에 병합하면 크론이 `main`에서 돌고 `main`으로 커밋한다.

### 6단계 — 조회 UX 보완 (선택, 데이터가 커진 뒤)

넓은 범위 조회는 여전히 무겁다. 필요해지면 순서대로:

- 조회 범위 상한을 UI에서 제한(예: 최대 31일) — 가장 싸게 효과를 본다.
- 파일 단위 순차 로딩 + 진행률 표시(현재는 `Promise.all` 동시 요청).
- 그래도 부족하면 D1로 이전해 서버측 필터링.

지금 단계에서 미리 할 필요는 없다.

---

## 4. 남은 작업 (대시보드 · 시크릿)

코드 밖 작업이라 저장소 커밋만으로는 끝나지 않는다.

1. **Cloudflare Pages 새 프로젝트**(예 `gong-go-archive`) 생성 → 저장소 연결
   - 루트 디렉터리 `local-dev`, 빌드 명령 `bash build.sh`, 출력 디렉터리 `public`
   - 환경변수 `GATE_PASSWORD`(게이트 암호), 선택 `GATE_COOKIE_NAME`
2. **GitHub 시크릿** `SERVICE_KEY` 등록(공공데이터 인증키)
3. **초기 전 구간 적재:** Actions에서 `collect`를 `workflow_dispatch`로 1회 실행(`begin=2025-01-01`) → 러너가 데이터를 만들어 커밋 → Pages 첫 배포. 이후 매일 크론이 최근 35일만 갱신한다.
4. **배포 검증:** 게이트 통과 → 목록 표시 → 첨부 모달 → CSV 다운로드, 그리고 2단계의 gzip 서빙 확인.

---

## 5. 보안 점검

| 항목 | 상태 |
|---|---|
| `collector/.env` Git 커밋 이력 | 없음 (`.gitignore`로 제외) |
| `collector/data/` 상태 파일 추적 | `sync-state.json`·`sync-errors.json` 등 제외, gzip 데이터만 추적 |
| `SERVICE_KEY` | Actions Secret으로만 주입, 클라이언트 노출 없음 |
| 데이터 접근 통제 | `_middleware.js` 공유 비밀번호 게이트(정적 `/data`도 게이트 뒤) |
| 커밋 데이터 민감도 | 공공데이터 공개 공고 정보 — 개인정보 아님 |

게이트는 단일 공유 암호라 유출 시 개인별 차단이 불가능하다. 사용자가 늘거나 데이터 민감도가 올라가면 Cloudflare Access(SSO)로 교체를 검토한다.

---

## 6. 대안 — R2로 전환하는 기준

Git-정적 방식의 약점은 **저장소 히스토리 비대화**다. 매일 커밋이 쌓이고, 데이터가 수 GB / 파일 수천 개로 커지면 클론·빌드가 무거워진다. 그 시점에는 R2로 옮긴다.

- Cloudflare R2 버킷(예 `gong-go-data`) 생성, 공개 접근 비활성화.
- 5단계의 "커밋" 대신 `collector/upload.js`로 변경된 날짜만 R2에 PUT(로컬 해시 캐시로 무변경 건너뛰기). `sync-state.json`도 R2에 왕복 보관해 증분 상태를 유지한다.
- 2단계의 정적 복사 대신 `local-dev/functions/data/[[path]].js`를 두어 R2 바인딩(`DATA`)으로 중계하고, 키 정규식으로 경로를 제한한다.

  ```js
  export async function onRequestGet({ env, params }) {
    const key = params.path.join("/");
    if (!/^(index\.json|(pre|bid)\/\d{4}\/\d{2}\/\d{2}\.csv\.gz)$/.test(key))
      return new Response("Not found", { status: 404 });
    const obj = await env.DATA.get(key);
    if (!obj) return new Response("Not found", { status: 404 });
    return new Response(obj.body, {
      headers: {
        "Content-Type": key.endsWith(".json") ? "application/json; charset=utf-8" : "application/gzip",
        "Cache-Control": key.endsWith(".json") ? "public, max-age=300" : "public, max-age=86400",
      },
    });
  }
  ```

R2 무료 한도(저장 10 GB, 이그레스 무료)로 수년치도 월 $0에 들어간다. 지금 gzip 규모에서는 과설계이므로 필요해질 때 전환한다.

---

## 7. 작업 순서 요약

1. `.gitignore` 축소 + 프론트 `/data` + 게이트 복사 + `build.sh` + 크론 워크플로 — **완료(브랜치 반영)**
2. Pages 프로젝트 생성(루트 `local-dev`, 빌드 `bash build.sh`, 출력 `public`) + `GATE_PASSWORD`
3. GitHub 시크릿 `SERVICE_KEY`
4. `workflow_dispatch`로 초기 전 구간 적재 1회 → Pages 첫 배포
5. 배포 검증(게이트·목록·첨부·gzip 서빙)
6. (선택) 조회 범위 상한 등 UX 보완

1은 끝났고, 2~4를 마치면 배포된 상태로 자동 갱신까지 동작한다.
