# downloader — 첨부 다운로드

수집된 본공고 CSV에서 관심 공고를 고른 뒤, 제안요청서·과업내용서 등 첨부만 `../data/files/bid/<공고번호>/`에 내려받습니다.

```powershell
node downloader/attachments.js --dry-run   # 대상 공고/첨부 건수만 확인
node downloader/attachments.js
```

`download.config.json`으로 대상을 정합니다.

| 키 | 의미 |
| --- | --- |
| `mode` | `bid`(본공고) / `pre`(사전공고) |
| `begin` | 이 날짜 이후 공고만 대상 |
| `institutions` | 수요기관 이름 부분 일치 목록. 비우면 전체 |
| `fileNamePattern` | 내려받을 첨부 파일명 정규식 |
| `maxNoticesPerRun` | 1회 실행 최대 공고 수 (`--limit N`으로 덮어쓰기) |
| `concurrency` | 동시 다운로드 수 |

이미 받은 파일은 건너뛰고, 실패 목록은 `../data/download-errors.json`에 남습니다.
