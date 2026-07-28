# analyzer — ECR 규격 추출

`../data/text/bid/`의 변환 Markdown(및 PDF 원문)에서 시스템 장비 구성 요구사항(ECR)을 2-pass로 추출하고 검증합니다.

- Pass A: 요구사항 총괄표에서 사업개요·ID 목록 수집
- Pass B: ID 구간을 나눠 상세 규격 추출, 누락 ID는 최대 3회 재요청
- `verify.js`: 추출 ID와 총괄표 대조, `세부내용_원문`이 변환 텍스트에 실제로 존재하는지 확인

```powershell
node analyzer/analyze.js --dry-run          # 대상 건수·예상 비용만 확인
node analyzer/analyze.js                    # 기본: 로컬 Ollama
node analyzer/analyze.js --provider anthropic --model claude-opus-4-8 --yes
```

| 옵션 | 기본값 | 설명 |
| --- | --- | --- |
| `--provider` | `ollama` | `ollama` \| `anthropic` |
| `--model` | `qwen3.5-hermes-64k:latest` (anthropic이면 `claude-opus-4-8`) | 모델명 |
| `--ollama-context` | `8192` | Ollama `num_ctx` |
| `--limit`, `--concurrency` | `Infinity`, `1` | 대상 수·동시 실행 |
| `--force` | — | 이미 완료한 공고도 다시 분석 |
| `--yes` | — | Anthropic 비용 확인 생략 |

Ollama는 변환된 Markdown(HWPX 경로)이 필요하고 PDF 원문은 바로 분석하지 않습니다. Anthropic을 선택한 경우에만 `local-dev/.env`의 `ANTHROPIC_API_KEY`와 비용 승인이 필요합니다. API 키는 CLI에서만 읽으며 브라우저 코드에는 전달되지 않습니다.

결과는 `../data/analysis/bid/<공고번호>.json`, 목록은 `../data/analysis-index.json`, 진행 상태는 `../data/analysis-state.json`에 저장됩니다.
