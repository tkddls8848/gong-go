# 기능별 코드 지도

작업할 기능의 구현과 테스트를 먼저 읽습니다. README는 개요, 이 문서는 파일 위치, 개별 문서는 동작·운영 설명을 맡습니다.

## 브라우저

[app.js](../public/app.js)는 화면 컨트롤, 관심 기관 프리셋, 기능 모듈 조립을 맡습니다.
[index.html](../public/index.html)의 스크립트 목록이 로딩 순서입니다. 기능 모듈은 생성 함수로 상태와 외부 의존성을 받으며 CommonJS에서도 직접 불러올 수 있습니다.

| 기능 | 구현 | 주요 테스트 |
| --- | --- | --- |
| 목록 검증·최신 요청 반영 | [data-index.js](../public/data-index.js) | [index-load-ui.test.js](../test/index-load-ui.test.js) |
| 검색 조건·최신 공고 병합 | [search.js](../public/search.js) | [dates.test.js](../test/dates.test.js), 브라우저 검증 |
| Worker 풀·한도·취소·대체 검색 | [search-scan.js](../public/search-scan.js) | worker-pool, search-limit, inline-cancel |
| CSV 스캔 메시지 처리 | [search-worker.js](../public/search-worker.js) | [search-cancel.test.js](../test/search-cancel.test.js) |
| CSV 읽기·행 모델·필터 | [rows.js](../public/rows.js) | rows, collector-reader-contract |
| 수집 시작·폴링·완료 반영 | [refresh.js](../public/refresh.js) | refresh-start-ui, refresh-race-ui, refresh-finish-ui |
| 자연어 응답 검증·적용 시점 | [nl-query.js](../public/nl-query.js) | [nl-query-ui.test.js](../test/nl-query-ui.test.js) |
| AI 잠금·해제 | [ai-access.js](../public/ai-access.js) | [ai-access-ui.test.js](../test/ai-access-ui.test.js) |
| ECR 업로드·중단·이번 결과 표시 | [ecr-ui.js](../public/ecr-ui.js) | ecr-load-ui, ecr-progress-ui |
| ECR 표·경고·원문 상세 | [ecr-view.js](../public/ecr-view.js) | ecr-view, exports |
| 장비 요약·결과 검증 | [equipment.js](../public/equipment.js) | equipment, ecr-data |
| 공고 링크·첨부·입찰 일정 | [notice-view.js](../public/notice-view.js) | notice-view |
| 상세 모달·포커스·탭 | [notice-modal.js](../public/notice-modal.js) | notice-modal, ecr-progress-ui, 브라우저 검증 |
| 공고·이번 ECR 결과 내보내기 | [exports.js](../public/exports.js), [csv.js](../public/csv.js) | exports, csv |
| 통신 시간 제한·오류 | [http.js](../public/http.js) | http |
| KST 날짜·표시·HTML 이스케이프 | [dates.js](../public/dates.js), [format.js](../public/format.js) | dates, notice-view |
| 테마·레이아웃·반응형 화면 | [style.css](../public/style.css) | ui-contract, 브라우저 검증 |

표에서 파일명만 적은 테스트는 모두 test/의 같은 이름에 .test.js를 붙입니다. public/ 전체가 배포 자산이므로 테스트는 그 밖에 둡니다.
공유 화면 모델에는 조회 목록·선택한 공고를 두고, 요청 세대·취소·잠금 변경 중 상태는 기능 인스턴스에 둡니다.
테스트는 생성 함수를 직접 호출합니다. 소스 문자열에서 함수 구간을 잘라 실행하지 않습니다.

## Cloudflare Worker

[worker.js](../src/worker.js)는 게이트 앞의 중계·robots 예외, 인증, API 라우팅, scheduled 진입점을 맡습니다.
경로·인증 순서·상류 응답 계약은 [worker.test.mjs](../src/worker.test.mjs)가 통합 검증합니다.

| 기능 | 구현 |
| --- | --- |
| 조회 비밀번호·쿠키·로그인 HTML | [gate.js](../src/gate.js) |
| R2 읽기·경로 제한·캐시 | [data.js](../src/data.js) |
| 최근 공고 조회·상류 캐시 | [live.js](../src/live.js) |
| 수집 요청·GitHub 상태·사용 한도·크론 | [refresh.js](../src/refresh.js) |
| 수집기용 API 중계 | [relay.js](../src/relay.js) |
| 자연어 HTTP·모델 호출 | [ask-handler.js](../src/ask-handler.js) |
| 자연어 스키마·규칙 파서·날짜 해석 | [ask.js](../src/ask.js) |
| ECR 작업·추론·결과 응답(저장 없음) | [ecr.js](../src/ecr.js) |
| ECR 원문 선별·번호 대조·오류 | ecr-source.js, ecr-coverage.js, ecr-errors.js |
| AI 권한·예산 | ai-access.js, ai-budget.js |

나머지 Worker 테스트는 src/의 해당 이름에 .test.mjs를 붙입니다.

## 수집·로컬 파이프라인

| 기능 | 구현 |
| --- | --- |
| 수집 계획·체크포인트·레코드 저장 | [collector/collector.js](../collector/collector.js) |
| 공공 API·페이지·동시 실행·재시도 | [collector/api.js](../collector/api.js) |
| CSV 작성 형식·서비스 컬럼·인덱스 | collector/csv-record.js, service-columns.js, store.js |
| 월별 봉인·복구·백필 계획 | collector/compact.js, restore-r2.js, backfill-plan.js |
| 첨부 다운로드 | [downloader/attachments.js](../downloader/attachments.js) |
| 기존 로컬 분석 | [analyzer/analyze.js](../analyzer/analyze.js) |
| R2 업로드·삭제 계획 | [uploader/upload.js](../uploader/upload.js) |
| 운영 스케줄·CI | [.github/workflows](../.github/workflows), [wrangler.jsonc](../wrangler.jsonc) |

테스트는 각 구현 옆에 있습니다. 운영 ECR은 src/ecr.js이며 analyzer/는 로컬 도구입니다.
최상위 실행 모듈끼리는 런타임 코드를 공유하지 않습니다. CSV·인덱스 형식의 사본은 [README의 계약 표](../README.md#모듈-경계--공유-코드를-두지-않는다)와 [데이터 계약](data-contracts.md)을 따릅니다. 실제 작성기·독자 연결 검증은 test/collector-reader-contract.test.js에 있습니다.

## 검증과 기록

단위·계약 검증은 npm test, 실제 화면 조립은 npm run test:browser, Worker·로컬 R2는 npm run test:runtime, 합성 CSV 부하는 npm run test:search-load로 확인합니다.
브라우저·런타임 검증 도구는 tools/에 있습니다. 운영 시크릿과 원격 AI를 사용하지 않습니다.
과거 결정과 조사 수치는 [기술 기록 목록](프로젝트-통합-문서.md)에서 필요한 주제만 확인합니다.
