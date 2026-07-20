# local-dev 클라우드플레어 배포 계획

`local-dev`(수집기 + CSV 뷰어)를 Cloudflare에 올려 여러 사람이 브라우저로 접근할 수 있게 하는 계획.

- **저장**: Cloudflare R2 (CSV) + Cloudflare Pages (앱)
- **수집**: GitHub Actions 크론 (매일 자동)
- **대상**: 기존 `gong-go.pages.dev`와 **별도 Pages 프로젝트** (예: `gong-go-archive`)

---

## 1. 현재 구조와 제약

### 구성

| 위치 | 역할 | 실행 환경 |
|---|---|---|
| `/`(루트) | 나라장터 API 실시간 조회 앱 | Pages + Functions (배포 완료) |
| `local-dev/collector/` | 공공데이터 API 수집기 | 로컬 Node |
| `local-dev/public/` | 수집된 CSV 뷰어 | 로컬 정적 서버 |

두 앱은 완전히 분리되어 있다. 루트 앱은 API를 실시간 프록시하고, `local-dev`는 미리 수집한 CSV를 읽는다.

### 실측 데이터 규모

`collector/data/bid/2025/01/06.csv` 기준:

| 항목 | 값 |
|---|---|
| 컬럼 수 | 170 |
| 행 수 | 1,019 |
| 원본 크기 | 3.0 MB (행당 약 3 KB) |
| gzip | 279 KB |
| 뷰어가 실제 쓰는 컬럼 | 12개 + 첨부 URL/파일명 20개 |
| 슬림화 후 | 1.1 MB / gzip 105 KB |

현재 `data/` 전체는 24일치 **86 MB**. `sync.config.json`의 범위가 `2025-01-01 ~ 오늘`이므로 전 구간 수집 시 **원본 약 2 GB / 슬림 약 700 MB**로 늘어난다.

### 배포를 막는 세 가지

1. **데이터가 Git에 없다.** `local-dev/.gitignore`가 `collector/data/`를 제외하므로 Git 기반 Pages 빌드로는 CSV가 올라가지 않는다. (추적 파일 12개 확인)
2. **프론트가 범위 내 CSV를 전부 받아 브라우저에서 파싱한다.** `public/app.js:48`이 `Promise.all`로 대상 파일을 모두 fetch한다. 기본 7일 창 = 원본 42 MB 파싱. 로컬 디스크에서는 문제없지만 네트워크 너머에서는 체감이 나쁘다.
3. **접근 통제가 없다.** 루트의 `functions/_middleware.js` 게이트는 해당 Pages 프로젝트에만 적용된다. 새 프로젝트에는 별도로 넣어야 한다.

### 무료 한도 (확인 완료)

| 서비스 | 한도 |
|---|---|
| R2 저장 | 10 GB/월 |
| R2 Class A(쓰기) | 100만 요청/월 |
| R2 Class B(읽기) | 1,000만 요청/월 |
| R2 이그레스 | **무료** |
| Pages 파일 수 | 20,000 (Free) |
| Pages 파일 크기 | 25 MiB |
| Pages 빌드 | 500회/월 |

슬림 700 MB는 R2 무료 10 GB 안에 여유 있게 들어간다. 이그레스가 무료라 CSV를 아무리 내려받아도 전송 비용이 없다 — 이것이 R2를 고른 결정적 이유다.

---

## 2. 목표 아키텍처

```
GitHub Actions (매일 크론)
  └─ node collector.js         공공데이터 API 수집
     └─ 슬림 CSV 생성
        └─ R2 PUT (변경된 날짜만)
                 │
                 ▼
        R2 버킷  gong-go-data
         ├─ index.json
         ├─ pre/2025/01/04.csv
         └─ bid/2025/01/06.csv
                 │
                 ▼
Cloudflare Pages  gong-go-archive
  ├─ _middleware.js         비밀번호 게이트 (루트에서 복사)
  ├─ functions/data/[[path]].js   R2 바인딩 → CSV 서빙 + 캐시 헤더
  └─ index.html / app.js / style.css
```

프론트는 `DATA_BASE`를 `../collector/data` → `/data`로 바꾸는 것만으로 동작한다. R2 접근은 Pages Function이 바인딩으로 중계하므로 버킷을 공개할 필요가 없고, 게이트 통과 후에만 데이터에 닿는다.

---

## 3. 단계별 실행

### 1단계 — 수집기에 슬림 출력 추가

**목적:** 전송량과 브라우저 파싱 부하를 3배 줄인다. 이것이 나머지 모든 단계의 비용을 낮추므로 가장 먼저 한다.

- `collector/csv-record.js`에 화이트리스트 기반 투영(projection) 함수 추가
  - 유지: `bidNtceNo`, `bfSpecRgstNo`, `rlDminsttNm`, `dminsttNm`, `ntceKindNm`, `bsnsDivNm`, `prdctClsfcNoNm`, `bidNtceNm`, `rgstDt`, `bidNtceDt`, `opninRgstClseDt`, `bidClseDt`
  - 유지: `ntceSpecDocUrl1~10`, `specDocFileUrl1~5`, `ntceSpecFileNm1~10`
  - 나머지 약 138개 컬럼 제거
- 원본은 로컬에 그대로 두고 **배포용 슬림본을 따로 생성**한다(`data/` → `dist/`). 나중에 컬럼을 추가하고 싶을 때 재수집이 필요 없다.
- `csv-record.test.js`에 투영 테스트 추가

**검증:** 슬림 CSV를 로컬 뷰어로 열어 기존과 동일하게 표시되는지 확인.

### 2단계 — R2 버킷 생성과 업로드 경로

- R2 버킷 `gong-go-data` 생성 (공개 접근 **비활성화** 유지)
- `collector/`에 업로드 스크립트 추가 (`upload.js`)
  - `index.json`과 변경된 날짜의 CSV만 PUT
  - 로컬 해시 캐시로 무변경 파일 건너뛰기 → Class A 요청 절약
  - `Content-Type: text/csv; charset=utf-8` 지정
- 인증: R2 S3 호환 API 토큰 (`R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`)

**검증:** 로컬에서 한 번 수동 실행해 R2 대시보드에 파일이 올라오는지 확인.

### 3단계 — Pages 프로젝트 생성

- 새 Pages 프로젝트 `gong-go-archive`, 빌드 출력 디렉터리 `local-dev/public`
- `local-dev/functions/data/[[path]].js` 신규 작성
  ```js
  export async function onRequestGet({ env, params }) {
    const key = params.path.join("/");
    if (!/^(index\.json|(pre|bid)\/\d{4}\/\d{2}\/\d{2}\.csv)$/.test(key))
      return new Response("Not found", { status: 404 });
    const obj = await env.DATA.get(key);
    if (!obj) return new Response("Not found", { status: 404 });
    return new Response(obj.body, {
      headers: {
        "Content-Type": key.endsWith(".json")
          ? "application/json; charset=utf-8"
          : "text/csv; charset=utf-8",
        // 과거 날짜 CSV는 불변 → 길게 캐시. index.json은 짧게.
        "Cache-Control": key.endsWith(".json")
          ? "public, max-age=300"
          : "public, max-age=86400",
      },
    });
  }
  ```
  키 정규식으로 경로를 제한해 버킷 내 임의 키 열람을 막는다.
- 설정 > 바인딩 > R2 버킷 → 변수명 `DATA`, 버킷 `gong-go-data`
- `functions/_middleware.js`를 루트에서 복사, 환경변수 `GATE_PASSWORD` 설정
- `public/app.js`의 `DATA_BASE`를 `/data`로 변경, `file:` 프로토콜 분기(19~21행)와 로컬 안내 문구 정리

**검증:** 게이트 통과 → 목록 표시 → 첨부 모달 → CSV 다운로드까지 확인.

### 4단계 — GitHub Actions 크론

`.github/workflows/collect.yml` 신규:

```yaml
on:
  schedule:
    - cron: "0 20 * * *"   # UTC 20:00 = KST 05:00
  workflow_dispatch:
```

- Node 20 설치 → `collector.js` 실행 → 슬림 생성 → `upload.js`로 R2 반영
- Secrets: `SERVICE_KEY`, `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`
- **증분 수집 상태(`sync-state.json`)를 R2에 함께 보관**한다. Actions 러너는 매번 초기화되므로 상태가 없으면 전 구간을 다시 긁는다. 시작 시 내려받고 종료 시 올린다.
- `sync.config.json`의 `begin`을 워크플로에서 "최근 N일"로 덮어써 매일 실행분을 짧게 유지 (초기 전체 적재는 `workflow_dispatch`로 1회 수동)
- 실패 시 알림: `sync-errors.json`이 비어있지 않으면 워크플로를 실패 처리

**검증:** `workflow_dispatch`로 수동 1회 실행해 성공 확인 후 크론 활성화.

### 5단계 — 조회 UX 보완 (선택, 데이터가 커진 뒤)

슬림화 후에도 넓은 범위 조회는 무겁다. 필요해지면:

- 조회 범위 상한을 UI에서 제한 (예: 최대 31일) — 가장 싸게 효과를 본다
- 파일 단위 순차 로딩 + 진행률 표시 (현재는 `Promise.all`로 동시 요청)
- 그래도 부족하면 D1로 이전해 서버측 필터링

지금 단계에서 미리 할 필요는 없다. 실제 사용 패턴을 보고 판단한다.

---

## 4. 보안 점검

| 항목 | 상태 |
|---|---|
| `collector/.env` Git 커밋 이력 | **없음** (`git log --all` 확인 완료) |
| `collector/data/` 추적 여부 | 제외됨 |
| `SERVICE_KEY` | Actions Secret으로만 주입, 클라이언트 노출 없음 |
| R2 버킷 공개 설정 | 비공개 유지, Pages Function 바인딩으로만 접근 |
| 접근 통제 | `_middleware.js` 공유 비밀번호 게이트 |

게이트는 단일 공유 암호라 유출 시 개인별 차단이 불가능하다. 사용자가 늘거나 데이터 민감도가 올라가면 Cloudflare Access(SSO)로 교체를 검토한다.

---

## 5. 비용

전 구간 슬림 700 MB 기준, **월 $0**로 무료 한도 안에 들어간다.

| 항목 | 예상 | 한도 |
|---|---|---|
| R2 저장 | 0.7 GB | 10 GB |
| R2 쓰기(Class A) | 일 약 60건 × 30일 ≈ 1,800 | 100만 |
| R2 읽기(Class B) | 조회당 약 15건, 넉넉히 잡아도 수천 | 1,000만 |
| 이그레스 | — | 무료 |
| Pages 빌드 | 코드 변경 시에만 | 500회/월 |

데이터 수집 범위를 몇 년으로 늘려도 R2 10 GB 안에서 여유가 있다.

---

## 6. 작업 순서 요약

1. 슬림 투영 함수 + 테스트 (`csv-record.js`)
2. R2 버킷 생성, `upload.js` 작성, 수동 업로드 1회
3. Pages 프로젝트 + `functions/data/[[path]].js` + 게이트 + `DATA_BASE` 변경
4. GitHub Actions 크론 + Secrets + 상태 파일 R2 왕복
5. (선택) 조회 범위 상한·순차 로딩

1~3단계까지 마치면 배포된 상태로 동작하고, 4단계에서 자동 갱신이 붙는다.
