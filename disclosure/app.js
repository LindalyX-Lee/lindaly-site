"use strict";

const TIER_COLOR = { documented:"#3fb079", testimony:"#e3b53f", fringe:"#e0564f", fiction:"#a98cff" };
const PIN_COLOR  = { documented:"#2ea36a", testimony:"#d99f24", fringe:"#cf3b34", fiction:"#8e6dff" };

// cluster zones (cx,cy in % of board; grid cols + spacing). film handled specially.
const ZONES = {
  "us-gov":    { cx:50, cy:11, cols:5, dx:15.5, dy:8.5 },
  "cases":     { cx:11, cy:43, cols:2, dx:13,   dy:12  },
  "world":     { cx:89, cy:40, cols:2, dx:12.5, dy:11  },
  "abduction": { cx:16, cy:74, cols:2, dx:13,   dy:9   },
  "movement":  { cx:47, cy:87, cols:5, dx:13,   dy:8   },
  "china":     { cx:85, cy:75, cols:2, dx:13,   dy:9   },
  "channeled": { cx:31, cy:88, cols:3, dx:13,   dy:8   }
};
const FILM_POS = { "disclosure-day":[50,39], "close-encounters":[36,48] };

const PLACEHOLDER = "【缺失】 / missing in content.json";
let content=null, byId=new Map(), activeTiers=new Set(), activeCluster=null, selectedId=null, hoveredId=null;
let loupe=null;

const els = {};
["case-title","case-no","tier-filters","section-filters","show-documented","show-all","confidence-fill",
 "confidence-score","confidence-caption","board","string-layer","cards-layer","empty-state",
 "dossier","dossier-media","dossier-title","dossier-year","dossier-stamp","dossier-claim",
 "dossier-filmlink","dossier-cluster","dossier-sources","dossier-credit"].forEach(k=>els[k]=document.getElementById(k));

init();

async function init(){
  content = await load();
  if(!content){ fatal(); return; }
  byId = new Map(content.nodes.map(n=>[n.id,n]));
  activeTiers = new Set(Object.keys(content.meta.tiers));
  selectedId = content.meta.hub || content.nodes[0].id;
  document.title = content.meta.title || document.title;
  if(els["case-title"]) els["case-title"].innerHTML = '<span class="zh">揭秘日</span><span class="en">DISCLOSURE DAY <span class="seal">㊙</span></span>';
  if(els["case-no"]) els["case-no"].textContent = content.meta.caseNo || "";
  setupLoupe();
  renderFilters();
  renderSectionFilters();
  renderZoneLabels();
  renderCards();
  bind();
  selectNode(selectedId);
  applyFilters();
  requestAnimationFrame(drawStrings);
}

async function load(){
  try{ const r = await fetch("content.json",{cache:"no-store"}); if(!r.ok) throw 0; return await r.json(); }
  catch(e){ return null; }
}
function fatal(){
  if(els["dossier-title"]) els["dossier-title"].textContent="无法读取案卷";
  if(els["dossier-claim"]) els["dossier-claim"].textContent="content.json 读取失败。请用本地服务器打开（python3 -m http.server）。";
}
function tierColor(t){ return TIER_COLOR[t]||"#cfc4ad"; }
function txt(v){ return (typeof v==="string"&&v.trim())?v:PLACEHOLDER; }
function esc(v){ return String(v).replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;").replaceAll('"',"&quot;").replaceAll("'","&#039;"); }
function ytId(u){ if(!u) return null; const m=String(u).match(/[?&]v=([^&]+)/)||String(u).match(/youtu\.be\/([^?]+)/); return m?m[1]:null; }

function setupLoupe(){
  loupe=document.createElement("div"); loupe.className="loupe"; loupe.setAttribute("aria-hidden","true");
  document.body.append(loupe);
}
function bindLoupe(img){
  img.addEventListener("mouseenter",()=>{ loupe.style.backgroundImage=`url("${img.getAttribute('src')}")`; loupe.style.display="block"; });
  img.addEventListener("mouseleave",()=>{ loupe.style.display="none"; });
  img.addEventListener("mousemove",(e)=>{
    const r=img.getBoundingClientRect(); if(!r.width) return;
    const z=2.9, lw=loupe.offsetWidth||156;
    const bw=r.width*z, bh=r.height*z;
    const x=(e.clientX-r.left)/r.width, y=(e.clientY-r.top)/r.height;
    loupe.style.backgroundSize=`${bw}px ${bh}px`;
    loupe.style.backgroundPosition=`${-(x*bw-lw/2)}px ${-(y*bh-lw/2)}px`;
    loupe.style.left=`${e.clientX}px`; loupe.style.top=`${e.clientY}px`;
  });
}

function renderFilters(){
  els["tier-filters"].replaceChildren();
  Object.entries(content.meta.tiers).forEach(([key,tier])=>{
    const b=document.createElement("button");
    b.type="button"; b.className="tier-toggle"; b.dataset.tier=key;
    b.style.setProperty("--tier-color",tierColor(key));
    b.setAttribute("aria-pressed","true");
    b.innerHTML=`${esc(tier.emoji||"")} ${esc(tier.stamp||tier.label||key)}`;
    b.addEventListener("click",()=>{ activeTiers.has(key)?activeTiers.delete(key):activeTiers.add(key); applyFilters(); });
    els["tier-filters"].append(b);
  });
}

function renderSectionFilters(){
  if(!els["section-filters"]) return;
  els["section-filters"].replaceChildren();
  const all=document.createElement("button");
  all.type="button"; all.className="sec-toggle is-on"; all.dataset.cluster="";
  all.textContent="全部 ALL";
  all.addEventListener("click",()=>setSection(null));
  els["section-filters"].append(all);
  Object.entries(content.meta.clusters||{}).forEach(([key,label])=>{
    const b=document.createElement("button");
    b.type="button"; b.className="sec-toggle"; b.dataset.cluster=key;
    b.textContent=label;
    b.addEventListener("click",()=>setSection(activeCluster===key?null:key));
    els["section-filters"].append(b);
  });
}
function setSection(key){ activeCluster=key; applyFilters(); }

function renderZoneLabels(){
  const clusters = content.meta.clusters||{};
  Object.entries(ZONES).forEach(([key,z])=>{
    if(!clusters[key]) return;
    const lab=document.createElement("div");
    lab.className="zone-label"; lab.dataset.cluster=key; lab.textContent=clusters[key];
    lab.style.left=`${z.cx}%`; lab.style.top=`${Math.max(z.cy-(z.cols>3?7:13),1)}%`;
    els["cards-layer"].append(lab);
  });
}

function positionFor(node, idxInCluster, clusterCount){
  if(node.cluster==="film" && FILM_POS[node.id]) return FILM_POS[node.id];
  const z=ZONES[node.cluster]; if(!z) return [50,50];
  const cols=z.cols, rows=Math.ceil(clusterCount/cols);
  const r=Math.floor(idxInCluster/cols), c=idxInCluster%cols;
  const colsInRow=Math.min(cols, clusterCount-r*cols);
  const x=z.cx + (c-(colsInRow-1)/2)*z.dx;
  const y=z.cy + (r-(rows-1)/2)*z.dy;
  return [x,y];
}

function renderCards(){
  const counts={}, idx={};
  content.nodes.forEach(n=>counts[n.cluster]=(counts[n.cluster]||0)+1);
  content.nodes.forEach((n,i)=>{
    idx[n.cluster]=(idx[n.cluster]||0);
    const tier=content.meta.tiers[n.tier]||{};
    const cl=(content.meta.clusters&&content.meta.clusters[n.cluster])||n.cluster||"";
    const hasImg=!!n.image, isVid=!!(n.video||n.youtube);
    const card=document.createElement("article");
    card.className="evidence "+(hasImg?"evidence--photo":(isVid?"evidence--video":"evidence--doc"))+(n.id===content.meta.hub?" is-hub":"");
    card.dataset.nodeId=n.id; card.dataset.tier=n.tier||""; card.dataset.cluster=n.cluster||"";
    card.style.setProperty("--tier-color",tierColor(n.tier));
    card.style.setProperty("--pin",PIN_COLOR[n.tier]||"#c33");
    card.style.setProperty("--rot",`${((i*37)%7-3)*1.3}deg`);
    const stamp=`<span class="card-stamp">${esc(tier.stamp||"")}</span>`;
    const cluster=`<span class="card-cluster">${esc(cl)}</span>`;
    const play=isVid?`<span class="card-vtag">▶ VIDEO</span><span class="card-play">▶</span>`:"";
    let inner;
    if(hasImg){
      inner=`<div class="card-frame"><img class="card-media" src="${esc(n.image)}" alt="${esc(txt(n.title))}" loading="lazy">${play}${stamp}<div class="card-cap"><b>${esc(txt(n.title))}</b><span>${esc(n.year||"")}</span></div>${cluster}</div>`;
    } else if(isVid){
      inner=`<div class="card-frame"><div class="card-media vid-blank">${play}</div>${stamp}<div class="card-cap"><b>${esc(txt(n.title))}</b><span>${esc(n.year||"")}</span></div>${cluster}</div>`;
    } else {
      inner=`<div class="card-frame"><div class="doc-top"><span>FILE · ${esc(cl)}</span><span>${esc(n.year||"")}</span></div><div class="doc-title">${esc(txt(n.title))}</div><div class="redact m"></div><div class="redact s"></div><div class="redact m"></div>${stamp}${cluster}</div>`;
    }
    card.innerHTML=inner;
    card.addEventListener("click",()=>selectNode(n.id));
    card.addEventListener("mouseenter",()=>{ hoveredId=n.id; highlightLinks(); drawStrings(); });
    card.addEventListener("mouseleave",()=>{ hoveredId=null; highlightLinks(); drawStrings(); });
    const img=card.querySelector("img.card-media"); if(img) bindLoupe(img);
    const [x,y]=positionFor(n, idx[n.cluster], counts[n.cluster]);
    idx[n.cluster]++;
    card.style.left=`${x}%`; card.style.top=`${y}%`;
    els["cards-layer"].append(card);
  });
}

function bind(){
  els["show-documented"].addEventListener("click",()=>{activeTiers=new Set(["documented"]);applyFilters();});
  els["show-all"].addEventListener("click",()=>{activeTiers=new Set(Object.keys(content.meta.tiers));activeCluster=null;applyFilters();});
  window.addEventListener("resize",drawStrings);
}
function cardEl(id){ return Array.from(els["cards-layer"].querySelectorAll(".evidence")).find(c=>c.dataset.nodeId===id); }
function visibleNodes(){ return content.nodes.filter(n=>activeTiers.has(n.tier)); }

function highlightLinks(){
  const linked=new Set();
  if(hoveredId){ const n=byId.get(hoveredId); linked.add(hoveredId); (n?.connects||[]).forEach(c=>linked.add(c));
    content.nodes.forEach(x=>{ if((x.connects||[]).includes(hoveredId)) linked.add(x.id); }); }
  Array.from(els["cards-layer"].querySelectorAll(".evidence")).forEach(c=>{
    c.classList.toggle("is-linked", hoveredId? linked.has(c.dataset.nodeId):false);
    c.classList.toggle("is-faded", hoveredId? !linked.has(c.dataset.nodeId):false);
  });
}

function applyFilters(){
  content.nodes.forEach(n=>{ const c=cardEl(n.id); if(!c) return;
    c.classList.toggle("is-hidden",!activeTiers.has(n.tier));
    c.classList.toggle("is-dimmed", !!activeCluster && n.cluster!==activeCluster);
  });
  Array.from(els["tier-filters"].children).forEach(b=>b.setAttribute("aria-pressed",String(activeTiers.has(b.dataset.tier))));
  if(els["section-filters"]) Array.from(els["section-filters"].children).forEach(b=>b.classList.toggle("is-on",(b.dataset.cluster||"")===(activeCluster||"")));
  Array.from(els["cards-layer"].querySelectorAll(".zone-label")).forEach(l=>l.classList.toggle("zone-active",!!activeCluster&&l.dataset.cluster===activeCluster));
  const vis=visibleNodes();
  if(selectedId && !activeTiers.has(byId.get(selectedId)?.tier)){ selectedId=vis[0]?.id||null; if(selectedId) renderDossier(byId.get(selectedId)); }
  els["empty-state"].hidden=vis.length>0;
  markSelected(); updateMeter(vis); drawStrings();
}
function selectNode(id){
  const n=byId.get(id); if(!n) return;
  selectedId=id; renderDossier(n); markSelected(); updateMeter(visibleNodes()); drawStrings();
  if(window.matchMedia("(max-width:980px)").matches) els["dossier"].scrollIntoView({behavior:"smooth",block:"start"});
}
function markSelected(){ Array.from(els["cards-layer"].querySelectorAll(".evidence")).forEach(c=>c.classList.toggle("is-selected",c.dataset.nodeId===selectedId)); }

function renderDossier(n){
  const tier=content.meta.tiers[n.tier]||{};
  els["dossier-media"].className="dossier-media";
  const yid=ytId(n.youtube);
  if(n.video){
    els["dossier-media"].innerHTML=`<video controls preload="metadata" ${n.image?`poster="${esc(n.image)}"`:""} src="${esc(n.video)}"></video>`;
  } else if(yid){
    els["dossier-media"].innerHTML=`<iframe src="https://www.youtube.com/embed/${esc(yid)}" title="${esc(txt(n.title))}" allow="accelerometer; clipboard-write; encrypted-media; gyroscope; picture-in-picture" allowfullscreen loading="lazy"></iframe>`;
  } else if(n.image){
    els["dossier-media"].innerHTML=`<img src="${esc(n.image)}" alt="${esc(txt(n.title))}">`;
  } else {
    els["dossier-media"].classList.add("pending");
    els["dossier-media"].textContent="影像待补 / ARCHIVE PENDING";
  }
  els["dossier-title"].textContent=txt(n.title);
  els["dossier-year"].textContent=n.year||"";
  els["dossier-stamp"].innerHTML=`<span class="stamp-ink" style="--tier-color:${tierColor(n.tier)}">${esc(tier.emoji||"")} ${esc(tier.stamp||"")}</span><span class="stamp-desc">${esc(txt(tier.desc))}</span>`;
  els["dossier-claim"].textContent=txt(n.claim);
  els["dossier-filmlink"].textContent=txt(n.filmLink);
  els["dossier-cluster"].textContent=(content.meta.clusters&&content.meta.clusters[n.cluster])||n.cluster||"—";
  els["dossier-sources"].replaceChildren();
  const src=Array.isArray(n.sources)?n.sources:[];
  if(n.youtube){ const li=document.createElement("li"); const a=document.createElement("a"); a.href=n.youtube; a.target="_blank"; a.rel="noopener noreferrer"; a.className="src-yt"; a.textContent="▶ YouTube 影像"; li.append(a); els["dossier-sources"].append(li); }
  if(!src.length && !n.youtube){ const li=document.createElement("li"); li.textContent=PLACEHOLDER; els["dossier-sources"].append(li); }
  else src.forEach(s=>{ const li=document.createElement("li"); const a=document.createElement("a"); a.href=s.url||"#"; a.target="_blank"; a.rel="noopener noreferrer"; a.textContent=txt(s.label); li.append(a); els["dossier-sources"].append(li); });
  const cr=[]; if(n.imageCredit) cr.push("图："+n.imageCredit); if(n.videoCredit) cr.push("视频："+n.videoCredit);
  els["dossier-credit"].textContent=cr.join("　·　");
}

function updateMeter(vis){
  const conf=t=>content.meta.tiers[t]?.confidence ?? 50;
  const sel=selectedId?byId.get(selectedId):null;
  const va=vis.length? vis.reduce((s,n)=>s+conf(n.tier),0)/vis.length : 0;
  const score=vis.length? Math.round(sel&&activeTiers.has(sel.tier)? conf(sel.tier)*0.6+va*0.4 : va) : 0;
  const color=score>=80?"#3fb079":score>=50?"#e3b53f":"#e0564f";
  const track=els["confidence-fill"].parentElement; if(track) track.style.background="#241d12";
  els["confidence-fill"].style.cssText=`position:absolute;left:0;top:0;height:100%;width:${score}%;background:${color};transition:width .5s cubic-bezier(.4,1.3,.4,1)`;
  els["confidence-score"].textContent=vis.length?`${score}%`:"—";
  els["confidence-caption"].textContent=!vis.length?"无可见线索 / no leads":score>=85?"证据扎实 / Solid case":score>=60?"多为证词 / Mostly testimony":score>=40?"进入推测·虚构 / Speculative":"离开坚实地面 / Leaving solid ground";
}

function center(c,rect){ const r=c.getBoundingClientRect(); return {x:r.left+r.width/2-rect.left, y:r.top+r.height/2-rect.top}; }
function drawStrings(){
  if(!content) return;
  const board=els["board"].getBoundingClientRect();
  const svg=els["string-layer"];
  svg.setAttribute("viewBox",`0 0 ${board.width} ${board.height}`);
  svg.replaceChildren();
  const seen=new Set();
  content.nodes.forEach(n=>{
    const from=cardEl(n.id); if(!from||from.classList.contains("is-hidden")) return;
    (Array.isArray(n.connects)?n.connects:[]).forEach(tid=>{
      const key=[n.id,tid].sort().join("|"); if(seen.has(key)) return; seen.add(key);
      const to=cardEl(tid); if(!to||to.classList.contains("is-hidden")) return;
      const a=center(from,board), b=center(to,board);
      const midX=(a.x+b.x)/2, midY=(a.y+b.y)/2;
      const sag=Math.min(Math.max(Math.hypot(b.x-a.x,b.y-a.y)*0.1,10),46);
      const p=document.createElementNS("http://www.w3.org/2000/svg","path");
      p.setAttribute("d",`M ${a.x.toFixed(1)} ${a.y.toFixed(1)} Q ${midX.toFixed(1)} ${(midY+sag).toFixed(1)} ${b.x.toFixed(1)} ${b.y.toFixed(1)}`);
      const hot = hoveredId? (n.id===hoveredId||tid===hoveredId) : (n.id===selectedId||tid===selectedId);
      const cold = (hoveredId && !(n.id===hoveredId||tid===hoveredId)) || (activeCluster && n.cluster!==activeCluster && to.dataset.cluster!==activeCluster);
      p.setAttribute("class","string"+(hot?" is-active":"")+(cold?" is-cold":""));
      svg.append(p);
    });
  });
}
