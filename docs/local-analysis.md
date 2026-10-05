# 로컬 첨부·분석 도구

운영 화면의 Worker 분석과 별도로 실행하는 도구입니다. [운영 ECR 안내](ecr.md).

### 기존 로컬 일괄 분석 도구 (운영 화면에서는 사용하지 않음)

`analyzer/`의 Ollama·Anthropic CLI는 기존 일괄 분석용으로 남아 있으며 Worker에서 실행하지 않습니다.
`downloader/download.config.json`에서 기관과 파일명 조건을 정한 뒤 실행합니다.

```powershell
npm run attachments
npm run analyze -- --provider ollama --model qwen3.5-hermes-64k:latest
```

유료 분석 전에는 `--dry-run`으로 입력 토큰과 예상 비용을 확인합니다.

**Markdown 변환 단계는 이 저장소에 없습니다.** HWP/HWPX를 Markdown으로 바꾸는 일은 별도 저장소
`orca/convertors`가 맡습니다(한글 COM·HWPX 파서가 그쪽 기능이라 여기 둘 이유가 없습니다).
두 저장소가 맞추는 것은 코드가 아니라 **`data/` 산출물 규약**입니다 — 모듈 경계와 같은 원칙입니다.

운영 화면의 HWP/HWPX → **PDF** 변환은 이 경로와 다릅니다. 브라우저 안에서 끝내며 저장소 밖 변환기를
쓰지 않습니다. [브라우저 한글 문서 변환](hwp-conversion.md)을 봅니다.

| 이 저장소가 만드는 것 | 변환기가 읽고 쓰는 것 | 이 저장소가 읽는 것 |
| --- | --- | --- |
| `data/files/bid/<공고번호>/NN_이름.hwp` | 위 파일 → 변환 | `data/text/bid/<공고번호>/manifest.json` |
| | | `data/text/bid/<공고번호>/NN.md.gz` (gzip Markdown) |

`manifest.json`은 `{ notice, convertedAt, documents: [{ kind, source, markdown, originalName, ... }] }`
이고, `analyzer/analyze.js`는 `kind`가 `hwpx`인 항목의 `markdown` 경로와 `pdf` 항목의 `source`만
봅니다. 그 모양만 지키면 변환기를 무엇으로 바꾸든 분석 단계는 그대로입니다.
