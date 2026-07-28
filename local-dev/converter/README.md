# converter — 문서 변환

`../data/files/bid/`의 첨부를 분석 가능한 형태로 정규화합니다. 외부 의존성 없이 동작합니다.

- `.hwp` → 한글 COM 자동화(`hwp-to-hwpx.ps1`)로 HWPX 변환 후 Markdown 추출
- `.hwpx` → 표 병합(colSpan/rowSpan)을 보존한 Markdown 추출 (`hwpx-table.js`)
- `.pdf` → 변환 없이 원본 경로만 manifest에 기록
- `.zip` → 2단계까지 풀어 내부 문서를 같은 규칙으로 처리 (`zip-read.js`)

```powershell
node converter/convert.js
node converter/convert.js --limit 5 --concurrency 1 --hwp-timeout-ms 120000
```

산출물은 `../data/norm/bid/<공고번호>/`(HWPX), `../data/text/bid/<공고번호>/`(`NN.md.gz`, `manifest.json`)에 저장됩니다.

HWP 변환은 설치된 한글 프로그램의 COM 자동화를 사용하므로 Windows에서만 동작합니다. 첫 실행에서는 `--limit`으로 소량만 돌려 보안 팝업과 성공률을 먼저 확인하세요.
