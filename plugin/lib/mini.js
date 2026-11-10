/**
 * The standalone Moments mini window.
 *
 * The page is served by the plugin itself so it works as a real separate OS
 * window (an Electron BrowserWindow in the desktop app, a popup elsewhere).
 * It talks to the same Host route as the main panel, so notes, tags and the
 * trash behave identically in both surfaces.
 */

const MINI_STYLE = `
:root{color-scheme:light dark;--canvas:#fbf6f3;--surface:#fffdfc;--surface-2:#f5ede8;--ink:#211b17;--secondary:#695e59;--line:rgba(83,50,32,.14);--line-strong:rgba(83,50,32,.22);--accent:#b5402a;--accent-ink:#9a3521;--on-accent:#ffffff;--error:#b4231f;--shadow:0 2px 6px rgba(35,24,18,.06),0 16px 36px -12px rgba(35,24,18,.18)}
@media (prefers-color-scheme:dark){:root{--canvas:#171412;--surface:#211e1c;--surface-2:#2b2724;--ink:#f6f2ef;--secondary:#bdb7b2;--line:rgba(255,241,230,.12);--line-strong:rgba(255,241,230,.20);--accent:#e4644a;--accent-ink:#e8876f;--on-accent:#151517;--error:#f25a5a;--shadow:0 2px 6px rgba(0,0,0,.28),0 16px 36px -12px rgba(0,0,0,.52)}}
*{box-sizing:border-box}
html,body{height:100%}
body{margin:0;display:flex;flex-direction:column;background:var(--canvas);color:var(--ink);font:14px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;-webkit-font-smoothing:antialiased}
button,textarea{font:inherit}
button{touch-action:manipulation}
button:focus-visible,textarea:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.bar{display:flex;align-items:center;justify-content:space-between;gap:12px;min-height:56px;padding:12px 16px;border-bottom:1px solid var(--line)}
.brand{display:flex;align-items:center;gap:8px;font-size:13px;font-weight:600;letter-spacing:.01em}
.brand:before{content:"";width:3px;height:18px;border-radius:999px;background:var(--accent)}
.bar-actions{display:flex;align-items:center;gap:4px}
.ghost{display:inline-flex;align-items:center;justify-content:center;width:32px;height:32px;padding:0;border:0;border-radius:8px;background:transparent;color:var(--secondary);cursor:pointer;transition:background-color 100ms ease,color 100ms ease}
.ghost:hover{background:var(--surface-2);color:var(--ink)}
.ghost svg,.thumb button svg{width:16px;height:16px;fill:none;stroke:currentColor;stroke-width:1.5;stroke-linecap:round}
main{flex:1;min-height:0;overflow-y:auto;padding:16px}
#mini-editor{display:block;width:100%;min-height:128px;resize:vertical;padding:16px;border:1px solid var(--line);border-radius:12px;outline:0;background:var(--surface);box-shadow:var(--shadow);color:var(--ink);font:inherit;line-height:1.7;transition:border-color 100ms ease,box-shadow 100ms ease}
#mini-editor::placeholder{color:var(--secondary)}
#mini-editor:focus{border-color:var(--accent);outline:0;box-shadow:var(--shadow),0 0 0 3px color-mix(in srgb,var(--accent) 14%,transparent)}
.foot{display:flex;align-items:center;gap:8px;margin-top:12px;flex-wrap:wrap}
.count{color:var(--secondary);font-size:12px;font-variant-numeric:tabular-nums}
.hint{flex:1;color:var(--secondary);font-size:12px}
.primary{min-height:36px;padding:8px 16px;border:0;border-radius:8px;background:var(--accent);color:var(--on-accent);cursor:pointer;font:inherit;font-size:13px;font-weight:600;transition:background-color 100ms ease}
.primary:hover:not(:disabled){background:var(--accent-ink)}
.primary:disabled{opacity:.45;cursor:not-allowed}
.error{margin-top:12px;padding:12px;border:1px solid var(--error);border-radius:8px;color:var(--error);font-size:12px}
.thumbs{display:flex;gap:8px;margin-top:12px;flex-wrap:wrap}
.thumb{position:relative;width:64px;height:64px;overflow:hidden;border:1px solid var(--line);border-radius:8px;background:var(--surface-2)}
.thumb img{width:100%;height:100%;object-fit:cover}
.thumb button{position:absolute;top:4px;right:4px;display:flex;align-items:center;justify-content:center;width:24px;height:24px;padding:4px;border:0;border-radius:50%;background:var(--ink);color:var(--canvas);cursor:pointer}
.list{margin-top:24px}
.list-heading{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:8px}
.list-heading h2{margin:0;font-size:12px;font-weight:600;letter-spacing:.04em;text-transform:uppercase;color:var(--secondary)}
.list ul{margin:0;padding:0;list-style:none;display:flex;flex-direction:column;gap:4px}
.item{display:block;width:100%;min-height:52px;padding:8px 12px;border:0;border-radius:8px;background:transparent;color:inherit;text-align:left;cursor:pointer;font:inherit;transition:background-color 100ms ease}
.item:hover{background:var(--surface-2)}
.item time{display:block;color:var(--secondary);font-size:12px;font-variant-numeric:tabular-nums}
.item-body{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13px}
.empty,.loading,.partial{padding:12px 2px;color:var(--secondary);font-size:12px}
.partial{padding:12px;border-radius:8px;background:var(--surface-2);color:var(--accent-ink)}
@media (prefers-reduced-motion:reduce){*,*:before,*:after{animation-duration:.01ms!important;transition-duration:.01ms!important}}
`;

const MINI_BODY = [
  '<header class="bar">',
  '<div class="brand">Moments</div>',
  '<div class="bar-actions">',
  '<button type="button" id="mini-close" class="ghost" aria-label="Close the float"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg></button>',
  '</div>',
  '</header>',
  '<main>',
  '<textarea id="mini-editor" placeholder="Capture a thought, file it with #tags"></textarea>',
  '<div id="mini-thumbs" class="thumbs"></div>',
  '<div class="foot">',
  '<span id="mini-count" class="count">0 chars</span>',
  '<span class="hint">⌘/Ctrl + Enter to save · paste a screenshot straight in</span>',
  '<button type="button" id="mini-save" class="primary">Save</button>',
  '</div>',
  '<div id="mini-error" class="error" role="alert" hidden></div>',
  '<section class="list">',
  '<div class="list-heading"><h2>Recent notes</h2><button type="button" id="mini-retry" class="ghost" aria-label="Retry loading recent notes" title="Retry loading recent notes"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 11a8 8 0 1 0-2 5.3M20 4v7h-7"/></svg></button></div>',
  '<ul id="mini-list"></ul>',
  '</section>',
  '</main>',
].join('');

const MINI_SCRIPT = [
  "var API='/api/moments-notes';",
  "var GEOMETRY_KEY='moments-mini:geometry';",
  'var editor=document.getElementById("mini-editor");',
  'var list=document.getElementById("mini-list");',
  'var count=document.getElementById("mini-count");',
  'var errorBox=document.getElementById("mini-error");',
  'var thumbs=document.getElementById("mini-thumbs");',
  'var saveButton=document.getElementById("mini-save");',
  'var retryButton=document.getElementById("mini-retry");',
  'var editingId=null;',
  'var attachments=[];',
  'function setError(message){errorBox.textContent=message||"";errorBox.hidden=!message;}',
  'function updateCount(){count.textContent=editor.value.length+" chars";}',
  'function call(method,payload){',
  'return fetch(API,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({method:method,payload:payload})})',
  '.then(function(response){if(response.status===401||response.status===403){var failure=new Error("Permission required. Reopen this window from an authenticated Harness session, then retry.");failure.code="permission";throw failure;}return response.json();})',
  '.then(function(body){if(!body||body.ok!==true){throw new Error((body&&body.error&&body.error.message)||"The action failed");}return body.result;});',
  '}',
  'function renderAttachments(){',
  'thumbs.textContent="";',
  'attachments.forEach(function(item,index){',
  'var box=document.createElement("div");box.className="thumb";',
  'var image=document.createElement("img");image.src=item.dataUrl;image.alt=item.name;',
  'var remove=document.createElement("button");remove.type="button";',
  'var closeIcon=document.createElementNS("http://www.w3.org/2000/svg","svg");closeIcon.setAttribute("viewBox","0 0 24 24");closeIcon.setAttribute("aria-hidden","true");',
  'var closePath=document.createElementNS("http://www.w3.org/2000/svg","path");closePath.setAttribute("d","M6 6l12 12M18 6L6 18");',
  'closeIcon.appendChild(closePath);remove.appendChild(closeIcon);',
  'remove.setAttribute("aria-label","Remove image");',
  'remove.addEventListener("click",function(){attachments.splice(index,1);renderAttachments();});',
  'box.appendChild(image);box.appendChild(remove);thumbs.appendChild(box);',
  '});',
  '}',
  'function formatTime(value){',
  'try{return new Date(value).toLocaleString(undefined,{month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit"});}',
  'catch(error){return "";}',
  '}',
  'function loadList(){',
  'setError("");retryButton.disabled=true;',
  'var loading=document.createElement("li");loading.className="loading";loading.setAttribute("role","status");loading.textContent="Loading recent notes…";',
  'list.textContent="";list.appendChild(loading);',
  'return call("snapshot",{}).then(function(snapshot){',
  'var rows=Array.isArray(snapshot.notes)?snapshot.notes:[];',
  'var failedItems=rows.filter(function(note){return !note||typeof note.id!=="string"||!note.id;}).length;',
  'var notes=rows.filter(function(note){return note&&typeof note.id==="string"&&note.id;}).slice(0,8);',
  'list.textContent="";',
  'if(failedItems){var partial=document.createElement("li");partial.className="partial";partial.setAttribute("role","status");partial.textContent=failedItems+" notes could not be shown. Retry failed items with the refresh button.";list.appendChild(partial);}',
  'if(!notes.length){var empty=document.createElement("li");empty.className="empty";empty.textContent=failedItems?"No readable notes":"No notes yet";list.appendChild(empty);return;}',
  'notes.forEach(function(note){',
  'var row=document.createElement("li");',
  'var button=document.createElement("button");button.type="button";button.className="item";',
  'var time=document.createElement("time");time.textContent=formatTime(note.createdAt);',
  'var body=document.createElement("span");body.className="item-body";body.textContent=(note.content||"Image note").slice(0,140);',
  'button.appendChild(time);button.appendChild(body);',
  'button.addEventListener("click",function(){',
  'editingId=note.id;editor.value=note.content||"";',
  'attachments=(note.attachments||[]).slice();renderAttachments();updateCount();editor.focus();',
  '});',
  'row.appendChild(button);list.appendChild(row);',
  '});',
  '}).catch(function(error){setError(error.code==="permission"?error.message:"Could not load recent notes: "+(error.message||String(error))+" Your draft is unchanged; use the refresh button to retry.");})',
  '.finally(function(){retryButton.disabled=false;});',
  '}',
  'function save(){',
  'var content=editor.value;',
  'if(!content.trim()&&!attachments.length)return;',
  'saveButton.disabled=true;setError("");',
  'var request=editingId',
  '? call("update",{id:editingId,content:content,attachments:attachments})',
  ': call("create",{content:content,attachments:attachments});',
  'request.then(function(){',
  'editor.value="";editingId=null;attachments=[];renderAttachments();updateCount();return loadList();',
  '}).catch(function(error){setError("Could not save the note: "+(error.message||String(error))+" Your draft is unchanged; try again.");})',
  '.then(function(){saveButton.disabled=false;});',
  '}',
  'editor.addEventListener("input",updateCount);',
  'editor.addEventListener("keydown",function(event){',
  'if((event.metaKey||event.ctrlKey)&&event.key==="Enter"){event.preventDefault();save();}',
  '});',
  'editor.addEventListener("paste",function(event){',
  'var items=(event.clipboardData&&event.clipboardData.items)||[];',
  'var hasImage=false;',
  'for(var index=0;index<items.length;index+=1){',
  'var kind=items[index].kind;var type=(items[index].type||"").toLowerCase();',
  'if(kind==="file"&&type.indexOf("image/")===0){hasImage=true;}',
  '}',
  'if(!hasImage)return;',
  'event.preventDefault();',
  'for(var index=0;index<items.length;index+=1){',
  'var item=items[index];var type=(item.type||"").toLowerCase();',
  'if(item.kind!=="file"||type.indexOf("image/")!==0)continue;',
  'var blob=item.getAsFile();if(!blob)continue;',
  'var reader=new FileReader();',
  'reader.onload=function(){',
  'attachments.push({id:"clipboard-"+Date.now()+"-"+attachments.length,name:"clipboard-"+(attachments.length+1)+"."+(type.split("/")[1]||"png"),type:type,size:blob.size,dataUrl:String(reader.result||"")});',
  'renderAttachments();',
  '};',
  'reader.readAsDataURL(blob);',
  '}',
  '});',
  'saveButton.addEventListener("click",save);',
  'document.getElementById("mini-retry").addEventListener("click",loadList);',
  'document.getElementById("mini-close").addEventListener("click",function(){window.close();});',
  'function saveGeometry(){',
  'try{localStorage.setItem(GEOMETRY_KEY,JSON.stringify({left:window.screenX,top:window.screenY,width:window.outerWidth,height:window.outerHeight}));}catch(error){}',
  '}',
  'function restoreGeometry(){',
  'try{',
  'var raw=localStorage.getItem(GEOMETRY_KEY);if(!raw)return;',
  'var geometry=JSON.parse(raw);',
  'if(typeof geometry.left==="number"&&typeof geometry.top==="number")window.moveTo(geometry.left,geometry.top);',
  'if(typeof geometry.width==="number"&&typeof geometry.height==="number")window.resizeTo(geometry.width,geometry.height);',
  '}catch(error){}',
  '}',
  'window.addEventListener("beforeunload",saveGeometry);',
  'window.addEventListener("resize",saveGeometry);',
  'window.addEventListener("unload",saveGeometry);',
  'restoreGeometry();updateCount();loadList();',
].join('\n');

/** Build the standalone mini window document. */
export function buildMiniPage() {
  return [
    '<!doctype html>',
    '<html lang="zh-CN"><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width,initial-scale=1">',
    '<title>Moments float</title>',
    '<style>', MINI_STYLE, '</style>',
    '</head><body>',
    MINI_BODY,
    '<script>', MINI_SCRIPT, '</script>',
    '</body></html>',
  ].join('');
}
