import test from 'node:test';
import assert from 'node:assert/strict';
import {gradeGroups} from './ecr-grade-groups.js';
test('표준 규격 추가 참조는 해당 기반 규격만 포함하며 다른 파생 규격은 섞지 않는다',()=>{
  const device=g=>`구분: ${g} 서버\n규격: 예상 Core: 36\n`;
  const spec=(g,value)=>`규격 구분: ${g}\n장치: \n세부규격: ${value}\n`;
  const source=['가급','나급','가급-2','나급-2'].map(device).join('')
    +spec('가급 (표준)','CPU 3.1GHz 메모리 16GB')+spec('나급 (표준)','CPU 2.6GHz 메모리 8GB')
    +spec('가급-2','가급(표준) 규격에 추가 - GPU A100 x 2')+spec('나급-2','나급(표준) 규격에 추가규격 - 디스크 100TB');
  const groups=gradeGroups(source);assert.equal(groups.length,4);
  assert.match(groups[2],/3.1GHz/);assert.match(groups[2],/A100/);assert.doesNotMatch(groups[2],/2.6GHz|100TB/);
  assert.match(groups[3],/2.6GHz/);assert.match(groups[3],/100TB/);assert.doesNotMatch(groups[3],/3.1GHz|A100/);
  assert.equal(gradeGroups(source.replace('가급(표준) 규격에 추가','없음(표준) 규격에 추가')),null);
  assert.equal(gradeGroups(source.replace('CPU 3.1GHz 메모리 16GB','가급-2(표준) 규격에 추가')),null);
});
test('등급별 장비에는 해당 등급 사양과 공통 조건만 연결한다',()=>{
  const device=(grade,name)=>`구분: ${grade} ${name}\n규격: 예상 Core: 4\n`;
  const spec=(grade,label,value)=>`규격 구분: ${grade}\n장치: ${label}\n세부규격: ${value}\n`;
  const source='요구사항 번호 ECR-001\n서버\n'+device('가급','A')+device('가급','B')+device('나급','C')
    +'참고 기술 사양\n'+spec('가급','메모리','1024GB')+spec('나급','메모리','512GB')+spec('공통','전원','이중화')+'이중화 대상에 한하여 HA 제공';
  const groups=gradeGroups(source);
  assert.equal(groups.length,2);
  assert.match(groups[0],/가급 A/);assert.match(groups[0],/가급 B/);assert.match(groups[0],/1024GB/);assert.doesNotMatch(groups[0],/나급 C|512GB/);
  assert.match(groups[1],/나급 C/);assert.match(groups[1],/512GB/);assert.doesNotMatch(groups[1],/1024GB/);
  for(const group of groups){assert.match(group,/전원\n세부규격: 이중화/);assert.match(group,/이중화 대상에 한하여 HA 제공/);}
  assert.equal(gradeGroups(source.replace('나급 C','알수없음 C')),null);
});
