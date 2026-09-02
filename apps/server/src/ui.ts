export const UI_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>raycoder engine</title>
  <style>
    :root { color-scheme: dark; font-family: ui-monospace, SFMono-Regular, Consolas, monospace; background:#0b0d10; color:#e6edf3; }
    body { margin:0; min-height:100vh; background:radial-gradient(circle at 10% 0%,#17202b 0,transparent 34%),#0b0d10; }
    main { width:min(920px,calc(100% - 32px)); margin:0 auto; padding:56px 0 80px; }
    header { display:flex; align-items:end; justify-content:space-between; gap:24px; margin-bottom:32px; }
    h1 { margin:0; font-size:clamp(2rem,6vw,4.2rem); letter-spacing:-.08em; line-height:.9; }
    header p { margin:0; max-width:440px; color:#8b949e; line-height:1.5; }
    section { border:1px solid #30363d; background:rgba(13,17,23,.78); border-radius:12px; padding:20px; margin:16px 0; box-shadow:0 20px 50px rgba(0,0,0,.18); }
    h2 { margin:0 0 16px; font-size:.8rem; letter-spacing:.12em; text-transform:uppercase; color:#8b949e; }
    .checks,.tickets { display:grid; gap:8px; }
    .check,.ticket { display:flex; justify-content:space-between; align-items:center; gap:16px; padding:12px; background:#161b22; border-radius:8px; }
    .ok { color:#3fb950; } .bad { color:#f85149; } .muted { color:#8b949e; }
    button,select { font:inherit; border:1px solid #3d444d; border-radius:7px; padding:10px 12px; color:#e6edf3; background:#21262d; }
    button { background:#238636; border-color:#2ea043; cursor:pointer; font-weight:700; }
    button:disabled { opacity:.45; cursor:not-allowed; }
    .actions { display:flex; gap:10px; flex-wrap:wrap; }
    code { color:#79c0ff; }
    small { color:#8b949e; line-height:1.45; }
    .error { color:#ff7b72; white-space:pre-wrap; }
    @media(max-width:650px){ header{align-items:start;flex-direction:column}.check,.ticket{align-items:start;flex-direction:column} }
  </style>
</head>
<body><main>
  <header><h1>raycoder</h1><p>The session-1 engine. Isolated worktrees, normalized agent events, durable lifecycle, conservative recovery.</p></header>
  <section><h2>Preflight</h2><div id="preflight" class="checks">Loading…</div></section>
  <section>
    <h2>Engine demo</h2>
    <p><small>This starts a real Codex session and can consume plan quota. If the checkout is dirty, choose explicitly whether to use only its committed head.</small></p>
    <div class="actions">
      <select id="dirty-policy" aria-label="Dirty repository policy">
        <option value="cancel">Cancel when checkout is dirty</option>
        <option value="committed-head">Use committed head; exclude uncommitted changes</option>
      </select>
      <button id="run">Run demo ticket</button>
    </div>
    <p id="error" class="error"></p>
  </section>
  <section><h2>Tickets</h2><div id="tickets" class="tickets">No tickets yet.</div></section>
</main>
<script>
const preflight = document.querySelector('#preflight');
const tickets = document.querySelector('#tickets');
const errorBox = document.querySelector('#error');
const run = document.querySelector('#run');
const policy = document.querySelector('#dirty-policy');
function esc(value){return String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
async function json(url, options){const response=await fetch(url,options);const body=await response.json();if(!response.ok)throw new Error(body.error||response.statusText);return body;}
async function refresh(){
  try{
    const report=await json('/api/preflight');
    const rows=[...report.essential.map(x=>({ok:x.ok,name:x.name,message:x.message})),...report.providers.map(x=>({ok:x.executable,name:x.provider,message:x.diagnostics.map(d=>d.message).join(' · ')}))];
    preflight.innerHTML=rows.map(x=>'<div class="check"><strong class="'+(x.ok?'ok':'bad')+'">'+(x.ok?'✓ ':'✗ ')+esc(x.name)+'</strong><small>'+esc(x.message)+'</small></div>').join('')+'<small>Upcoming: '+report.upcoming.map(esc).join(', ')+'</small>';
    run.disabled=!report.canStart;
    const data=await json('/api/tickets');
    tickets.innerHTML=data.tickets.length?data.tickets.map(t=>'<div class="ticket"><div><strong>'+esc(t.title)+'</strong><br><small>'+esc(t.id)+'</small></div><div><code>'+esc(t.status)+'</code>'+(t.error?'<br><small class="error">'+esc(t.error)+'</small>':'')+'</div></div>').join(''):'No tickets yet.';
  }catch(error){errorBox.textContent=error.message;}
}
run.addEventListener('click',async()=>{run.disabled=true;errorBox.textContent='';try{await json('/api/demo',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({dirtyPolicy:policy.value})});}catch(error){errorBox.textContent=error.message;}finally{await refresh();}});
refresh(); setInterval(refresh,1500);
</script></body></html>`;
