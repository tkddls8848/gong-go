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
