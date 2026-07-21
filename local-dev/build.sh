#!/usr/bin/env bash
# Cloudflare Pages 빌드용. 프로젝트 루트 디렉터리를 local-dev로 두고,
# 빌드 명령을 `bash build.sh`, 출력 디렉터리를 `public`으로 설정한다.
#
# collector/data 아래 배포 대상(gzip + index.json)만 public/data로 복사한다.
# 러너/로컬 상태 파일(sync-state.json 등)은 복사하지 않는다.
set -euo pipefail

SRC="collector/data"
DEST="public/data"

if [ ! -f "$SRC/index.json" ]; then
  echo "빌드 실패: $SRC/index.json 이 없습니다. 데이터를 커밋했는지 확인하세요." >&2
  exit 1
fi

rm -rf "$DEST"
mkdir -p "$DEST"
cp "$SRC/index.json" "$DEST/index.json"
[ -d "$SRC/pre" ] && cp -r "$SRC/pre" "$DEST/pre"
[ -d "$SRC/bid" ] && cp -r "$SRC/bid" "$DEST/bid"

echo "복사 완료: $(find "$DEST" -name '*.csv.gz' | wc -l)개 gzip → $DEST"
