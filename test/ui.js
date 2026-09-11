const puppeteer = require('puppeteer-core');
const { startServer, stopServer } = require('./helper');

const NAMES = ['Alice', 'Bob', 'Carol', 'Dave', 'Eve'];
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
  anon.on('dialog', d => d.dismiss());
  await anon.goto(url, { waitUntil: 'domcontentloaded' });
  await anon.waitForFunction(() => document.querySelector('#WARNING').textContent.includes('CONNECTED'));
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

  await browser.close();
  await stopServer(server);
  console.log(failures === 0 ? 'ALL UI TESTS PASSED' : failures + ' UI TEST(S) FAILED');
  process.exit(failures === 0 ? 0 : 1);
})().catch(e => { console.error('ERROR', e); process.exit(1); });
