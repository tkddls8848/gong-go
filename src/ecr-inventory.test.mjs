import test from 'node:test';
import assert from 'node:assert/strict';
import {inventorySections} from './ecr-inventory.js';
import {selectDocument,splitDocument} from './ecr.js';
import {sourceCoverage} from './ecr-coverage.js';
const header='번호 품명 규격 및 사양 수량';
const list=`플랫폼 구축을 위한 기자재 목록(안)\n${header}\n1 가상화 서버 CPU 12core RAM 32GB 1\n\f\n${header}\n2 Storage Usable 10TB 2\n1-3) 다음 업무\n이후 기능 설명\n`;
test('번호 없는 도입 목록의 계속 쪽을 포함하고 다음 절에서 끝낸다',()=>{
  const [section]=inventorySections(list);
  assert.equal(section.id,'');
  assert.ok(section.text.includes('Storage Usable 10TB'));
  assert.ok(!section.text.includes('다음 업무'));
  assert.equal(inventorySections(list).length,1);
});
test('기존 현황·근거 없는 목록·이미 포함된 구간을 추가하지 않는다',()=>{
  assert.deepEqual(inventorySections(list.replace('플랫폼 구축을 위한 기자재 목록(안)','기존 장비 현황')),[]);
  assert.deepEqual(inventorySections(list.replace('플랫폼 구축을 위한 기자재 목록(안)','기자재 목록')),[]);
  assert.deepEqual(inventorySections(list,[{start:0,end:list.length}]),[]);
});
test('ECR 표가 있어도 앞쪽 도입 목록을 누락하지 않고 가짜 요구사항 번호를 만들지 않는다',()=>{
  const source=list+'요구사항 번호 ECR-001\n요구사항 명칭 업무 서버\n세부내용 CPU 16core 메모리 64GB\n';
  const selection=selectDocument(source);
  assert.ok(selection.sections.some(s=>s.unnumbered));
  assert.ok(selection.sections.some(s=>s.id==='ECR-001'));
  assert.ok(splitDocument(source).some(s=>s.includes('Storage Usable 10TB')));
  assert.deepEqual(sourceCoverage(selection).expectedIds,['ECR-001']);
});

test('셀로 복원한 물품 목록은 대상 장비별로 분리하고 PC 규격을 섞지 않는다',()=>{
  const source=`플랫폼 구축을 위한 기자재 목록\n${header}\n번호: 1\n품명: 서버\n규격: CPU 12core RAM 32GB\n수량: 1\n\n번호: 2\n품명: PC\n규격: CPU 2GHz RAM 16GB\n수량: 9\n\n번호: 3\n품명: Backup system\n규격: Storage usable 10TB 이상\n수량: 2\n1-3) 다음 절\n`;
  const sections=inventorySections(source);
  assert.equal(sections.length,2);
  assert.ok(sections[0].text.includes('품명: 서버'));
  assert.ok(sections[1].text.includes('품명: Backup system'));
  assert.ok(sections.every(s=>!s.text.includes('16GB')));
  assert.ok(sections.every(s=>s.id===''));
});
