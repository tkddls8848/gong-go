import test from 'node:test';
import assert from 'node:assert/strict';
import {prepareSelection} from '../tools/pdf-selection-entry.mjs';
import {readSelectionPayload} from '../src/ecr-input.js';
import {selectDocument,splitDocument} from '../src/ecr.js';
import {sourceCoverage} from '../src/ecr-coverage.js';

test('브라우저 선별 전송은 표 원문과 대상/제외 번호를 서버 선별과 동일하게 유지한다',()=>{
  const text='요구사항 번호 ECR-001\n요구사항 명칭 DB 서버\n세부내용 CPU 16core 메모리 128GB\n요구사항 번호 ECR-002\n요구사항 명칭 운영체제 교체\n세부내용 OS 라이선스 제공';
  const original=selectDocument(text),payload=prepareSelection(text),received=readSelectionPayload(JSON.stringify(payload));
  assert.deepEqual(received.sections.map(s=>s.text),original.sections.map(s=>s.text));
  assert.deepEqual(sourceCoverage(received),sourceCoverage(original));
  assert.deepEqual(splitDocument(text,received),splitDocument(text,original));
});

test('선별 전송의 형식·크기·번호 위조 및 빈 선별 결과를 거부한다',()=>{
  const payload=prepareSelection('요구사항 번호 ECR-001\n요구사항 명칭 DB 서버\n세부내용 CPU 16core 메모리 128GB');
  for(const changed of [null,{...payload,sourceChars:2000001},{...payload,sections:[]},{...payload,ids:[]},
    {...payload,sections:[{...payload.sections[0],id:'ECR-999'}]},
    {...payload,sections:[{...payload.sections[0],text:'x'.repeat(120001)}]}])
    assert.throws(()=>readSelectionPayload(JSON.stringify(changed)));
  assert.throws(()=>prepareSelection('일반 안내문'));
});

test('선별 전송도 33구간 서버 상한을 우회하지 못한다',()=>{
  const texts=Array.from({length:70},(_,i)=>`요구사항 번호 ECR-${String(i+1).padStart(3,'0')}\n요구사항 명칭 서버\n세부내용 CPU 16core 메모리 128GB ${'규격 '.repeat(400)}`);
  const received=readSelectionPayload(JSON.stringify(prepareSelection(texts.join('\n'))));
  assert.throws(()=>splitDocument('',received),e=>e.status===413);
});
