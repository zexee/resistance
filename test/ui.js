const puppeteer = require('puppeteer-core');
const { startServer, stopServer } = require('./helper');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const NAMES = ['Alice', 'Bob', 'Carol', 'Dave', 'Eve'];
const ZODIAC = ['子鼠', '丑牛', '寅虎', '卯兔', '辰龙', '巳蛇', '午马', '未羊', '申猴', '酉鸡', '戌狗', '亥猪'];
const CHROME = process.env.CHROME_PATH || '/usr/bin/google-chrome';
let failures = 0;
let browser = null;

process.on('exit', () => {
  if (browser && browser.process()) {
    try { browser.process().kill(); } catch (e) {}
  }
});

function check(cond, msg) {
  if (cond) console.log('PASS', msg);
  else { failures++; console.log('FAIL', msg); }
}

const wait = ms => new Promise(r => setTimeout(r, ms));

// Minimal OpenAI-compatible endpoint for the AI panel checks.
function startFakeLlm() {
  const state = { mode: 'auto', delay: 0 };
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      const reply = () => {
        if (state.mode === 'garbage') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'not json' } }] }));
          return;
        }
        let content = JSON.stringify({ action: 'chat', text: 'AI在这里' });
        try {
          const parsed = JSON.parse(body || '{}');
          const messages = parsed.messages || [];
          const last = messages.length ? String(messages[messages.length - 1].content) : '';
          if (last.indexOf('作为领袖提议') >= 0) {
            const m = last.match(/需要恰好 (\d+)/);
            const size = m ? Number(m[1]) : 2;
            const team = [];
            for (let i = 1; i <= size; i++) team.push(i);
            content = JSON.stringify({ action: 'propose', team });
          } else if (last.indexOf('提案投票') >= 0) {
            content = JSON.stringify({ action: 'vote_proposal', vote: 'yes' });
          } else if (last.indexOf('个任务的队员') >= 0) {
            content = JSON.stringify({ action: 'vote_mission', vote: 'pass' });
          }
        } catch (e) {}
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content } }] }));
      };
      if (state.delay > 0) setTimeout(reply, state.delay);
      else reply();
    });
  });
  return new Promise(resolve => server.listen(0, () => resolve({ server, state, port: server.address().port })));
}

const countText = (page, text) => page.evaluate(t => {
  return (document.querySelector('#chatlog').textContent.match(new RegExp(t, 'g')) || []).length;
}, text);

async function makePage(browser, url, name, room) {
  const context = await browser.createBrowserContext();
  const page = await context.newPage();
  page.on('dialog', d => d.accept());
  await page.setCookie({ name: 'name', value: name, domain: 'localhost', path: '/' });
  if (room) await page.setCookie({ name: 'room', value: room, domain: 'localhost', path: '/' });
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.querySelector('#WARNING').textContent.includes('CONNECTED'));
  return page;
}

const text = (page, sel) => page.$eval(sel, el => el.textContent);
const visible = (page, sel) => page.$eval(sel, el => el.offsetParent !== null);
const disabled = (page, sel) => page.$eval(sel, el => el.disabled);

async function clickBox(page, name) {
  await page.evaluate(n => {
    const labels = Array.from(document.querySelectorAll('#name_checks label'));
    const label = labels.find(l => l.textContent.trim().endsWith(n));
    label.querySelector('input').click();
  }, name);
}

async function findLeader(pages) {
  for (let attempt = 0; attempt < 50; attempt++) {
    for (const p of pages) {
      if (await visible(p, '#proposebtn')) return p;
    }
    await wait(100);
  }
  return null;
}

async function selectAndPropose(leader, team) {
  for (const name of team) await clickBox(leader, name);
  await leader.click('#proposebtn');
}

async function voteProposal(pages, yes) {
  for (const p of pages) {
    await p.waitForFunction(() => !document.querySelector('#yesbtn').disabled);
    await p.click(`button[onclick="${yes ? 'Yes' : 'No'}()"]`);
  }
}

async function waitVoteButton(page, round) {
  await page.waitForFunction(sel => {
    const el = document.querySelector(sel);
    return el && el.offsetParent !== null && !el.disabled;
  }, {}, `button[onclick="Pass(${round})"]`);
}

async function castMission(pages, round, failNames) {
  const teamText = await text(pages[0], '#voters' + round);
  const team = teamText.split(', ').filter(Boolean).map(s => s.replace(/^\d+\.\s*/, ''));
  for (const name of team) {
    const p = pages[NAMES.indexOf(name)];
    const fn = failNames.indexOf(name) >= 0 ? 'Fail' : 'Pass';
    const sel = `button[onclick="${fn}(${round})"]`;
    await waitVoteButton(p, round);
    await p.click(sel);
  }
}

(async () => {
  const server = await startServer();
  const url = 'http://localhost:' + server.port;
  browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage']
  });

  // ?pid= overrides the localStorage identity for multi-user testing
  const sharedContext = await browser.createBrowserContext();
  const simA = await sharedContext.newPage();
  await simA.setCookie({ name: 'name', value: 'CookieName', domain: 'localhost', path: '/' });
  await simA.goto(url + '?pid=sim-a&name=SimA', { waitUntil: 'domcontentloaded' });
  check(await simA.evaluate(() => pid) === 'sim-a', '?pid= overrides identity');
  check(await simA.evaluate(() => me) === 'SimA', '?name= overrides the display name');
  check((await simA.$eval('#me', el => el.textContent)) === 'SimA', 'forced name shown in navbar');
  const simB = await sharedContext.newPage();
  await simB.goto(url + '?pid=sim-b&name=SimB', { waitUntil: 'domcontentloaded' });
  check(await simB.evaluate(() => pid) === 'sim-b', '?pid= isolates two pages in one profile');
  check(await simB.evaluate(() => me) === 'SimB', 'second window gets its own forced name');
  await sharedContext.close();

  // no name cookie: dismissing the prompt falls back to the default name
  const anonContext = await browser.createBrowserContext();
  const anon = await anonContext.newPage();
  let anonDialog = null;
  anon.on('dialog', d => { anonDialog = d.message(); d.dismiss(); });
  await anon.goto(url, { waitUntil: 'domcontentloaded' });
  await anon.waitForFunction(() => document.querySelector('#WARNING').textContent.includes('CONNECTED'));
  check(anonDialog === 'Input your name', 'first prompt asks for a name');
  check((await anon.evaluate(() => me)) === 'Harry Potter', 'dismissed name prompt falls back to Harry Potter');
  check((await anon.$eval('#me', el => el.textContent)) === 'Harry Potter', 'default name shown in the navbar');
  check((await anon.$eval('#names', el => el.textContent)).includes('Harry Potter'), 'default name shown in the roster');
  await anonContext.close();

  const a = await makePage(browser, url, NAMES[0]);
  check(await a.$eval('#startbtn', el => el.offsetParent === null), 'start button hidden in lobby');
  await a.waitForFunction(() => document.querySelector('#chatroom').textContent.includes('Lobby'));
  check((await text(a, '#chatroom')).includes('Lobby'), 'chat title shows the lobby');
  check((await text(a, '#lobbyrules')).includes('strict majority'), 'lobby shows game rules');
  await a.click('button[data-target="#rules-modal"]');
  await a.waitForFunction(() => document.querySelector('#rules-modal').classList.contains('in'));
  check(await a.$eval('#rules-modal', el => getComputedStyle(el).display !== 'none'), 'rules modal opens');
  await a.$eval('#rules-modal .modal-footer button', el => el.click());
  await a.waitForFunction(() => getComputedStyle(document.querySelector('#rules-modal')).display === 'none');
  check(await a.$eval('#rules-modal', el => getComputedStyle(el).display === 'none'), 'rules modal closes');
  await a.waitForFunction(() => !document.querySelector('.modal-backdrop'));
  const pidBefore = await a.evaluate(() => pid);
  await a.reload({ waitUntil: 'domcontentloaded' });
  await a.waitForFunction(() => document.querySelector('#WARNING').textContent.includes('CONNECTED'));
  check(await a.evaluate(() => pid) === pidBefore, 'pid survives a reload via cookie');
  await a.click('nav button[onclick="CreateRoom();"]');
  await a.waitForFunction(() => document.querySelector('#room').textContent !== 'Lobby' && document.querySelector('#room').textContent !== '');
  const room = await text(a, '#room');
  const pages = [a];
  for (let i = 1; i < 5; i++) pages.push(await makePage(browser, url, NAMES[i], room));
  await a.waitForFunction(() => document.querySelector('#joined').textContent === '5');

  // chat
  check(await a.$eval('#chatpanel', el => el.getBoundingClientRect().width > 0), 'chat panel visible in a room');
  await a.waitForFunction(r => document.querySelector('#chatroom').textContent.includes(r), {}, room);
  check((await text(a, '#chatroom')).includes(room), 'chat title shows the room name');
  await a.type('#chatinput', 'hello everyone');
  await a.click('#chatsend');
  await pages[1].waitForFunction(() => document.querySelector('#chatlog').textContent.includes('hello everyone'));
  check((await text(pages[1], '#chatlog')).includes('hello everyone'), 'chat message reaches other players');
  check((await text(pages[1], '#chatlog')).includes(NAMES[0]), 'chat message shows the sender');
  check((await text(pages[1], '#chatlog')).includes('1. ' + NAMES[0]), 'chat message shows the sender number');
  await a.evaluate(() => socket.emit('me', {name: encodeURIComponent('Alice2'), room: room, pid: pid}));
  await pages[1].waitForFunction(() => document.querySelector('#chatlog').textContent.includes('Alice2'));
  check((await text(pages[1], '#chatlog')).includes('1. Alice2'), 'chat re-renders old messages after a name change');
  await a.evaluate(() => socket.emit('me', {name: encodeURIComponent('Alice'), room: room, pid: pid}));
  await pages[1].waitForFunction(() => !document.querySelector('#chatlog').textContent.includes('Alice2'));
  await a.waitForFunction(() => !document.querySelector('#names').textContent.includes('Alice2'));
  check((await text(pages[1], '#chatlog')).includes('1. Alice'), 'chat re-renders after renaming back');
  await a.type('#chatinput', '<img src=x onerror=alert(1)>');
  await a.keyboard.press('Enter');
  await pages[1].waitForFunction(() => document.querySelector('#chatlog').textContent.includes('onerror'));
  check(await pages[1].$eval('#chatlog', el => el.querySelector('img') === null), 'chat text is not rendered as HTML');
  await a.click('#chattoggle');
  check(await a.$eval('#chatpanel', el => el.classList.contains('collapsed')), 'chat panel collapses');
  await pages[1].type('#chatinput', 'unread test');
  await pages[1].click('#chatsend');
  await a.waitForFunction(() => document.querySelector('#chatunread').offsetParent !== null && document.querySelector('#chatunread').textContent === '1');
  check((await text(a, '#chatunread')) === '1', 'collapsed chat shows unread count');
  await a.click('#chattoggle');
  check(!(await a.$eval('#chatpanel', el => el.classList.contains('collapsed'))), 'chat panel expands');
  check(await a.$eval('#chatunread', el => el.offsetParent === null), 'unread badge cleared on expand');
  await pages[2].reload({ waitUntil: 'domcontentloaded' });
  await pages[2].waitForFunction(() => document.querySelector('#WARNING').textContent.includes('CONNECTED'));
  await pages[2].waitForFunction(() => document.querySelector('#chatlog').textContent.includes('hello everyone'));
  check((await text(pages[2], '#chatlog')).includes('hello everyone'), 'chat history survives a reload');
  // Keep the fixed panel from covering mission buttons during the game flow.
  for (const p of pages) await p.evaluate(() => { document.getElementById('chatpanel').style.display = 'none'; });

  check(await a.$eval('#proposalbox', el => el.offsetParent === null), 'proposal box hidden before start');
  check(await a.$eval('#missionbox0', el => el.offsetParent === null), 'mission 1 box hidden before start');
  check(await a.$eval('#prestart', el => el.offsetParent !== null), 'waiting hint shown before start');
  check(await a.$eval('#startbtn', el => el.offsetParent !== null), 'start button visible in room');
  check(!(await disabled(a, '#startbtn')), 'start enabled with 5 players');

  await a.click('button[onclick="Start();"]');
  await a.waitForFunction(() => document.querySelector('#teamhint').textContent.length > 0);

  check(await a.$eval('#proposalbox', el => el.offsetParent !== null), 'proposal box shown after start');
  check(await a.$eval('#prestart', el => el.offsetParent === null), 'waiting hint hidden after start');
  for (let i = 0; i < 5; i++) {
    check(await a.$eval('#missionbox' + i, el => el.offsetParent !== null), 'mission ' + (i + 1) + ' card visible after start');
  }
  check((await text(a, '#voten0')).includes('2 players'), 'mission 1 card shows team size');
  check((await text(a, '#failneed0')).includes('1 to fail'), 'mission 1 card shows fail threshold');
  check((await text(a, '#voten1')).includes('3 players'), 'mission 2 card shows team size');
  check((await text(a, '#failneed3')).includes('1 to fail'), 'mission 4 card shows fail threshold');
  check(await a.$eval('button[onclick="Pass(0)"]', el => el.offsetParent === null), 'no pass buttons during proposal phase');
  check((await text(a, '#score')).includes('Resistance 0') && (await text(a, '#score')).includes('Spies 0'), 'score starts at 0-0');
  const startFont = await a.$eval('#startbtn', el => getComputedStyle(el).fontSize);
  check(await a.$eval('#score .label', el => getComputedStyle(el).fontSize) === startFont, 'score labels match start button font size');
  check((await text(a, '#rejectinfo')).includes('0/5'), 'reject counter shown to everyone');
  check((await a.$eval('#names', el => el.innerHTML)).includes('fa-star'), 'leader marked in player list');
  check((await text(a, '#names')).includes('1. '), 'player numbers shown next to names');

  // leader-only propose
  const leader = await findLeader(pages);
  check(leader !== null, 'one page shows the propose button');
  const leaderName = await text(leader, '#me');
  check((await text(leader, '#teamhint')).includes('You are the leader'), 'leader sees own hint');
  check(await visible(leader, '#name_checks'), 'leader sees checkboxes');
  check((await text(leader, '#name_checks')).includes('1. '), 'player numbers shown in the selection list');
  for (const p of pages) {
    if (p === leader) continue;
    await p.waitForFunction(() => document.querySelector('#proposebtn').offsetParent === null);
    check(!(await visible(p, '#proposebtn')), 'non-leader has no propose button');
    check(await p.$eval('#name_checks', el => el.offsetParent === null), 'non-leader checkboxes hidden');
    const hint = await text(p, '#teamhint');
    check(hint.includes('Waiting for') && hint.includes(leaderName), 'non-leader hint names the leader');
  }

  // restart asks for confirmation
  await a.evaluate(() => { window.__confirmCalls = 0; window.confirm = () => { window.__confirmCalls++; return false; }; });
  await a.click('#startbtn');
  await wait(200);
  check(await a.evaluate(() => window.__confirmCalls) === 1, 'restart asks for confirmation');
  check(await a.$eval('#teamhint', el => el.textContent.length > 0), 'game kept running after dismissing restart');

  // offline status and reconnect
  const victim = pages.find(p => p !== a && p !== leader);
  const victimName = NAMES[pages.indexOf(victim)];
  await victim.evaluate(() => socket.disconnect());
  await a.waitForFunction(() => document.querySelector('#names').innerHTML.includes('fa-chain-broken'));
  check((await a.$eval('#names', el => el.textContent)).includes(victimName), 'offline player stays in the roster');
  await victim.evaluate(() => socket.connect());
  await a.waitForFunction(() => !document.querySelector('#names').innerHTML.includes('fa-chain-broken'));
  check(!(await a.$eval('#names', el => el.innerHTML)).includes('fa-chain-broken'), 'reconnected player no longer marked offline');

  // mission 1: size 2, check selection limit then propose
  await clickBox(leader, NAMES[0]);
  check(await disabled(leader, '#proposebtn'), 'propose disabled with 1 of 2 selected');
  check(!(await leader.$eval(`#name_checks input[value]`, el => el.disabled)), 'checkboxes enabled below limit');
  await clickBox(leader, NAMES[1]);
  check(!(await disabled(leader, '#proposebtn')), 'propose enabled with exact team size');
  await leader.click('#proposebtn');
  await a.waitForFunction(() => document.querySelector('#proposal').textContent.includes('Mission 1'));
  check(!(await disabled(a, '#yesbtn')), 'yes enabled while proposal open');
  check((await text(a, '#proposal')).includes('Waiting for'), 'proposal shows who still has to vote');
  check((await text(a, '#proposal')).includes('1. Alice') && (await text(a, '#proposal')).includes('2. Bob'), 'proposal shows player numbers');

  await voteProposal(pages, true);
  await a.waitForFunction(() => document.querySelector('#proposalbox').offsetParent === null);
  check(await a.$eval('#proposalbox', el => el.offsetParent === null), 'proposal box hidden in mission phase');
  check((await text(a, '#voters0')).includes('Alice') && (await text(a, '#voters0')).includes('Bob'), 'mission team displayed');
  check((await text(a, '#voters0')).includes('1. '), 'mission team shows player numbers');

  for (const p of pages) {
    const name = NAMES[pages.indexOf(p)];
    const inTeam = ['Alice', 'Bob'].indexOf(name) >= 0;
    await p.waitForFunction(expected => {
      const el = document.querySelector('button[onclick="Pass(0)"]');
      return el && (el.offsetParent !== null) === expected;
    }, {}, inTeam);
    check((await visible(p, 'button[onclick="Pass(0)"]')) === inTeam, 'mission buttons ' + (inTeam ? 'shown' : 'hidden') + ' for ' + name);
  }

  const team = (await text(a, '#voters0')).split(', ').filter(Boolean).map(s => s.replace(/^\d+\.\s*/, ''));
  const first = pages[NAMES.indexOf(team[0])];
  await waitVoteButton(first, 0);
  await first.click('button[onclick="Pass(0)"]');
  await a.waitForFunction(() => document.querySelector('#votewait0').textContent.includes('Waiting for'));
  check((await text(a, '#votewait0')).includes(team[1]), 'mission waiting list names the remaining voter');
  const rest = pages[NAMES.indexOf(team[1])];
  await waitVoteButton(rest, 0);
  await rest.click('button[onclick="Pass(0)"]');

  await a.waitForFunction(() => document.querySelector('#teamhint').textContent.includes('mission 2'));
  check(await a.$eval('#missionbox0', el => el.offsetParent !== null), 'mission 1 result stays visible');
  check((await a.$eval('#missionbox0 .panel', el => el.className)).includes('panel-success'), 'mission 1 panel is green');
  check(await a.$eval('#proposalbox', el => el.offsetParent !== null), 'proposal box back for mission 2');
  check(await a.$eval('button[onclick="Pass(0)"]', el => el.offsetParent === null), 'mission 1 buttons hidden after completion');
  check((await text(a, '#score')).includes('Resistance 1'), 'score updates after mission 1');

  // mission 2: size 3
  const leader2 = await findLeader(pages);
  check(leader2 !== null, 'leader for mission 2 found');
  await selectAndPropose(leader2, [NAMES[0], NAMES[1], NAMES[2]]);
  await a.waitForFunction(() => document.querySelector('#proposal').textContent.includes('Mission 2'));
  await voteProposal(pages, true);
  await a.waitForFunction(() => document.querySelector('#proposalbox').offsetParent === null);
  await castMission(pages, 1, []);
  await a.waitForFunction(() => document.querySelector('#teamhint').textContent.includes('mission 3'));

  // mission 3: size 2 -> resistance wins
  const leader3 = await findLeader(pages);
  await selectAndPropose(leader3, [NAMES[0], NAMES[1]]);
  await a.waitForFunction(() => document.querySelector('#proposal').textContent.includes('Mission 3'));
  await voteProposal(pages, true);
  await a.waitForFunction(() => document.querySelector('#proposalbox').offsetParent === null);
  await castMission(pages, 2, []);

  await a.waitForFunction(() => document.querySelector('#winner').offsetParent !== null);
  check((await text(a, '#winner')).includes('Resistance wins!'), 'winner banner shows resistance');
  check(await a.$eval('#proposalbox', el => el.offsetParent === null), 'proposal box hidden after win');
  check(await a.$eval('#prestart', el => el.offsetParent === null), 'waiting hint stays hidden after win');

  // ---- AI panel ----
  const fake = await startFakeLlm();
  const cfgPath = path.join(os.tmpdir(), 'resistance-ui-ai-' + process.pid + '.json');
  fs.writeFileSync(cfgPath, JSON.stringify({
    timeout_ms: 5000,
    models: [{ id: 'fake', label: 'Fake', base_url: 'http://localhost:' + fake.port + '/v1', api_key: 'x', model: 'fake-model' }]
  }));
  const aiServer = await startServer({ AI_CONFIG: cfgPath });
  const b = await makePage(browser, 'http://localhost:' + aiServer.port, 'AiHost');
  check(await b.$eval('#aibtn', el => el.offsetParent === null), 'AI button hidden outside a room');
  const navButtons = await b.$$eval('.navbar-collapse button', els => els.map(el => el.textContent.trim()));
  check(navButtons[navButtons.length - 1].includes('Rule'), 'Rule button stays last in the navbar');
  const ruleGap = await b.evaluate(() => {
    const rule = document.querySelector('.navbar-collapse button[data-target="#rules-modal"]').getBoundingClientRect();
    return document.querySelector('.navbar').getBoundingClientRect().right - rule.right;
  });
  check(ruleGap < 40, 'Rule button is at the right end of the navbar');

  await b.click('nav button[onclick="CreateRoom();"]');
  await b.waitForFunction(() => document.querySelector('#room').textContent !== 'Lobby' && document.querySelector('#room').textContent !== '');
  await b.waitForFunction(() => document.querySelector('#aibtn').offsetParent !== null);
  check((await text(b, '#aibtn')).includes('Add AI'), 'AI button labelled Add AI');
  await b.click('#aibtn');
  await b.waitForFunction(() => document.querySelector('#aimodal').classList.contains('in'));
  check(await b.$eval('#aimodal', el => getComputedStyle(el).display !== 'none'), 'AI modal opens');
  const modelOptions = await b.$eval('#aimodel', el => Array.from(el.options).map(o => o.textContent));
  check(modelOptions.length === 1 && modelOptions[0] === 'Fake', 'AI modal lists configured models');
  for (let i = 0; i < 4; i++) {
    await b.click('#aiaddbtn');
    await wait(150);
  }
  await b.waitForFunction(() => document.querySelector('#joined').textContent === '5');
  const aiInfo = await b.evaluate(() => players.filter(p => p.ai).map(p => ({ name: decodeURIComponent(p.name), model: p.model })));
  check(aiInfo.length === 4 && new Set(aiInfo.map(p => p.name)).size === 4, 'AI players added with distinct zodiac names');
  check(aiInfo.every(p => ZODIAC.indexOf(p.name) >= 0), 'AI names come from the zodiac');
  check(aiInfo.every(p => p.model === 'Fake'), 'AI model exposed for hover');
  check((await b.$eval('#names', el => el.innerHTML)).includes('fa-microchip'), 'AI players show a microchip icon');
  check((await b.$eval('#names', el => el.innerHTML)).includes('title="Fake"'), 'hover title shows the model');
  check((await b.$eval('#names', el => el.textContent)).includes('5. '), 'AI players get roster numbers');

  await b.click('.airemove');
  await b.waitForFunction(() => document.querySelector('#joined').textContent === '4');
  check((await b.$eval('#joined', el => el.textContent)) === '4', 'AI removed through the panel');
  await b.click('#aiaddbtn');
  await b.waitForFunction(() => document.querySelector('#joined').textContent === '5');
  await b.$eval('#aimodal .modal-footer button', el => el.click());
  await b.waitForFunction(() => !document.querySelector('.modal-backdrop'));
  check(await b.$$eval('#names .aidel', els => els.length) === 4, 'roster shows remove buttons for AI before start');

  // chat before the game starts must not reach the model
  await b.type('#chatinput', '开局前聊天');
  await b.click('#chatsend');
  await wait(3500);
  check(!(await text(b, '#chatlog')).includes('AI在这里'), 'pre-game chat gets no AI reply');

  await b.click('#startbtn');
  await b.waitForFunction(() => document.querySelector('#proposalbox').offsetParent !== null);

  // force the human to be the leader so the reconsider prompt can be tested
  for (let i = 0; i < 20 && !(await visible(b, '#proposebtn')); i++) {
    await b.click('#startbtn');
    await b.waitForFunction(() => document.querySelector('#proposalbox').offsetParent !== null);
    await wait(300);
  }
  check(await visible(b, '#proposebtn'), 'human is the leader for the reconsider test');
  check(await b.$$eval('#names .aidel', els => els.length) === 0, 'no AI remove buttons mid-game');
  check(await visible(b, '#surrenderbtn'), 'surrender button visible during the game');
  await b.evaluate(() => {
    const boxes = document.querySelectorAll('#name_checks input[type=checkbox]');
    boxes[0].click();
    boxes[1].click();
    document.querySelector('#proposebtn').click();
  });
  await b.waitForFunction(() => document.querySelector('#proposal').textContent.includes('Waiting for: 1. AiHost'), {timeout: 20000});

  fake.state.delay = 1500;
  await b.type('#chatinput', '你们好');
  await b.click('#chatsend');
  await b.waitForFunction(() => {
    const el = document.querySelector('#aithinking');
    return el != null && el.offsetWidth > 0 && el.textContent.indexOf('AI thinking') >= 0;
  }, {timeout: 15000});
  check(await b.$eval('#aithinking', el => el.offsetWidth > 0), 'AI thinking indicator shown while waiting');
  await b.waitForFunction(() => document.querySelector('#chatlog').textContent.includes('AI在这里'), {timeout: 30000});
  fake.state.delay = 0;
  check((await text(b, '#chatlog')).includes('AI在这里'), 'AI chat reply appears in the chat panel');
  await b.waitForFunction(() => {
    const el = document.querySelector('#aithinking');
    return el != null && el.offsetWidth === 0;
  }, {timeout: 60000});
  check(await b.$eval('#aithinking', el => el.offsetWidth === 0), 'AI thinking indicator hidden when idle');

  await b.waitForFunction(() => document.querySelector('#reconsider').offsetParent !== null, {timeout: 30000});
  check(await b.$eval('#reconsider', el => el.offsetParent !== null), 'leader sees the reconsider prompt after chat');
  await b.click('#reconsider button');
  await b.waitForFunction(() => document.querySelector('#reconsider').offsetParent === null);
  check(await b.$eval('#reconsider', el => el.offsetParent === null), 'reconsider prompt dismissed by Keep');

  fake.state.mode = 'garbage';
  const before = await countText(b, 'AI在这里');
  await b.type('#chatinput', '还在吗');
  await b.click('#chatsend');
  await b.waitForSelector('#aialerts .alert-danger .airetry', {visible: true, timeout: 20000});
  check(await b.$eval('#aialerts .alert-danger', el => el.offsetParent !== null), 'AI error banner shown with retry');
  fake.state.mode = 'auto';
  await b.evaluate(() => { document.querySelectorAll('#aialerts .airetry').forEach(el => el.click()); });
  await b.waitForFunction(n => (document.querySelector('#chatlog').textContent.match(/AI在这里/g) || []).length > n, {timeout: 30000}, before);
  check((await countText(b, 'AI在这里')) > before, 'AI retry from the panel works');

  await b.click('#surrenderbtn');
  await b.waitForFunction(() => document.querySelector('#winner').offsetParent !== null, {timeout: 10000});
  const winnerText = await text(b, '#winner');
  check(winnerText.includes('Resistance wins!') || winnerText.includes('Spies win!'), 'surrender ends the game with a winner');
  check(await b.$eval('#surrenderbtn', el => el.offsetParent === null), 'surrender button hidden after the game');
  check(await b.$$eval('#names .aidel', els => els.length) === 4, 'AI remove buttons return after the game');

  await stopServer(aiServer);
  fake.server.close();
  try { fs.unlinkSync(cfgPath); } catch (e) {}

  await browser.close();
  await stopServer(server);
  console.log(failures === 0 ? 'ALL UI TESTS PASSED' : failures + ' UI TEST(S) FAILED');
  process.exit(failures === 0 ? 0 : 1);
})().catch(e => { console.error('ERROR', e); process.exit(1); });
