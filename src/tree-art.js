// =============================================================
// fit tree — ビジュアル対応表＋SVG描画 (Stage A)
// -------------------------------------------------------------
// 「見た目」はすべてこのファイルに閉じ込める。将来リアル寄りの画像素材
// (AI生成/外注)へ差し替える時は、この対応表(SPECIES_ART / STAGE_ART)と
// 描画関数だけを差し替えればよい(呼び出し側 main.js は触らない)。
//   - SPECIES_ART: 種類 → シルエット型(broadleaf/conifer/palm)＋パレット
//   - STAGE_ART  : 段階(0..6) → 構造(幹高・樹冠サイズ・層数・開花)
//   - treeArt()  : 上2表から SVG 文字列を組み立てる唯一の入口
// フラット/teal・柔らかいトーン。数字は描かない(=木の姿だけ)。
// =============================================================

// 種類 → 見た目。foliage=葉の主色 / foliage2=陰 / trunk=幹 / bloom=花・実の色。
export const SPECIES_ART = {
  sakura: { type:'broadleaf', foliage:'#F6B6CD', foliage2:'#EE9BBB', trunk:'#9A6B4F', bloom:'#FF8FB6' },
  momiji: { type:'broadleaf', foliage:'#E9895B', foliage2:'#D96B3C', trunk:'#8F5E44', bloom:'#E0552E' },
  mikan:  { type:'broadleaf', foliage:'#82BE7C', foliage2:'#63A85E', trunk:'#8F6249', bloom:'#F7A43D' },
  ringo:  { type:'broadleaf', foliage:'#7CB870', foliage2:'#5EA153', trunk:'#8F6249', bloom:'#E0554E' },
  olive:  { type:'broadleaf', foliage:'#A2BE90', foliage2:'#82A870', trunk:'#8A7358', bloom:'#5B7B4E' },
  matsu:  { type:'conifer',   foliage:'#5E9E77', foliage2:'#3E7E57', trunk:'#8A6349', bloom:'#5E9E77' },
  yashi:  { type:'palm',      foliage:'#6FB68C', foliage2:'#4F966C', trunk:'#A07B54', bloom:'#8A6A44' },
};
export const DEFAULT_SPECIES_ART = SPECIES_ART.sakura;

// 段階 → 構造パラメータ。★将来の実データ調整・素材差し替えはここを触る★
export const STAGE_ART = [
  { kind:'seed'   },                                          // 0 種
  { kind:'sprout' },                                          // 1 芽
  { kind:'sapling', trunkH:16, size:14 },                     // 2 若葉
  { kind:'tree',    trunkH:26, size:22, layers:2 },           // 3 苗木
  { kind:'tree',    trunkH:34, size:30, layers:3 },           // 4 若木
  { kind:'tree',    trunkH:42, size:38, layers:3 },           // 5 成木
  { kind:'tree',    trunkH:46, size:42, layers:3, bloom:true },// 6 開花
];

// ---- 小道具 -------------------------------------------------
function hx(h){ h=h.replace('#',''); return [0,2,4].map(i=>parseInt(h.substr(i,2),16)); }
function mix(a,b,t){ const pa=hx(a),pb=hx(b); const c=pa.map((v,i)=>Math.round(v+(pb[i]-v)*t)); return `rgb(${c[0]},${c[1]},${c[2]})`; }
function ground(){ return `<ellipse cx="50" cy="112" rx="34" ry="6" fill="#E7E3D8"/>`; }

// ---- 段階: 種 / 芽 ------------------------------------------
function drawSeed(art){
  return `${ground()}
    <ellipse cx="50" cy="106" rx="9" ry="4.5" fill="#C9BBA3" opacity=".55"/>
    <ellipse cx="50" cy="103" rx="4.5" ry="5.5" fill="${art.trunk}"/>`;
}
function drawSprout(art){
  return `${ground()}
    <path d="M50 111 L50 95" stroke="${art.trunk}" stroke-width="3" fill="none" stroke-linecap="round"/>
    <g class="tree-sway">
      <path d="M50 100 Q 41 95 39 100 Q 46 103 50 100 Z" fill="${art.foliage}"/>
      <path d="M50 97 Q 59 92 61 97 Q 54 100 50 97 Z" fill="${art.foliage2}"/>
    </g>`;
}

// ---- 樹冠(3系統) --------------------------------------------
function broadleafCanopy(art, st){
  const s=st.size, cy=110 - st.trunkH - s*0.35;
  const canopy = [
    `<ellipse cx="50" cy="${cy}" rx="${s}" ry="${s*0.9}" fill="${art.foliage}"/>`,
    `<ellipse cx="${50-s*0.5}" cy="${cy+s*0.28}" rx="${s*0.72}" ry="${s*0.66}" fill="${art.foliage}"/>`,
    `<ellipse cx="${50+s*0.5}" cy="${cy+s*0.28}" rx="${s*0.72}" ry="${s*0.66}" fill="${art.foliage}"/>`,
    `<ellipse cx="${50+s*0.24}" cy="${cy-s*0.2}" rx="${s*0.62}" ry="${s*0.56}" fill="${art.foliage2}" opacity=".5"/>`,
  ].join('');
  return { canopy, cx:50, cy, r:s };
}
function coniferCanopy(art, st){
  const baseY=110-st.trunkH, layers=st.layers||3, step=st.size*0.62, w=st.size;
  let tri='';
  for(let i=0;i<layers;i++){
    const topY=baseY-(i+1)*step, midY=baseY-i*step, ww=w*(1-i*0.18);
    tri+=`<path d="M50 ${topY} L${50-ww} ${midY+2} L${50+ww} ${midY+2} Z" fill="${i%2?art.foliage2:art.foliage}"/>`;
  }
  return { canopy:tri, cx:50, cy:baseY-layers*step*0.5, r:st.size*0.7 };
}
function palmCanopy(art, st){
  const topY=110-st.trunkH, s=st.size;
  const frond=(ang)=>{ const r=ang*Math.PI/180;
    const ex=50+Math.cos(r)*s*1.2, ey=topY-Math.sin(r)*s*0.85;
    const mx=50+Math.cos(r)*s*0.55, my=topY-Math.sin(r)*s*0.6-6;
    return `<path d="M50 ${topY} Q ${mx} ${my} ${ex} ${ey}" stroke="${art.foliage}" stroke-width="4" fill="none" stroke-linecap="round"/>`; };
  const fronds=[20,55,90,125,160].map(frond).join('');
  return { canopy:fronds, cx:50, cy:topY-s*0.4, r:s };
}

// 開花(花/実の散らし)。樹冠中心まわりに小さく散らす。
function bloom(art, c){
  const pts=[[-0.5,-0.1],[0.32,-0.3],[0.6,0.22],[-0.2,0.36],[0.05,0.02]];
  return pts.map(([dx,dy])=>`<circle cx="${c.cx+dx*c.r}" cy="${c.cy+dy*c.r}" r="2.4" fill="${art.bloom}"/>`).join('');
}
// 実=ルール(Stage C)。level 0..1 で「小さな青→大きく色づく」。落ちない(破っても小さく青く戻るだけ)。
function drawFruits(fruits, c, art){
  if(!fruits || !fruits.length) return '';
  const anchors=[[-0.55,0.18],[0.55,0.18],[0,-0.5]];
  return fruits.slice(0,3).map((f,i)=>{
    const [dx,dy]=anchors[i]||[0,0];
    const lvl=Math.max(0,Math.min(1,f.level||0));
    const r=2 + lvl*2.6;
    const col = lvl<0.12 ? '#8AA6DD' : mix('#8AA6DD', art.bloom, lvl);
    return `<circle cx="${c.cx+dx*c.r}" cy="${c.cy+dy*c.r}" r="${r.toFixed(1)}" fill="${col}"/>`;
  }).join('');
}

function drawTree(art, st, fruits){
  const trunk = art.type==='palm'
    ? `<path d="M47 110 Q 52 ${110-st.trunkH*0.55} 50 ${110-st.trunkH}" stroke="${art.trunk}" stroke-width="6" fill="none" stroke-linecap="round"/>`
    : `<rect x="47" y="${110-st.trunkH}" width="6" height="${st.trunkH}" rx="3" fill="${art.trunk}"/>`;
  const c = art.type==='conifer' ? coniferCanopy(art,st)
          : art.type==='palm'    ? palmCanopy(art,st)
          :                        broadleafCanopy(art,st);
  const bloomDots = st.bloom ? bloom(art,c) : '';
  const fruitDots = drawFruits(fruits, c, art);
  return `${ground()}${trunk}<g class="tree-sway">${c.canopy}${bloomDots}${fruitDots}</g>`;
}

// ---- 唯一の入口 --------------------------------------------
// speciesKey: SPECIES_ART のキー / stageIdx: 0..6 / opts.{px,grow,fruits,label}
export function treeArt(speciesKey, stageIdx, opts={}){
  const art = SPECIES_ART[speciesKey] || DEFAULT_SPECIES_ART;
  const st  = STAGE_ART[Math.max(0, Math.min(stageIdx|0, STAGE_ART.length-1))];
  const px  = opts.px || 64;
  let inner;
  if(st.kind==='seed')        inner = drawSeed(art);
  else if(st.kind==='sprout') inner = drawSprout(art);
  else                        inner = drawTree(art, st, opts.fruits || []);
  const grow = opts.grow ? ' tree-grow' : '';
  return `<svg class="tree-svg${grow}" viewBox="0 0 100 120" width="${px}" height="${Math.round(px*1.15)}" role="img" aria-label="${opts.label||'fit tree'}">${inner}</svg>`;
}
