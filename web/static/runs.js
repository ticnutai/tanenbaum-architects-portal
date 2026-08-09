const $ = selector => document.querySelector(selector);
const state = {events:[], summary:{}, errors:[]};
function escapeHtml(value=''){return String(value).replace(/[&<>'"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));}
const labels={error:'שגיאה',success:'הושלם',manual:'נעצר ידנית',recorded:'נקלט שלב',info:'מידע'};
function render(){
  $('#statTotal').textContent=state.summary.total||0; $('#statSuccess').textContent=state.summary.success||0; $('#statErrors').textContent=state.summary.errors||0; $('#statManual').textContent=state.summary.manual||0;
  $('#runList').innerHTML=state.events.map(event=>`<article class="run-card"><div><div class="run-message">${escapeHtml(event.message)}</div><div class="run-time">${escapeHtml(event.timestamp||'ללא חותמת זמן')}</div></div><span class="status-badge ${event.status}">${labels[event.status]||'מידע'}</span></article>`).join('');
  $('#emptyRuns').classList.toggle('hidden',state.events.length>0); state.errors=state.events.filter(x=>x.status==='error');
  $('#errorReport').classList.toggle('hidden',!state.summary.errors); $('#errorSummary').textContent=state.summary.errors?`${state.summary.errors} שגיאות נמצאו ביומן. האחרונה: ${state.errors[0]?.message||'יש לפתוח את הקונסול לפרטים.'}`:'';
}
async function loadLogs(){const params=new URLSearchParams({status:$('#logFilter').value,q:$('#searchLogs').value,limit:'800'});const data=await MavatUI.json(`/api/logs?${params}`);state.events=data.events;state.summary=data.summary;render();}
function errorText(){const errors=state.events.filter(x=>x.status==='error');return errors.length?['דוח שגיאות מבא״ת',`נוצר: ${new Date().toLocaleString('he-IL')}`,'',...errors.map(x=>`[${x.timestamp}] ${x.message}`)].join('\n'):'לא נמצאו שגיאות בתצוגה הנוכחית.';}
async function copyText(text,message='הועתק ללוח'){await navigator.clipboard.writeText(text);MavatUI.toast(message,'success');}
async function openConsole(){const data=await MavatUI.json('/api/console');$('#consoleContent').textContent=data.content||'הקונסול ריק.';$('#consoleDialog').showModal();}
$('#refreshLogs').addEventListener('click',loadLogs);$('#logFilter').addEventListener('change',loadLogs);let searchTimer;$('#searchLogs').addEventListener('input',()=>{clearTimeout(searchTimer);searchTimer=setTimeout(loadLogs,250)});
$('#copyErrors').addEventListener('click',()=>copyText(errorText(),'דוח השגיאות הועתק'));$('#copyErrorPanel').addEventListener('click',()=>copyText(errorText(),'דוח השגיאות הועתק'));
$('#openConsole').addEventListener('click',openConsole);$('#closeConsole').addEventListener('click',()=>$('#consoleDialog').close());$('#copyConsole').addEventListener('click',()=>copyText($('#consoleContent').textContent,'הקונסול הועתק'));$('#selectConsole').addEventListener('click',()=>{const range=document.createRange();range.selectNodeContents($('#consoleContent'));const selection=getSelection();selection.removeAllRanges();selection.addRange(range);});
setInterval(loadLogs,5000);loadLogs();
