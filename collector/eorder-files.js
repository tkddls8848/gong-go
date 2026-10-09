// 본공고의 "제안요청정보" 첨부(e발주 첨부파일정보)를 공고 레코드에 붙인다.
// 입찰공고 목록 API(*PPSSrch)의 ntceSpecDocUrl 계열은 공고 첨부만 준다. 협상계약 용역은 제안요청서를
// 공고 첨부가 아니라 제안요청정보로 올리는 일이 많아, 같은 서비스의 별도 오퍼레이션
// getBidPblancListInfoEorderAtchFileInfo가 공고번호·차수별 파일 목록을 따로 준다.
// 응답은 파일 한 건이 한 행이라, 공고 행에 번호 붙은 컬럼 계열로 펼쳐 저장한다.
const COUNT = 10;
const SERIES = (prefix) => Array.from({ length: COUNT }, (_, index) => `${prefix}${index + 1}`);
const URL_PREFIX = "eorderAtchFileUrl";
const NAME_PREFIX = "eorderAtchFileNm";
const KIND_PREFIX = "eorderDocDivNm";
const EORDER_COLUMNS = [...SERIES(URL_PREFIX), ...SERIES(NAME_PREFIX), ...SERIES(KIND_PREFIX)];

const ordOf = (item) => Number(String(item?.bidNtceOrd ?? "").replace(/\D/g, "") || 0);

// 공고번호별로 묶는다. 정정공고는 차수마다 목록을 다시 올리므로 가장 높은 차수의 목록만 쓴다 —
// 차수를 섞으면 "수정본" 이전 제안요청서가 함께 남는다. 제안요청서를 앞에, 그다음 첨부 순번 순.
function groupEorderFiles(items) {
  const groups = new Map();
  for (const item of Array.isArray(items) ? items : []) {
    const number = String(item?.bidNtceNo || "").trim();
    const url = String(item?.eorderAtchFileUrl || "").trim();
    if (!number || !/^https?:/i.test(url)) continue;
    const ord = ordOf(item);
    const group = groups.get(number);
    if (group && group.ord > ord) continue;
    const file = { url, name: String(item.eorderAtchFileNm || "").trim(), kind: String(item.eorderDocDivNm || "").trim(), sno: Number(item.atchSno) || 0 };
    if (!group || group.ord < ord) groups.set(number, { ord, files: [file] });
    else if (!group.files.some((known) => known.url === url)) group.files.push(file);
  }
  for (const group of groups.values()) {
    group.files.sort((a, b) => (b.kind === "제안요청서") - (a.kind === "제안요청서") || a.sno - b.sno);
    group.truncated = Math.max(0, group.files.length - COUNT);
    group.files = group.files.slice(0, COUNT);
  }
  return groups;
}

// 같은 공고를 두 범위가 함께 받으면 높은 차수를 남긴다. 같은 차수면 나중 응답이 이긴다.
function mergeGroups(target, groups) {
  for (const [number, group] of groups) {
    const known = target.get(number);
    if (!known || known.ord <= group.ord) target.set(number, group);
  }
  return target;
}

// 이전 값은 모두 지우고 새 목록으로 채운다. 빈 슬롯은 만들지 않는다(빈 셀은 CSV에서 비용이 없지만
// 원본에 없는 열을 만들지 않는다는 project()의 원칙과 맞춘다).
function withEorderFiles(record, files) {
  const result = withoutEorderFiles(record);
  files.forEach((file, index) => {
    result[`${URL_PREFIX}${index + 1}`] = file.url;
    result[`${NAME_PREFIX}${index + 1}`] = file.name;
    result[`${KIND_PREFIX}${index + 1}`] = file.kind;
  });
  return result;
}
function withoutEorderFiles(record) {
  const result = { ...record };
  for (const key of EORDER_COLUMNS) delete result[key];
  return result;
}
function eorderFilesOf(record) {
  const files = [];
  for (let index = 1; index <= COUNT; index += 1) {
    const url = record?.[`${URL_PREFIX}${index}`];
    if (url) files.push({ url, name: record[`${NAME_PREFIX}${index}`] || "", kind: record[`${KIND_PREFIX}${index}`] || "" });
  }
  return files;
}

module.exports = { EORDER_COLUMNS, groupEorderFiles, mergeGroups, withEorderFiles, eorderFilesOf };
