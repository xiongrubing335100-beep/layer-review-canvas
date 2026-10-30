// Record existing terminal artifacts in an isolated acceptance only.
import {readFile, readdir, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import assert from 'node:assert/strict';
import {applyAttemptEvent} from '../src/v2/batch.js';

const root=path.resolve(process.argv[2]);
const json=async file=>JSON.parse(await readFile(file,'utf8'));
const acceptance=await json(path.join(root,'acceptance.json'));
assert.equal(acceptance.origin,'explicit_user_requested_real_acceptance');
assert.equal(acceptance.bridgeDeliveryTest,false);
for(const {attempt} of acceptance.batch.items) {
  const outcomes=[];
  for(const kind of ['candidates','failures']) {
    const directory=path.join(root,kind,attempt.attemptId);
    let files=[];
    try {files=await readdir(directory);} catch(error) {if(error.code!=='ENOENT') throw error;}
    for(const file of files.filter(name=>kind==='failures'?name==='failure.json':name.endsWith('.json'))) {
      outcomes.push({kind,record:await json(path.join(directory,file))});
    }
  }
  assert.equal(outcomes.length,1,'Exactly one terminal artifact is required');
  const {kind,record}=outcomes[0];
  for(const key of ['attemptId','documentId','layerId','dispatchId']) assert.equal(record[key],attempt[key]);
  const file=path.join(root,'attempts',attempt.attemptId+'.json');
  const previous=await json(file);
  const type=kind==='candidates'?'suggested':'failed';
  if(previous.execution===type) continue;
  assert.equal(previous.execution,'running');
  const next=applyAttemptEvent(previous,{eventId:randomUUID(),type,
    attemptId:attempt.attemptId,dispatchId:attempt.dispatchId,
    payload:type==='suggested'?{versionId:record.versionId}:{error:record.error}});
  await writeFile(file,JSON.stringify(next,null,2)+'\n');
  console.log(JSON.stringify({attemptId:attempt.attemptId,execution:next.execution}));
}
