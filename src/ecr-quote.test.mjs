import test from "node:test";
import assert from "node:assert/strict";
import { groundQuote, valueInQuote, includesEvidence } from "./ecr-quote.js";

// 사례는 모두 실문서에서 모델이 실제로 돌려준 인용이다. 예전에는 모두 "근거 검증 실패"로 버려졌다.
const verified = (source, evidence, value) => {
  const quote = groundQuote(source, evidence, value);
  return includesEvidence(source, quote) && valueInQuote(quote, value) ? quote : null;
};

test("모델이 원문의 목록 번호를 떼고 줄 표식을 붙인 인용은 원문 줄로 확인한다", () => {
  const source = "상세 요구 사항\n3. 저장장치 사용공간은 RAID10 구성으로 19TB 이상, 확장을\n고려한 구성이어야 한다.";
  const quote = verified(source, "[L9] 저장장치 사용공간은 RAID10 구성으로 19TB 이상, 확장을", "19TB 이상");
  assert.ok(quote && source.includes(quote));
});

test("글머리표를 바꾼 인용(※ → -)도 원문에 그대로 있으면 확인한다", () => {
  const source = "- Hot Spare : 전체 디스크의 3% 이상\n※ 최소 수량 2개 이상\n- 컨트롤러 : 2개";
  assert.ok(verified(source, "- 최소 수량 2개 이상", "최소 수량 2개 이상"));
  assert.ok(verified(source, "16. - 최소 수량 2개 이상", "최소 수량 2개 이상"));
});

test("표의 항목명 칸과 값 칸을 이어 적은 인용은 두 칸이 가까이 있을 때만 확인한다", () => {
  const source = "GPU서버\nCPU\n- 3.6GHZ 16core*2CPU or 2.0GHZ 56core*2CPU\nMemory\n- 1TB 이상";
  const quote = verified(source, "- CPU - 3.6GHZ 16core*2CPU or 2.0GHZ 56core*2CPU", "3.6GHZ 16core*2CPU or 2.0GHZ 56core*2CPU");
  assert.ok(quote && source.includes(quote));
  // 항목명이 값과 멀리 떨어져 있으면 잇지 않는다.
  const far = `CPU\n${"공통 요구사항 문장입니다. ".repeat(30)}\n- 3.6GHZ 16core*2CPU`;
  assert.equal(groundQuote(far, "- CPU - 3.6GHZ 16core*2CPU", "3.6GHZ 16core*2CPU").includes("공통"), false);
});

test("값이 인용한 줄의 다음 줄까지 이어지면 사이에 낀 표 칸 머리를 건너 원문 토막으로 확인한다", () => {
  const source = "- 컨트롤러 : Active-Active 방식으로 4 개 이상의 컨트롤러를 구성하고,\n요구\n수평(스케일 아웃) 확장구조로 컨트롤러 확장이 가능해야 함\n- 캐시메모리 : 1024 GB 이상";
  const value = "Active-Active 방식으로 4 개 이상의 컨트롤러를 구성하고, 수평(스케일 아웃) 확장구조로 컨트롤러 확장이 가능해야 함";
  const quote = verified(source, "- 컨트롤러 : Active-Active 방식으로 4 개 이상의 컨트롤러를 구성하고,", value);
  assert.ok(quote && source.includes(quote));
  assert.equal(quote.includes("캐시메모리"), false);
});

test("원문에 없는 값, 바꿔 쓴 문장은 여전히 확인하지 않는다", () => {
  const source = "- 메모리 : 1600GB 이상 (1대 각 800GB 이상)\n- 2대 서버 각 OS는 Oracle RAC로 구성하여야한다.";
  assert.equal(verified(source, "- 메모리 : 1600GB 이상", "3200GB 이상"), null);
  assert.equal(verified(source, "- Oracle RAC 클러스터를 구성한다.", "Oracle RAC 클러스터"), null);
  // 숫자 사이 공백은 다른 수다.
  assert.equal(verified("메모리 1 28GB", "메모리 128GB", "128GB"), null);
});

test("모델이 값 앞에 덧붙인 괄호 문구는 떼고, 인용 사이의 원문에 없는 짧은 칸 이름은 건너뛴다", async () => {
  const { groundValue } = await import("./ecr-quote.js");
  const source = "○ 기타\n- 설치에 필요한 소모품의 규격은 공사 기준에 따름\n- 컨트롤러 : Active-Active 방식으로 4 개 이상의 컨트롤러를 구성하고,\n사항\n수평(스케일 아웃) 확장구조로 컨트롤러 확장이 가능해야 함";
  const quote = groundQuote(source, "- 설치에 필요한 소모품의 규격은 공사 기준에 따름", "(공사 기준에 따름) 설치에 필요한 소모품의 규격은 공사 기준에 따름");
  assert.equal(groundValue(quote, "(공사 기준에 따름) 설치에 필요한 소모품의 규격은 공사 기준에 따름"), "설치에 필요한 소모품의 규격은 공사 기준에 따름");
  const value = "Active-Active 방식으로 4 개 이상의 컨트롤러를 구성하고, 수평(스케일 아웃) 확장구조로 컨트롤러 확장이 가능해야 함";
  assert.ok(verified(source, "- 컨트롤러 : Active-Active 방식으로 4 개 이상의 컨트롤러를 구성하고,\n사양\n수평(스케일 아웃) 확장구조로 컨트롤러 확장이 가능해야 함", value));
  // 괄호 문구를 떼어도 원문에 없으면 그대로 둔다.
  assert.equal(groundValue(quote, "(참고) 3년 무상 유지보수"), "(참고) 3년 무상 유지보수");
});

test("괄호 없는 줄 표식, 앞뒤 대시, 항목 이름을 감싼 괄호를 뗀 인용도 원문에 그대로 있으면 확인한다", async () => {
  const { groundValue } = await import("./ecr-quote.js");
  // 국방획득: 놓쳤던 PTL 드라이브의 규격이 모두 이 모양이었다.
  const ptl = "◦ 수량\n구분 1센터 2센터\nPTL 드라이브 15EA -\n◦ 요구규격\n* 인터페이스 : 8/16Gbps FC 지원\n* 슬롯 수량 : 최대 10,000 Slot 이상 확장 지원";
  assert.ok(verified(ptl, "L7 PTL 드라이브 15EA -", "15EA"));
  assert.ok(verified(ptl, "L14 * 인터페이스 : 8/16Gbps FC 지원", "인터페이스 : 8/16Gbps FC 지원"));
  // VTL: 원문 "14. RAID 6 …"을 "-RAID 6 … 제공-"으로 적었다.
  const vtl = "솔루션 제공\n14. RAID 6 구성 및 자동 오류 복구 기능 제공\n기능";
  const value = "-RAID 6 구성 및 자동 오류 복구 기능 제공-";
  const quote = groundQuote(vtl, value, value);
  assert.ok(includesEvidence(vtl, quote));
  assert.equal(groundValue(quote, value), "RAID 6 구성 및 자동 오류 복구 기능 제공");
  // UNIX 서버: 원문 "B형(DB) : …"의 형 이름을 괄호로 감쌌다.
  const unix = "3. Clock\n요구용량 B형(DB) : 2.66GHz*16Core 이상\nSpeed\nC형(개발) : 2.66GHz*8Core 이상";
  const b = groundQuote(unix, "(B형(DB)) : 2.66GHz*16Core 이상", "(B형(DB)) : 2.66GHz*16Core 이상");
  assert.ok(includesEvidence(unix, b));
  assert.equal(groundValue(b, "(B형(DB)) : 2.66GHz*16Core 이상"), "B형(DB) : 2.66GHz*16Core 이상");
  assert.equal(groundValue("- 원활한 유지보수 및 기술지원을 위한 OEM 제품 제외", "(OEM 제품 제외)"), "OEM 제품 제외");
  // 대시를 떼어 숫자만 남는 값은 쪽 번호다. 떼지 않는다.
  assert.equal(groundValue("- 20 -", "-20-"), "-20-");
  // 값 안의 L3은 줄 표식이 아니다: 원문에 "L3"이 없으면 확인하지 않는다.
  assert.equal(verified("48Port 스위치", "L3 48Port 스위치", "L3 48Port 스위치"), null);
});
