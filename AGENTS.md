# gong-go

나라장터 공고를 수집·저장하고, 로그인 게이트 뒤에서 검색하게 하며, 제안요청서 첨부에서 장비 규격(ECR)을 AI로 추출하는 서비스입니다. Cloudflare Worker + R2 + Workers AI, 수집은 GitHub Actions, 첨부 다운로드와 로컬 분석은 로컬 PC에서 돕니다.

구조와 흐름은 [ARCHITECTURE.md](ARCHITECTURE.md), 파일 위치는 [기능별 코드 지도](docs/code-map.md)를 봅니다.

| 디렉터리 | 실행 주체 | 책임 |
| --- | --- | --- |
| `src/` | Cloudflare Worker | 인증 순서, 라우팅, R2 제공, AI, cron |
| `public/` | 브라우저(전부 배포됨) | 화면 조립, 검색, ECR UI, 내보내기 |
| `collector/` · `uploader/` | GitHub Actions, 로컬 | 수집·압축·인덱스, R2 업로드 |
| `downloader/` · `analyzer/` | 로컬 PC | 첨부 다운로드, 로컬 ECR 추출(운영 경로 아님) |
| `test/` · `tools/` | `npm test`, 수동·CI | 화면·계약 테스트, smoke·평가 도구 |

# 코드 탐색과 변경

- 먼저 [기능별 코드 지도](docs/code-map.md)에서 구현과 대응 테스트를 찾는다. 작업과 관련된 파일·문서만 읽는다.
- public/app.js는 화면 조립과 컨트롤, src/worker.js는 인증 순서와 라우팅을 맡는다. 새 기능의 로직은 같은 디렉터리의 기능 모듈에 둔다.
- 브라우저 기능은 생성 함수에 상태와 의존성을 명시한다. 테스트는 모듈을 직접 호출하며 함수 소스를 잘라 실행하지 않는다.
- 최상위 운영 모듈(collector, downloader, analyzer, uploader, src, public) 사이의 런타임 import는 만들지 않는다. 같은 모듈 내부의 기능 분리는 허용한다. 계약 테스트는 작성기와 독자를 연결할 수 있다.
- CSV·인덱스 형식 변경 시 README의 계약 표와 대응 작성기·독자 테스트를 함께 확인한다.
- public/은 전부 배포된다. 화면 테스트는 test/, 나머지 테스트는 구현 옆에 둔다.
- docs/history/는 과거 기록이다. 현재 작업 계획이나 배포 상태로 해석하지 않는다.
- 기본 검증은 npm test. 화면 연결 변경은 npm run test:browser, Worker 연결 변경은 npm run test:runtime, 번들 변경은 npx wrangler deploy --dry-run으로 검증한다.
- 데이터와 산출물은 .gitignore를 따른다. 일반 코드 탐색에서 data/, node_modules/, .wrangler/, test-results/, PDF, package-lock.json 전체를 읽지 않는다.
- 같은 기능의 모듈 간 사본(CSV 파서, 인덱스 규칙, Node 유틸, 서비스 표)은 의도된 것이다. 합치지 말고 계약 테스트로 묶여 있는지 확인한다.
- src/ecr.js의 VERSION은 표 선별이나 구간 나누기를 고치면 반드시 올린다. 올리지 않으면 예전 방식으로 자른 구간을 재사용해 고친 것이 반영되지 않는다.

# 명령

```
npm test                        # 기본 검증(node --test)
npm run test:browser            # 화면 연결 변경 시
npm run test:runtime            # Worker 연결 변경 시
npm run test:selection          # ECR 표 선별 변경 시(저장소 밖 실문서 필요, CI에 없음)
npx wrangler deploy --dry-run   # 번들 변경 시
npm run deploy                  # 배포. 자동 배포는 없다
```

**typecheck와 lint 명령은 없다.** TypeScript도 린터 설정도 쓰지 않는다. 찾지 말고, 타입 안전은 런타임 검증과 계약 테스트로 확보한다.

# 의존성

런타임 의존은 `@aws-sdk/client-s3` 하나뿐이다. 새 dependency는 Worker 번들 크기와 무료 한도에 바로 영향을 주므로, 표준 API나 기존 모듈로 안 되는 경우에만 추가하고 이유를 PR에 적는다. Node 22.7 이상이 필요하다(`engines`). `package.json`에 `"type"`이 없다 — src/는 ESM, 나머지는 CJS이고 어느 쪽으로 선언해도 한쪽이 깨진다.

# 수정하면 안 되는 것

- `package-lock.json` — `npm` 명령으로만 바뀐다.
- `public/vendor/` — 서드파티 번들.
- `data/`, `.wrangler/`, `test-results/` — 산출물.
- `docs/history/` — 과거 기록.

# 중요한 제약

- ECR 구간 상한 33은 임의값이 아니다. 무료 Worker의 요청당 subrequest 한도 50에서 예산 재시도와 구간 표식 몫을 뺀 역산값이다.
- ECR 분석 결과는 저장하지 않는다. 작업 키만 R2에 두고 정리한다.
- AI 예약은 되돌릴 근거가 없으면 그대로 둔다. 초과 사용 쪽으로 기울지 않는다.
- 사용자에게 내부 오류 메시지나 스택을 노출하지 않는다. 실패를 성공으로 표시하지 않는다.
- DB도 migration도 없다. 스키마 변경은 CSV·인덱스 형식과 `SCHEMA_VERSION` 취급으로 나타난다.
