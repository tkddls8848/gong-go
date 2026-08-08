# collector — 공고 수집

공공데이터포털 나라장터 API에서 사전공고·본공고를 받아 날짜별 CSV로 저장합니다.

1. 루트의 `.env.example`을 복사해 루트에 `.env`를 만들고 `SERVICE_KEY`를 설정합니다.
2. `sync.config.json`에서 수집 기간·공고 구분·업무 구분·동시성을 조정합니다.
3. `node collector/collector.js`를 루트에서 실행합니다.

수집 결과는 `../data/pre|bid/YYYY/MM/DD.csv.gz`, 파일 목록은 `../data/index.json`, 진행 상태는 `../data/sync-state.json`에 저장됩니다. 실행은 `sync-state.json`의 완료 작업 목록으로 재개되며, `sync.config.json`의 `resume: false`는 해당 구간을 다시 받아 덮어씁니다.

수집 범위는 `--begin`/`--end` > `SYNC_BEGIN`/`SYNC_END` 환경변수 > `sync.config.json` 순으로 정해집니다. 환경변수 경로는 GitHub Actions 크론이 최근 35일만 다시 받게 하려고 둔 것입니다.

`--migrate-only`는 API 호출 없이 데이터 디렉터리 이관·정리만 수행합니다.

## 월별 봉인 — `compact.js`

재수집 창 밖으로 완전히 나간 완료 월을 `../data/pre|bid/YYYY/MM.csv.gz` 하나로 묶습니다. 목적은 압축률이 아니라 **파일 수**입니다 — 배포본에서 파일 하나가 Function 호출 하나이고, 전 구간 조회가 4,760회에서 285회로 줄어듭니다(`index.json`도 560KB → 42KB). 한 달치를 이어붙여 재압축해도 용량은 1% 남짓밖에 줄지 않습니다.

```powershell
node collector/compact.js --dry-run   # 대상 월과 봉인 전후 파일 수만 출력
node collector/compact.js             # 봉인 (일별 파일은 남긴다)
node collector/compact.js --prune     # 결과 확인 후 일별 파일 정리
```

- 월의 마지막 날 + 40일(`--lag`)이 지난 달만 대상입니다. 재수집 창 안쪽을 묶으면 82KB를 받던 사용자가 당월 4.5MB를 매일 새로 받게 되어 오히려 손해입니다.
- 이어붙이기 전에 그 달 일별 파일의 **헤더가 전부 같은지** 확인하고, 다르면 그 달만 파싱해 컬럼 합집합으로 다시 씁니다. 봉인 뒤에는 **행 수를 다시 세어** 일별 합계와 대조하고, 틀리면 아무것도 쓰지 않고 그 달을 건너뜁니다.
- 이미 봉인된 달은 건너뜁니다. 두 번 돌리면 0개월입니다. 봉인한 뒤 그 달을 다시 수집했다면 `--reseal`로 명시해서 다시 만듭니다(새 봉인이 기존보다 행이 적으면 거부합니다).
- `--prune`은 일별 파일만 지웁니다. `data/raw/`의 170컬럼 원본은 최후 복구 경로로 남습니다.
- 봉인은 **전체 데이터가 있는 로컬에서 월 1회** 돌립니다. GitHub Actions 러너는 최근 35일치만 갖고 있어 묶을 재료가 없습니다.

봉인된 달은 `index.json`에서 항목 하나가 한 달을 덮습니다. 항목 스키마는 일별·월별 모두 `{mode, begin, end, path, count}`이고, 일별은 `begin === end`입니다.
