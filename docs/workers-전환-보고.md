# Cloudflare Pages → Workers 전환 보고

## 결과

- 커밋: `a3a7b62 refactor: deploy viewer as Cloudflare Worker`
- Worker 진입점: `src/worker.js`
- 설정: `wrangler.jsonc`
- Wrangler 고정 버전: `4.120.0`
- Pages 전용 `functions/_middleware.js`, `functions/data/[[path]].js` 삭제
- `README.md` 갱신 및 `docs/배포계획-R2.md`에 Workers 구조·배포 순서 갱신
- `docs/배포계획-R2.md`는 작업 시작 전부터 사용자의 큰 미커밋 변경이 있던 파일이라, 그 변경을
  함께 커밋하지 말라는 지시에 따라 현재 워킹트리에는 갱신 내용을 남기되 커밋에는 포함하지 않음

## 게이트 우선 실행 근거

`wrangler.jsonc`에 아래를 적용했다.

```jsonc
"assets": {
  "directory": "./public",
  "binding": "ASSETS",
  "run_worker_first": true
}
```

Cloudflare 공식 Workers Static Assets 문서의 `run_worker_first` 항목은 기본값 `false`에서는
일치하는 정적 자산을 먼저 서빙하고, `true`에서는 Worker 스크립트를 무조건 먼저 실행한다고
명시한다.

- https://developers.cloudflare.com/workers/static-assets/binding/#run_worker_first
- https://developers.cloudflare.com/workers/static-assets/migration-guides/migrate-from-pages/

요청에 지정된 Context7 MCP는 이 worker 세션에 등록되어 있지 않았다. `codex mcp list` 결과가
`node_repl` 하나뿐이었고 Context7 도구·리소스도 없었다. Orca 결정 게이트로 알리려 했으나
`The Orca runtime closed the connection before responding ... Orca is not running`으로 전달되지 않아,
최신 Cloudflare 공식 문서(2026-07/08 갱신)를 직접 조회해 확인했다.

## 구현 보존 사항

- `X-Gate-Password` 헤더와 `gong_gate` 기본 쿠키 이름
- `GATE_COOKIE_NAME` 재정의
- SHA-256(`gong-gate:v1:` + password) hex 쿠키 토큰
- 상수 시간 비교
- `POST /__gate/login`, `/__gate/logout`, 내부 절대경로만 허용하는 `safePath`
- Max-Age/Expires 없는 세션 쿠키, HttpOnly, SameSite=Lax, HTTPS의 Secure
- 로그인 화면 `Cache-Control: no-store`
- `GATE_PASSWORD`가 없으면 통과 모드
- 기존 키 화이트리스트와 `raw/`, `state/` 차단
- 날짜별 `private` Cache-Control 분기
- `env.DATA.get(key, { onlyIf: request.headers })`, ETag, 304
- gzip 응답에 `Content-Encoding`을 붙이지 않음

## 실행한 검증과 실제 출력

### 정적 검사·설정 검사·회귀 테스트

```text
> node --check src/worker.js
(출력 없음, exit 0)

> npx wrangler deploy --dry-run
wrangler 4.120.0
Read 4 files from the assets directory ...\public
Total Upload: 9.03 KiB / gzip: 3.37 KiB
env.DATA (gong-go-data)        R2 Bucket
env.ASSETS                     Assets
--dry-run: exiting now.

> npm test
tests 21
pass 21
fail 0
duration_ms 324.6055
```

### 로컬 R2와 Worker 실요청

원격 버킷은 건드리지 않았다. 별도 로컬 persistence에 `data/index.json`과
`data/pre/2020/01.csv.gz`를 `wrangler r2 object put ... --local`로만 넣고, 아래 서버를 실행했다.

```text
npx wrangler dev --local --persist-to .wrangler/local-test \
  --var GATE_PASSWORD:test-secret --port 8790

a GET / -> 401
b GET /app.js -> 401
c authenticated GET / -> 200 content-type=text/html; charset=utf-8
d raw key -> 404
e state key -> 404

HTTP/1.1 200 OK
Content-Type: application/gzip
Cache-Control: private, max-age=31536000, immutable
ETag: "5bfd74bc05d36b40048012cf382fea01"
```

위 gzip 헤더에는 `Content-Encoding`이 없었다. 동일 ETag를 `If-None-Match`로 보낸 실제 조건부
GET 결과는 `conditional GET -> 304`였다. 로컬 임시 R2 persistence는 검증 후 삭제했다.

### 기존 devserver

```text
> npm run serve
로컬 서버: http://127.0.0.1:8788/public/

> curl http://127.0.0.1:8788/public/
devserver GET /public/ -> 200 content-type=text/html; charset=utf-8
```

## 검증하지 못한 항목

- 실제 원격 R2 객체 조회: 배포 자격증명이 없고, 실버킷 쓰기·삭제 금지 지시에 따라 수행하지 않음
- 실제 Cloudflare 배포 URL의 게이트/Assets/R2 통합: 배포 자격증명과 배포 권한이 없어 수행하지 않음
- Context7 MCP 조회: 세션에 서버가 등록되지 않아 불가능; 위 공식 Cloudflare 문서로 대체

## 사용자 배포 명령 순서

```powershell
npm ci
npm test
npx wrangler login
npx wrangler secret put GATE_PASSWORD
npm run deploy
```

배포 직후 `<WORKER_URL>`에서 아래 순서로 확인한다. 실제 암호는 셸 기록 노출에 유의한다.

```powershell
curl.exe -i https://<WORKER_URL>/
curl.exe -i https://<WORKER_URL>/app.js
curl.exe -i -H "X-Gate-Password: <PASSWORD>" https://<WORKER_URL>/
curl.exe -i -H "X-Gate-Password: <PASSWORD>" https://<WORKER_URL>/data/raw/bid/2023/12/11.csv.gz
curl.exe -i -H "X-Gate-Password: <PASSWORD>" https://<WORKER_URL>/data/state/sync-state.json
curl.exe -I -H "X-Gate-Password: <PASSWORD>" https://<WORKER_URL>/data/pre/2020/01.csv.gz
```

마지막 응답은 `Content-Type: application/gzip`, 과거 월 파일의 immutable Cache-Control, ETag를
가져야 하며 `Content-Encoding`은 없어야 한다. 이어 ETag를 `If-None-Match`로 보내 304도 확인한다.
