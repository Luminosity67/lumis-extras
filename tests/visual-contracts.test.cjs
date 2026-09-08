const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {test} = require('node:test');
const source = fs.readFileSync(process.env.LUMI_TEST_SOURCE || path.join(__dirname, '../lumis-extras.user.js'), 'utf8');
function fn(name) {
  const start = source.search(new RegExp('^  function ' + name + '\\(', 'm'));
  assert.notEqual(start, -1, name + ' exists');
  return source.slice(start, source.indexOf('\n  }', start) + 4);
}
// Constructor contracts transcribed from mope.io/BrhD8Ove.js (2026-09-08):
// animal is a model owning container, name, arenaWins and HUD; arena owns
// base/walls/textPlayer1/textPlayer2/timer/message. RenderLayer has a distinct
// renderLayerChildren list; attaching twice to the same layer does NOT reorder.
class Container {
  constructor() { this.children = []; this.parent = null; this.worldTransform = {a: 1,b: 0,tx: 0,ty: 0}; this.alpha = 1; this.visible = true; this.renderable = true; }
  addChild(...nodes) { for (const n of nodes) this.addChildAt(n,this.children.length); return nodes[0]; }
  addChildAt(n,i) { if(n.parent) n.parent.removeChild(n); this.children.splice(i,0,n); n.parent=this; return n; }
  removeChild(n) { const i=this.children.indexOf(n); if(i>=0)this.children.splice(i,1); n.parent=null; return n; }
  setChildIndex(n,i) { this.children.splice(this.children.indexOf(n),1); this.children.splice(i,0,n); }
  destroy() { this.destroyed=true; }
}
class Layer extends Container {
  constructor() { super(); this.renderLayerChildren=[]; }
  attach(n) { if(n.parentRenderLayer===this)return n; if(n.parentRenderLayer)n.parentRenderLayer.detach(n); this.renderLayerChildren.push(n); n.parentRenderLayer=this; return n; }
  detach(n) { const i=this.renderLayerChildren.indexOf(n); if(i>=0)this.renderLayerChildren.splice(i,1); n.parentRenderLayer=null; }
  destroy() { for(const n of [...this.renderLayerChildren])this.detach(n); super.destroy(); }
}
function point(x=1,y=x){return {x,y,set(a,b=a){this.x=a;this.y=b;}};}
class Text extends Container {
  constructor({text='',style={}}={}) { super(); this.text=text; this.style={fontFamily:'Arial',fontSize:11,...style}; this.tint=0xffffff; this.anchor=point(.5); this.position=point(0); this.scale=point(1); }
  get width(){return this.text.length*8;}
}
class Graphics extends Container { clear(){return this;} circle(){return this;} fill(){return this;} }
function animal(name,layer) {
  const model={type:'animal',spawned:true,container:new Container(),name:new Text({text:name}),arenaWins:new Text({text:'(Wins: 0)'}),HUD:new Container(),arena:null};
  model.container.addChild(new Container(),model.name,model.arenaWins,new Container(),model.HUD);
  const world=layer.parent;
  world.addChild(model.container); layer.attach(model.container);
  model.nativeLayer=layer;
  model.updateLayer=function(){this.nativeLayer.attach(this.container);return this.nativeLayer;};
  return model;
}
function arena(world,layer,extra=0) {
  const model={container:new Container(),base:new Container(),walls:new Graphics(),textPlayer1:new Text({text:'P1'}),textPlayer2:new Text({text:'P2'}),timer:new Text({text:'1:00'}),message:new Text()};
  model.base.texture={}; model.base.width=1000;
  model.container.addChild(model.base,model.walls,model.textPlayer1,model.textPlayer2,model.timer,model.message);
  for(let i=0;i<extra;i++)model.container.addChild(new Container());
  world.addChild(model.container);layer.attach(model.base);return model;
}
function setup(names) {
  const world=new Container(), low=new Layer(),high=new Layer();world.addChild(low,high);
  const me=animal('67',low),other=animal('67',high);
  const game={player:me,classes:{global:{animal:{list:new Map([[1,me],[2,other]])}}}};
  const c=vm.createContext({
    console,gameCapture:{game},hpState:{bars:new Map(),player:other.container,playerEntry:{entity:other.container}},
    settings:{masterEnabled:true,arenaSky:true},nameColorState:{enabled:true,mode:'grad',grad:0,anim:false},
    nrLookup:()=>({solid:0x765432}),nameKey:()=> '67',baseKey:t=>t.split('~')[0].toLowerCase(),
    decodeSuffix:t=>t.endsWith('~tag')?{grad:0}:null,colorInt:()=>0x123456,
    ownStyle:()=>({grad:0,self:true}),hpIdentify:()=>null,
    tinted:new Set(),overlays:new Map(),nameOriginals:new WeakMap(),nameBindings:new WeakMap(),ambiguousNames:new Set(),
    sweepStack:[],sweepSelfCandidates:[],nameSeenCounts:new Map(),nameBarYes:new WeakSet(),nameBarNo:new WeakSet(),
    hpScan:{active:false},arenaScan:{active:false,found:[],nearMiss:[]},arenaSky:{},
    NAME_WHITE:0xffffff,NAME_GRAPHEME_SEGMENTER:null,INVIS_SET:new Set(['~']),ANIM_PERIOD:3000,
    textHasEmoji:()=>false,isEmojiGrapheme:()=>false,gradStopsOf:()=>[0x123456,0xabcdef],gradColorAt:()=>0x123456,
    frameFailed:(name,e)=>{c.failures.push([name,String(e)]);},failures:[],dbg(){},
    zorder:{mode:1,at:0,home:null,homeFor:null},ZORDER_APPLY_MS:250,
    ARENA_KIDS_MIN:6,ARENA_KIDS_MAX:24,ARENA_KIDS_LOOK:64,arenaNeeded:()=>true,
    arenaNameHidden:()=>true,arenaNameIndex:1,hpSelfEntry:()=>null,
    hpInArena:()=>true,hpEntityInArena:()=>true,arenaSkyLockIsSelf:()=>true,
    arenaHudApply(){},performance:{now:()=>1000},
  });
  // Optional adapters are absent in older releases. Skip only absent functions
  // so LUMI_TEST_SOURCE can reproduce old behaviour as a negative control.
  for(const name of [...names,'textIsBarReadout','resolveSelfCandidates','nodeDistanceFromCentre']) {
    if (source.includes('  function '+name+'(')) vm.runInContext(fn(name),c);
  }
  return {c,world,low,high,me,other,game,run:code=>vm.runInContext(code,c)};
}
const identity=['hpGameModel','hpGamePlayer','gameModels'];
const names=[...identity,'sharedStyleFor','styleFor','nameOwners','sceneNameStyle','sweep',
  'nameReconcile',
  'splitNameGraphemes','overlayWanted','overlayKeyFor','ensureNameOverlay','applyNameStyle',
  'destroyOverlay','syncOverlayLayout','syncOverlayVisibility'];
const arenas=[...identity,'arenaPartsOf','arenaMineOf','arenaConsiderNode','arenaSkyPick','arenaSkyAttach','arenaSkyDetach'];
const layers=[...identity,'zorderOn','zorderRank','zorderLayers','zorderMove','zorderApply','zorderRestore'];

for(const name of ['67','a','mope.io','普通名字','Same Name'])test('name ownership and repeated gradient sweeps: '+name,()=>{
  const h=setup(names);h.me.name.text=name;h.other.name.text=name;h.c.nameKey=()=>name;
  const hp=new Text({text:name}),chat=new Text({text:name});h.other.HUD.addChild(hp,chat);
  h.c.root=h.world;
  for(let i=0;i<10;i++)h.run('sweep(root)');
  assert.equal(h.c.overlays.size,1,'only self gets a gradient');
  assert.ok(h.c.overlays.has(h.me.name));
  assert.equal(h.other.name.tint,0xffffff,'non-script names never inherit a retained registry colour');
  assert.equal(hp.tint,0xffffff);assert.equal(chat.tint,0xffffff);
  assert.equal(h.me.container.children.length,5+Array.from(name).length,'no clone-of-clone growth');
  assert.equal(h.c.failures.length,0);
});
test('tagged remote names share, disabling restores native tint and removes overlays',()=>{
  const h=setup(names);h.other.name.text='Friend~tag';h.other.name.tint=0x55aa77;h.c.root=h.world;
  h.run('sweep(root)');assert.equal(h.other.name.tint,0x765432);
  h.c.settings.masterEnabled=false;h.run('sweep(root)');
  assert.equal(h.other.name.tint,0x55aa77);assert.equal(h.me.name.renderable,true);assert.equal(h.c.overlays.size,0);
});
test('recycled/renamed nodes and respawn cannot inherit self identity',()=>{
  const h=setup(names);h.c.root=h.world;h.run('sweep(root)');
  h.other.HUD.addChild(h.me.name);h.game.player=h.other;h.run('sweep(root)');
  assert.equal(h.c.overlays.has(h.me.name),false);assert.equal(h.me.name.renderable,true);
  assert.ok(h.c.overlays.has(h.other.name));
  h.game.player=null;h.run('sweep(root)');assert.equal(h.c.overlays.size,0);
});
test('recycled name styling is revoked before the next discovery pass',()=>{
  const h=setup(names);h.c.root=h.world;h.run('sweep(root)');
  h.me.name.text='Another person';h.run('nameReconcile()');
  assert.equal(h.c.overlays.size,0);assert.equal(h.me.name.renderable,true);
});
test('partial gradient creation leaves no orphan letters',()=>{
  const h=setup(names);h.me.name.text='AB';let made=0;
  h.me.name.constructor=class extends Text {constructor(opts){super(opts);if(++made===2)throw Error('glyph failure');}};
  h.c.root=h.world;h.run('sweep(root)');
  assert.equal(h.me.container.children.length,5);assert.equal(h.me.name.renderable,true);
  assert.equal(h.me.name.tint,0x123456,'falls back to solid tint');
});
test('broken HP discovery cannot suppress names or arena discovery',()=>{
  const h=setup(names);let arenas=0;h.c.hpScan.active=true;h.c.arenaScan.active=true;
  h.c.hpConsiderNode=()=>{throw Error('bad HP node');};h.c.arenaConsiderNode=()=>arenas++;
  h.c.root=h.world;h.run('sweep(root)');assert.ok(arenas>0);assert.ok(h.c.overlays.has(h.me.name));
});
test('DOM colour roots are only leaderboard name cells, including the main row',()=>{
  const h=setup(['domSweepRoots','domSweep','styleFor','sharedStyleFor']);
  const cells=[];const el={style:{},tagName:'SPAN',nodeValue:'67',isConnected:true,textContent:'67',
    closest:s=>s.includes('.main')?{}:null,matches:()=>true};cells.push(el);
  h.c.document={body:{},querySelectorAll:s=>{assert.equal(s,'#leaderboard .leaderboardEntry > .leaderboardName');return cells;},
    createTreeWalker:()=>{let read=false;return{nextNode:()=>read?null:(read=true,{nodeValue:'67',parentElement:el})};}};
  h.c.PAGE={NodeFilter:{SHOW_TEXT:4}};h.c.QOLC_OWN_UI='.own';h.c.domTouched=new Map();h.c.domSweepScanned=0;
  h.c.nameColorState.dom=true;let painted;h.c.applyDomStyle=(e,style)=>painted=style;h.c.restoreDomColor=()=>painted=null;
  h.run('domSweep()');assert.equal(painted.self,true);
  el.matches=()=>false;cells.length=0;h.run('domSweep()');assert.equal(painted,null);
});
test('authoritative arena renders without HP or discovery, with arbitrarily many children',()=>{
  const h=setup(arenas);const a=arena(h.world,h.low,150);h.me.arena=a;
  const mine=h.run('arenaSkyPick({w:1000,h:1000},1000)');assert.equal(mine.node,a.container);
  assert.equal(mine.base,a.base);assert.equal(h.c.arenaScan.found.length,0);
  h.c.node=a.container;h.run('arenaConsiderNode(node)');assert.ok(h.c.arenaScan.found.includes(a.container));
});
test('arena rebuild never substitutes a nearby arena and recovers when geometry returns',()=>{
  const h=setup(arenas);const a=arena(h.world,h.low),near=arena(h.world,h.low);h.me.arena=a;
  h.c.arenaScan.found=[near.container];a.base.width=0;
  assert.equal(h.run('arenaSkyPick({w:1000,h:1000},1000)'),null);
  a.base.width=2000;assert.equal(h.run('arenaSkyPick({w:1000,h:1000},1001)').node,a.container);
  h.me.arena=null;assert.equal(h.run('arenaSkyPick({w:1000,h:1000},1002)'),null);
});
test('unknown player shape allows arena fallback; explicit no-player does not',()=>{
  const h=setup(arenas);const a=arena(h.world,h.low);h.c.arenaScan.found=[a.container];
  h.game.player={unrecognised:true};assert.equal(h.run('arenaSkyPick({w:1000,h:1000},1000)').node,a.container);
  h.game.player=null;assert.equal(h.run('arenaSkyPick({w:1000,h:1000},1001)'),null);
});
test('theme layer detach, destruction and replacement all rebuild a valid attachment',()=>{
  const h=setup(arenas);const a=arena(h.world,h.low);h.me.arena=a;
  h.c.mine=h.run('arenaSkyPick({w:1000,h:1000},1000)');
  let old=h.run('arenaSkyAttach(mine)');assert.equal(old.parentRenderLayer,h.low);
  h.low.detach(old);let next=h.run('arenaSkyAttach(mine)');assert.notEqual(old,next);assert.equal(next.parentRenderLayer,h.low);
  h.high.attach(a.base);old=next;next=h.run('arenaSkyAttach(mine)');assert.notEqual(old,next);assert.equal(next.parentRenderLayer,h.high);
  next.destroy();assert.notEqual(h.run('arenaSkyAttach(mine)'),next);
  h.run('arenaSkyDetach("off")');assert.equal(h.c.arenaSky.node,null);
  assert.equal(h.high.renderLayerChildren.filter(n=>n.__lumiArenaSky).length,0);
});
test('failed theme attachment cleans a partial render-list entry',()=>{
  const h=setup(arenas);const a=arena(h.world,h.low);h.me.arena=a;
  h.c.mine=h.run('arenaSkyPick({w:1000,h:1000},1000)');
  const native=h.low.attach;h.low.attach=function(n){native.call(this,n);throw Error('partial attach');};
  assert.equal(h.run('arenaSkyAttach(mine)'),null);
  assert.equal(h.low.renderLayerChildren.filter(n=>n.__lumiArenaSky).length,0);
});
test('above/below works across layers with no HP bars and never moves another player',()=>{
  const h=setup(layers);const originals=[...h.high.renderLayerChildren];
  h.run('zorderApply(1000,true)');const owned=h.c.zorder.layer;
  assert.equal(h.me.container.parentRenderLayer,owned);assert.ok(h.world.children.indexOf(owned)>h.world.children.indexOf(h.high));
  h.c.zorder.mode=-1;h.run('zorderApply(1001,false)');
  assert.ok(h.world.children.indexOf(owned)<h.world.children.indexOf(h.low));
  assert.deepEqual(h.high.renderLayerChildren,originals);
  h.c.zorder.mode=0;h.run('zorderApply(1002,false)');assert.equal(h.me.container.parentRenderLayer,h.low);assert.ok(owned.destroyed);
});
test('engine layer transitions reconcile immediately; off restores current native state',()=>{
  const h=setup(layers);h.run('zorderApply(1000,true)');
  h.me.nativeLayer=h.high;h.me.updateLayer();h.run('zorderApply(1001,false)');
  assert.equal(h.me.container.parentRenderLayer,h.c.zorder.layer);
  h.me.nativeLayer=h.low;h.run('zorderRestore()');assert.equal(h.me.container.parentRenderLayer,h.low);
});
test('respawn and death clean the old override without trusting a stale opponent HP lock',()=>{
  const h=setup(layers);h.run('zorderApply(1000,true)');const old=h.c.zorder.layer;
  h.game.player=h.other;h.run('zorderApply(1001,false)');assert.equal(h.me.container.parentRenderLayer,h.low);assert.ok(old.destroyed);
  assert.equal(h.other.container.parentRenderLayer,h.c.zorder.layer);
  h.game.player=null;h.run('zorderApply(1002,false)');assert.equal(h.other.container.parentRenderLayer,h.high);
});
test('failed layer move rolls back and missing detach refuses before mutating',()=>{
  const h=setup(layers);h.c.obj=h.me.container;h.c.to=h.high;
  const native=h.high.attach;h.high.attach=function(n){native.call(this,n);throw Error('partial attach');};
  assert.equal(h.run('zorderMove(obj,to)'),false);assert.equal(h.me.container.parentRenderLayer,h.low);
  assert.equal(h.high.renderLayerChildren.includes(h.me.container),false);
  h.low.detach=null;assert.equal(h.run('zorderMove(obj,to)'),false);assert.equal(h.me.container.parentRenderLayer,h.low);
});
test('unrankable and foreign scene roots never participate in depth comparison',()=>{
  const h=setup(layers);const elsewhere=new Container(),foreign=new Layer();elsewhere.addChild(foreign);foreign.attach(h.other.container);
  h.run('zorderApply(1000,true)');assert.equal(h.c.zorder.layers,1);assert.equal(h.c.zorder.layer.parent,h.world);
});
test('published metadata and fallback version agree and the complete source compiles',()=>{
  new vm.Script(source);
  const version=source.match(/\/\/ @version\s+(\S+)/)[1];
  assert.match(source,new RegExp("return '"+version.replaceAll('.','\\.')+"';"));
  assert.equal((fn('injectExtrasStyles').match(/`/g)||[]).length,2,'no stray backticks in embedded CSS');
});
