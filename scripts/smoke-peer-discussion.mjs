// Live CLI subscription test with synthetic text and an isolated ChatterBox database.
import { build } from "esbuild";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const base = join(root, ".scratch", `peer-discussion-live-${Date.now()}`);
const work = join(base, "workspace");
mkdirSync(work, { recursive: true });
writeFileSync(join(work, "AGENTS.md"), "Use only the ChatterBox bridge. This is a read-only discussion of synthetic UI text. Do not run commands or read other projects.\n");
const main = join(base, "main.cjs");
await build({ stdin: { resolveDir: root, loader: "ts", contents: `
import {app} from 'electron';
import {join} from 'node:path';
import {writeFileSync} from 'node:fs';
import {Store} from './src/main/db';
import {ChatManager} from './src/main/chats';
import {Orchestrator} from './src/main/orchestrator';
import {DEFAULT_SETTINGS} from './src/shared/types';
const base=${JSON.stringify(base)},work=join(base,'workspace');
app.setPath('userData',join(base,'electron'));
app.on('window-all-closed',()=>{});
void app.whenReady().then(async()=>{
 const store=new Store(join(base,'test.db')), events:any[]=[], checks:any[]=[];
 const chats=new ChatManager(store,{agents(){},chat(){},consult(){},usage(){},event(e){
  events.push(e);
  if(e.event.type==='approval_request'){
   const request=e.event.request;
   const safe=request.risk==='low'&&/^mcp__chatterbox_bridge__(set_expression|ask|agents)$/.test(request.title);
   queueMicrotask(()=>chats.approvals.answer(e.chatId,request.id,safe?'once':'deny'));
  }
 }},base,join(base,'bridge-mcp.cjs'));
 const engine=new Orchestrator(chats);
 const check=(name:string,ok:unknown)=>{checks.push({name,ok:!!ok});};
 let error='',timer:ReturnType<typeof setTimeout>|undefined;
 try{
  await chats.start();
  const project=store.createProject('Synthetic peer discussion',work,{...DEFAULT_SETTINGS,orchestratorModel:'claude:opus',orchestratorEffort:'xhigh',claudeModel:'sonnet',codexModel:'gpt-6.1-sol',reviewGate:false,approvalMode:'user',maxGeminiWorkers:0});
  const chat=store.createChat(project.id,'Native peer discussion smoke');
  timer=setTimeout(()=>void engine.stop(chat.id),180000);
  await chats.send(chat.id,'앱의 주제별 직접 토의 기능을 검증하자. 클로드 작업자 한 명과 지피티 작업자 한 명만 만들고, 클로드를 진행자로 ask(kind=opinion, effort=medium, discussion={topic:"로그인 완료 안내 문구",peers:[지피티 닉네임]})로 맡겨라. 논의할 가정은 로그인 성공이 확인되면 창이 자동으로 닫히고 앱에 완료 안내가 보인다는 것이다. 진행자는 짧은 안내 문구 초안을 제시한 뒤 참여자에게 앱 ask로 직접 의견을 받아, 합의한 두 문장과 선택 이유를 마스터에게 돌려줘야 한다. 마스터는 그룹 최종 결과만 짧게 취합하라. 파일 읽기·수정·명령 실행·이미지·웹 호출은 하지 말고 이 메시지의 가정만 사용한다. 중요한 오류의 독립 조사는 이번 텍스트 토의에는 필요 없다.',[]);
  const deadline=Date.now()+180000;
  while(['working','approval'].includes(store.chat(chat.id)!.status)&&Date.now()<deadline)await new Promise(r=>setTimeout(r,250));
  if(['working','approval'].includes(store.chat(chat.id)!.status))await engine.stop(chat.id);
  const workers=store.listAgents(chat.id), consults=store.listConsults(chat.id);
  const group=consults.find(c=>c.fromRole==='orch'&&c.request.startsWith('[토의 그룹:'));
  const peer=group&&consults.find(c=>c.fromRole===group.toRole&&c.request.startsWith('[토의 주제:')&&c.status==='done');
  check('actual master completes the synthetic discussion',store.chat(chat.id)!.status==='done');
  check('only Claude and GPT workers were created',workers.length===2&&workers.some(a=>a.kind==='claude')&&workers.some(a=>a.kind==='gpt'));
  check('master assigned a grouped discussion to the coordinator',group?.status==='done');
  check('coordinator directly received a nonempty peer answer',peer&&peer.toRole!==group!.toRole&&!!peer.responseSummary?.trim());
  check('worker request appears under coordinator consult in the timeline',group&&events.some(e=>e.node==='consult:'+group.id&&e.event.type==='consult_start'&&e.event.from===group.toRole));
  check('peer reasoning inherits the master assignment',peer&&peer.effort===group!.effort);
  check('discussion did not change files',consults.every(c=>c.filesChanged.length===0));
  check('only harmless app-bridge permissions were approved',events.filter(e=>e.event.type==='approval_request').every(e=>e.event.request.risk==='low'&&/^mcp__chatterbox_bridge__(set_expression|ask|agents)$/.test(e.event.request.title)));
  check('master produced final synthesis after peer response',peer&&events.some(e=>e.role==='orch'&&e.event.type==='text'&&e.at>=peer.endedAt!&&e.event.text.trim()));
  writeFileSync(join(base,'results.json'),JSON.stringify({checks,workers:workers.map(a=>({kind:a.kind,nickname:a.nickname})),consults:consults.map(c=>({id:c.id,from:c.fromRole,to:c.toRole,status:c.status,request:c.request,result:c.responseSummary,effort:c.effort})),status:store.chat(chat.id)!.status},null,2));
 }catch(e){error=String(e);writeFileSync(join(base,'results.json'),JSON.stringify({checks,error},null,2));}
 finally{clearTimeout(timer);await engine.judge.dispose();await chats.dispose();store.close();app.exit(error||checks.some(c=>!c.ok)?1:0);}
});
` }, outfile: main, bundle: true, platform: "node", format: "cjs", external: ["electron"], logLevel: "error" });
await build({entryPoints:[join(root,'src/main/bridge-mcp.ts')],outfile:join(base,'bridge-mcp.cjs'),bundle:true,platform:'node',format:'cjs',logLevel:'error'});
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
await new Promise((resolve, reject) => execFile(join(root, "node_modules", "electron", "dist", "electron.exe"), [main],
  { cwd: root, env, windowsHide: true, timeout: 240000 }, (error, stdout, stderr) => {
    const report = existsSync(join(base, "results.json")) ? JSON.parse(readFileSync(join(base, "results.json"), "utf8")) : {checks:[],error:error?.message||'No test report'};
    for (const check of report.checks) console.log((check.ok ? "PASS " : "FAIL ") + check.name);
    console.log('Evidence: ' + base);
    if (error) reject(new Error(report.error || error.message)); else resolve(stdout);
  }));
