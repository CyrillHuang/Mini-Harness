(async () => {
  const config = await fetch('/api/pet').then(r => r.json());
  if (!config) return;
  const pet = document.createElement('div'), toggle = document.createElement('button');
  const size = config.size, height = size * 208 / 192;
  pet.style.cssText = `position:fixed;right:20px;bottom:170px;width:${size}px;height:${height}px;background:url(/pet/spritesheet.webp);background-size:${size*8}px ${height*9}px;image-rendering:pixelated;touch-action:none;cursor:grab;z-index:20`;
  toggle.type = 'button';
  let hidden = false, frame = 0, row = 0, drag;
  let nextFrameAt = 0;
  let manuallyPlaced = false;
  function placeDefault() {
    if (manuallyPlaced) return;
    const composer = document.querySelector('footer').getBoundingClientRect();
    const main = document.querySelector('main').getBoundingClientRect();
    pet.style.right = pet.style.bottom = 'auto';
    pet.style.left = Math.max(main.left, composer.left-size-12)+'px';
    pet.style.top = Math.max(0,Math.min(innerHeight-height,composer.bottom-height))+'px';
  }
  // Verified against the atlas alpha channel; trailing cells are transparent.
  const actions = [
    { row:0, frames:6, name:'待机' },
    { row:1, frames:8, name:'走路' },
    { row:4, frames:5, name:'转身' },
    { row:5, frames:8, name:'低头' },
    { row:6, frames:6, name:'捧手' },
    { row:7, frames:6, name:'捧火' },
  ];
  let manualRow = null, automaticRow = 0;
  function selectRow(nextRow) {
    if (row !== nextRow) { row = nextRow; frame = 0; nextFrameAt = 0; paint(); }
    pet.title = manualRow === null ? { 0:'空闲', 7:'工作中', 5:'等待审批' }[row] : actions.find(a => a.row === row).name;
  }
  const paint = () => { pet.style.backgroundPosition = `${-frame*size}px ${-row*height}px`; };
  try { hidden = localStorage.getItem('pet-hidden') === 'true'; } catch {}
  function show() { pet.hidden = hidden; toggle.textContent = hidden ? '显示桌宠' : '隐藏桌宠'; }
  toggle.onclick = () => { hidden = !hidden; show(); try { localStorage.setItem('pet-hidden', String(hidden)); } catch {} };
  const menu = document.createElement('div');
  menu.hidden = true; menu.setAttribute('role','menu'); menu.setAttribute('aria-label','桌宠动作');
  menu.style.cssText = 'position:fixed;z-index:40;padding:6px;background:white;border:1px solid #dbe0e8;border-radius:12px;box-shadow:0 8px 30px #25304520;min-width:170px;max-height:calc(100dvh - 16px);overflow:auto';
  function closeMenu() { menu.hidden = true; }
  const choices = [{ row:null, name:'跟随 Agent 状态' }, ...actions];
  for (const choice of choices) {
    const button = document.createElement('button');
    button.type = 'button'; button.textContent = choice.name;
    button.setAttribute('role','menuitemradio');
    button.style.cssText = 'display:block;width:100%;border:0;text-align:left;padding:7px 10px';
    button.onclick = () => { manualRow = choice.row; selectRow(manualRow ?? automaticRow); closeMenu(); pet.focus(); };
    menu.append(button);
  }
  pet.tabIndex = 0; pet.setAttribute('aria-label','桌宠，右键选择动作');
  pet.oncontextmenu = e => {
    e.preventDefault(); drag = null;
    [...menu.children].forEach((b,i) => b.setAttribute('aria-checked',String(choices[i].row === manualRow)));
    menu.hidden = false;
    menu.style.left = Math.max(8,Math.min(e.clientX,innerWidth-menu.offsetWidth-8))+'px';
    menu.style.top = Math.max(8,Math.min(e.clientY,innerHeight-menu.offsetHeight-8))+'px';
    menu.firstElementChild.focus();
  };
  menu.onkeydown = e => {
    const buttons = [...menu.children], index = buttons.indexOf(document.activeElement);
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); buttons[(index+(e.key === 'ArrowDown'?1:-1)+buttons.length)%buttons.length].focus(); }
    if (e.key === 'Escape') { closeMenu(); pet.focus(); }
  };
  document.addEventListener('pointerdown',e => { if (!menu.contains(e.target)) closeMenu(); });
  window.addEventListener('resize',closeMenu);
  document.body.append(pet, menu); document.getElementById('petSettings').replaceChildren(toggle); show();
  const placementObserver = new ResizeObserver(placeDefault);
  placementObserver.observe(document.querySelector('main'));
  placementObserver.observe(document.querySelector('footer'));
  window.addEventListener('resize',placeDefault);
  placeDefault();
  pet.onpointerdown = e => { if (e.button !== 0) return; const r = pet.getBoundingClientRect(); drag = { x: e.clientX-r.left, y: e.clientY-r.top }; pet.setPointerCapture(e.pointerId); };
  pet.onpointermove = e => { if (!drag) return; manuallyPlaced = true; pet.style.right = pet.style.bottom = 'auto'; pet.style.left = Math.max(0, Math.min(innerWidth-size,e.clientX-drag.x))+'px'; pet.style.top = Math.max(0,Math.min(innerHeight-height,e.clientY-drag.y))+'px'; };
  pet.onpointerup = pet.onpointercancel = () => { drag = null; };
  const events = new EventSource('/api/events');
  events.onmessage = e => { const s = JSON.parse(e.data); automaticRow = s.approvals.length ? 5 : s.status === 'running' ? 7 : 0; if (manualRow === null) selectRow(automaticRow); };
  // Idle and turning pause between gestures instead of slowing every frame.
  const timer = setInterval(() => {
    if (hidden || document.hidden) return;
    const now = performance.now();
    if (now < nextFrameAt) return;
    frame = (frame+1)%actions.find(a => a.row === row).frames; paint();
    const delay = row === 0 ? (frame === 0 ? 3000 : 1000/Math.min(config.fps,4))
      : row === 4 ? (frame === 0 ? 2500 : 125)
      : 1000/(row === 6 ? Math.min(config.fps,2) : config.fps);
    nextFrameAt = now + delay;
  }, 1000/Math.max(config.fps,8));
  window.addEventListener('pagehide', () => { clearInterval(timer); events.close(); placementObserver.disconnect(); window.removeEventListener('resize',placeDefault); }, { once:true });
})().catch(console.error);
