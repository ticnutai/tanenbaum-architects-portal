const ACTIONS = ['goto','click_text','click_role','fill_label','fill_placeholder','fill_secret','wait_url','wait_text','manual','screenshot','delay','noop'];
const state = { workflow: {steps: []}, profiles: {}, selected: new Set(), lastSelected: null, dragged: null, recording: false };
const $ = (selector) => document.querySelector(selector);
const list = $('#stepList');

function escapeHtml(value='') {
  return String(value).replace(/[&<>'"]/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[char]));
}
function description(step) {
  if (step.type === 'fill_secret') return step._secret_status === 'saved' ? 'סיסמה מאובטחת שמורה' : 'נדרשת הגדרת סיסמה';
  return step.value || step.target || (step.scope === 'per_record' ? 'מבוצע לכל רשומה' : 'מבוצע פעם אחת');
}
function secretLabel(step) {
  if (step.type !== 'fill_secret') return '';
  return step._secret_status === 'saved'
    ? '<button class="secret-chip" data-secret-action>🔒 שמורה</button>'
    : '<button class="secret-chip missing" data-secret-action>🔑 הגדרה</button>';
}
function render() {
  list.innerHTML = state.workflow.steps.map((step, index) => `
    <article class="step-card ${step.enabled === false ? 'paused' : ''} ${state.selected.has(index) ? 'selected' : ''}" data-index="${index}" draggable="true">
      <span class="drag-handle" title="גרור לשינוי סדר">⠿</span>
      <span class="step-number">${index + 1}</span>
      <div class="step-main">
        <div class="step-title-row"><span class="status-dot"></span><span class="step-title">${escapeHtml(step.name || step.type)}</span>${secretLabel(step)}</div>
        <div class="step-description">${escapeHtml(description(step))}</div>
      </div>
      <div class="step-meta"><span class="action-chip ${step.type === 'manual' ? 'manual' : ''}">${escapeHtml(step.type)}</span></div>
    </article>`).join('');
  applyFilters(); updateSelectionBar(); bindCards();
  $('#stepCount').textContent = `${state.workflow.steps.length} שלבים`;
  $('#emptySteps').classList.toggle('hidden', state.workflow.steps.length > 0);
}
function applyFilters() {
  const q = $('#searchSteps').value.trim().toLowerCase();
  const status = $('#statusFilter').value;
  let visible = 0;
  document.querySelectorAll('.step-card').forEach(card => {
    const step = state.workflow.steps[Number(card.dataset.index)];
    const text = `${step.name} ${step.type} ${step.target || ''} ${step.value || ''}`.toLowerCase();
    const statusOk = status === 'all' || (status === 'active' && step.enabled !== false) || (status === 'paused' && step.enabled === false) || (status === 'secret' && step.type === 'fill_secret');
    const show = statusOk && (!q || text.includes(q));
    card.classList.toggle('hidden', !show); if (show) visible++;
  });
  $('#emptySteps').classList.toggle('hidden', visible > 0);
}
function updateSelectionBar() {
  $('#selectedCount').textContent = state.selected.size;
  $('#selectionBar').classList.toggle('hidden', !state.selected.size);
}
function selectCard(index, event) {
  if (event.shiftKey && state.lastSelected !== null) {
    const [start,end] = [state.lastSelected,index].sort((a,b)=>a-b);
    for (let i=start;i<=end;i++) state.selected.add(i);
  } else if (event.ctrlKey || event.metaKey) {
    state.selected.has(index) ? state.selected.delete(index) : state.selected.add(index);
    state.lastSelected = index;
  } else {
    state.selected.clear(); state.selected.add(index); state.lastSelected = index;
  }
  render();
}
function bindCards() {
  document.querySelectorAll('.step-card').forEach(card => {
    const index = Number(card.dataset.index);
    card.addEventListener('click', event => {
      if (event.target.closest('[data-secret-action]')) { event.stopPropagation(); openSecret(index); return; }
      selectCard(index, event);
    });
    card.addEventListener('dblclick', event => {
      event.preventDefault(); state.workflow.steps[index].type === 'fill_secret' ? openSecret(index) : openStep(index);
    });
    card.addEventListener('dragstart', () => { state.dragged = index; card.classList.add('dragging'); });
    card.addEventListener('dragend', () => { state.dragged = null; document.querySelectorAll('.step-card').forEach(x=>x.classList.remove('dragging','drop-before')); });
    card.addEventListener('dragover', event => { event.preventDefault(); card.classList.add('drop-before'); });
    card.addEventListener('dragleave', () => card.classList.remove('drop-before'));
    card.addEventListener('drop', async event => {
      event.preventDefault(); card.classList.remove('drop-before');
      const target = index; if (state.dragged === null || state.dragged === target) return;
      const order = state.workflow.steps.map((_,i)=>i); const [moved] = order.splice(state.dragged,1); order.splice(target,0,moved);
      await MavatUI.json('/api/steps/reorder',{method:'POST',body:JSON.stringify({order})}); state.selected.clear(); await loadWorkflow(); MavatUI.toast('סדר השלבים נשמר','success');
    });
  });
}
async function loadWorkflow() {
  const data = await MavatUI.json('/api/workflow'); state.workflow = data.workflow; state.profiles = data.profiles; render();
}
async function bulk(action) {
  if (!state.selected.size) return;
  if (action === 'delete' && !confirm(`למחוק ${state.selected.size} פעולות?`)) return;
  await MavatUI.json('/api/steps/bulk',{method:'POST',body:JSON.stringify({indices:[...state.selected],action})}); state.selected.clear(); await loadWorkflow(); MavatUI.toast('השינויים נשמרו','success');
}
function openStep(index=null) {
  const step = index === null ? {name:'',type:'click_text',scope:'once',target:'',value:'',timeout_seconds:30,enabled:true} : state.workflow.steps[index];
  $('#stepDialogTitle').textContent = index === null ? 'פעולה חדשה' : 'עריכת פעולה'; $('#stepIndex').value = index ?? '';
  $('#stepName').value=step.name||''; $('#stepType').value=step.type||'noop'; $('#stepScope').value=step.scope||'once'; $('#stepTarget').value=step.target||''; $('#stepValue').value=step.value||''; $('#stepTimeout').value=step.timeout_seconds||30; $('#stepEnabled').checked=step.enabled!==false;
  $('#stepDialog').showModal();
}
async function saveStep(event) {
  event.preventDefault();
  const index = $('#stepIndex').value;
  const step = {name:$('#stepName').value.trim(),type:$('#stepType').value,scope:$('#stepScope').value,target:$('#stepTarget').value,value:$('#stepValue').value,timeout_seconds:Number($('#stepTimeout').value||30),enabled:$('#stepEnabled').checked};
  if (!step.name) return MavatUI.toast('יש להזין שם לשלב','error');
  if (index === '') { const position = state.selected.size ? Math.max(...state.selected)+1 : state.workflow.steps.length; await MavatUI.json('/api/steps',{method:'POST',body:JSON.stringify({position,step})}); }
  else await MavatUI.json(`/api/steps/${index}`,{method:'PUT',body:JSON.stringify(step)});
  $('#stepDialog').close(); state.selected.clear(); await loadWorkflow(); MavatUI.toast('השלב נשמר','success');
}
function fillProfile(profileId) {
  const profile=state.profiles[profileId]; $('#secretName').value=profile?.name||''; $('#secretUsername').value=profile?.username||''; $('#secretPassword').value=''; $('#secretConfirm').value='';
}
function openSecret(index) {
  const step=state.workflow.steps[index]; $('#secretStepIndex').value=index;
  const select=$('#secretProfile'); select.innerHTML='<option value="">פרופיל חדש</option>'+Object.entries(state.profiles).map(([id,p])=>`<option value="${id}">${escapeHtml(p.name)} — ${escapeHtml(p.username)} ${p.has_password?'🔒':'🔑'}</option>`).join('');
  select.value=step.credential_profile_id||''; fillProfile(select.value); $('#secretDialog').showModal();
}
async function saveSecret(event) {
  event.preventDefault(); const stepIndex=Number($('#secretStepIndex').value);
  await MavatUI.json('/api/credentials',{method:'POST',body:JSON.stringify({step_index:stepIndex,profile_id:$('#secretProfile').value||null,name:$('#secretName').value.trim(),username:$('#secretUsername').value.trim(),password:$('#secretPassword').value,confirm_password:$('#secretConfirm').value})});
  $('#secretDialog').close(); await loadWorkflow(); MavatUI.toast('הסיסמה נשמרה וקושרה לשלב','success');
}
async function pollRecording() {
  try { const data=await MavatUI.json('/api/recording/status'); $('#recordStatus').textContent=data.message; $('#recordStatus').className=`record-pill ${data.state}`; state.recording=data.state==='recording'||data.state==='connecting'; $('#startRecording').disabled=state.recording; $('#stopRecording').disabled=!state.recording; if(data.state==='recording') await loadWorkflow(); } catch(_){}
}

ACTIONS.forEach(action=>$('#stepType').insertAdjacentHTML('beforeend',`<option>${action}</option>`));
$('#searchSteps').addEventListener('input',applyFilters); $('#statusFilter').addEventListener('change',applyFilters);
$('#addStep').addEventListener('click',()=>openStep()); $('#saveStep').addEventListener('click',saveStep); $('#stepForm').addEventListener('submit',saveStep);
$('#secretProfile').addEventListener('change',event=>fillProfile(event.target.value)); $('#saveSecret').addEventListener('click',saveSecret); $('#secretForm').addEventListener('submit',saveSecret);
$('#showPassword').addEventListener('change',event=>{ const type=event.target.checked?'text':'password'; $('#secretPassword').type=type; $('#secretConfirm').type=type; });
$('#deletePassword').addEventListener('click',async()=>{ const id=$('#secretProfile').value; if(!id)return MavatUI.toast('בחר פרופיל קיים','error'); if(!confirm('למחוק את הסיסמה השמורה?'))return; await MavatUI.json(`/api/credentials/${id}/password`,{method:'DELETE'}); await loadWorkflow(); fillProfile(id); MavatUI.toast('הסיסמה נמחקה','success'); });
$('#startRecording').addEventListener('click',async()=>{ const data=await MavatUI.json('/api/recording/start',{method:'POST'}); MavatUI.toast(data.message); pollRecording(); });
$('#stopRecording').addEventListener('click',async()=>{ await MavatUI.json('/api/recording/stop',{method:'POST'}); pollRecording(); });
$('#openChrome').addEventListener('click',async()=>{ await MavatUI.json('/api/chrome/open',{method:'POST'}); MavatUI.toast('Chrome נפתח בדף מבא״ת','success'); });
$('#openRuns').addEventListener('click',()=>location.href='/runs');
document.querySelectorAll('[data-bulk]').forEach(button=>button.addEventListener('click',()=>bulk(button.dataset.bulk))); $('#clearSelection').addEventListener('click',()=>{state.selected.clear();render();});
document.addEventListener('keydown',event=>{ if(event.key==='Delete'&&state.selected.size&&!document.querySelector('dialog[open]'))bulk('delete'); if(event.key==='Escape'&&state.selected.size){state.selected.clear();render();} });
setInterval(pollRecording,1400); loadWorkflow(); pollRecording();
