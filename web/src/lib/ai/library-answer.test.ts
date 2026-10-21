import { describe, expect, test } from 'bun:test';
import { answerLibrary, hydrateLibraryAnswer } from './library-answer';
const sources = [{id:'s1',meetingId:'m1',title:'Test',startMs:0,endMs:1000,text:'Notebook on kitchen table. Bring three green apples.'}];
describe('library answer support and completeness', () => {
  test('hydrates server-owned exact evidence, never generated quotes or unknown IDs', () => {
    const reply = {claims:[{text:'Three green apples.',kind:'fact',sourceIds:['s1']}],unanswered:[]};
    expect(hydrateLibraryAnswer(reply,sources).claims[0].citations[0].quote).toBe(sources[0].text);
    expect(()=>hydrateLibraryAnswer({...reply,claims:[{...reply.claims[0],sourceIds:['invented']}]},sources)).toThrow('Unsupported library citation');
    expect(()=>hydrateLibraryAnswer({...reply,claims:[{...reply.claims[0],sourceIds:[]}]},sources)).toThrow();
  });
  test('bounded second pass can restore an omitted detail and expose unsupported parts', async () => {
    let calls=0;
    const answer = await answerLibrary({async run(_model,input){
      calls++;
      if(calls===2) expect(JSON.stringify(input)).toContain('draft');
      return {response: calls===1 ? {claims:[{text:'Kitchen table.',kind:'fact',sourceIds:['s1']}],unanswered:[]} : {claims:[{text:'Kitchen table; three green apples.',kind:'fact',sourceIds:['s1']}],unanswered:['Who bought the apples is not established.']}};
    }},'Where, how many apples, and who bought them?',sources);
    expect(calls).toBe(2);
    expect(answer.claims[0].text).toContain('three green apples');
    expect(answer.unanswered).toHaveLength(1);
  });
  test('invalid final output fails closed after the bounded audit', async () => {
    let calls=0;
    await expect(answerLibrary({async run(){calls++;return {response:{claims:[{text:'Invented.',kind:'request',sourceIds:[]}],unanswered:[]}};}},'What happened?',sources)).rejects.toThrow();
    expect(calls).toBe(2);
  });
});

test('omitted unanswered metadata does not reject otherwise valid evidence', () => {
  expect(hydrateLibraryAnswer({claims:[{text:'Three apples.',kind:'fact',sourceIds:['s1']}]},sources).unanswered).toEqual([]);
});
test('a malformed audit cannot silently restore an unsupported draft', async () => {
  let calls=0;
  await expect(answerLibrary({async run(){calls++;return {response:{claims:[{text:'Kitchen table.',kind:'fact',sourceIds:[calls===1?'s1':'invented']}],unanswered:[]}};}},'Where?',sources)).rejects.toThrow('The answer did not pass evidence verification. Please retry.');
  expect(calls).toBe(2);
});

test('truncated evidence is visible independently of model output', () => {
  const answer = hydrateLibraryAnswer({claims:[],unanswered:[]},[{...sources[0],contextTruncated:true}]);
  expect(answer.warnings?.[0]).toContain('Additional details may exist');
});

test('final audit uses an independent approved model and constrains citation IDs in the provider schema', async () => {
  const calls:{model:string;input:unknown}[]=[];
  await answerLibrary({async run(model,input){calls.push({model,input});return {response:{claims:[],unanswered:[]}};}},'Where?',sources);
  expect(calls[0].model).not.toBe(calls[1].model);
  expect(calls[1].model).toBe('@cf/meta/llama-3.3-70b-instruct-fp8-fast');
  expect(calls[1].input).toMatchObject({response_format:{type:'json_schema',json_schema:{properties:{claims:{items:{properties:{sourceIds:{items:{enum:['s1']}}}}}}}}});
});

test('a malformed draft still requires a validated independent audit', async () => {
  let calls=0;
  const answer=await answerLibrary({async run(_model,input){calls++;if(calls===2){expect(JSON.stringify(input)).toContain('No valid draft exists');expect(JSON.stringify(input)).not.toContain('draftUnavailable');}return {response:calls===1?'invalid JSON':{claims:[{text:'Kitchen table.',kind:'fact',sourceIds:['s1']}],unanswered:[]}};}},'Where?',sources);
  expect(calls).toBe(2);
  expect(answer.claims[0].citations[0].id).toBe('s1');
});
