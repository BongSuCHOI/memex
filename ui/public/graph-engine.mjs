import {t,tn} from './i18n/index.mjs';
// factText()는 prefs.preferTranslatedFacts를 존중한다 — 노드 라벨·툴팁이 fact_kr를 무조건 먼저
// 쓰면 en 지식 지도에 한국어가 남는다(설계 §14.5).
import {factText} from './ui.mjs';
/** Native WebGL renderer. No CDN, external fonts, telemetry, or render loop at rest.
 * Layout encodes domain grouping only; physical distance is NOT semantic similarity.
 */
export const palette=['#72c7b0','#7aaad5','#bd9ee0','#e2b87c','#76b9c5','#db9ead','#a6c982','#b5bfd7','#d7bda6','#82bdab','#c3abd0','#91bfc9'];
const color=(hex,alpha=1)=>[parseInt(hex.slice(1,3),16)/255,parseInt(hex.slice(3,5),16)/255,parseInt(hex.slice(5,7),16)/255,alpha];
const edgeColors={SUPPORTS:'#71bda7',INFLUENCES:'#80aee0',SUPERSEDES:'#dcbb83',CONTRADICTS:'#d77e86'};
const vs=`attribute vec3 a_pos;attribute vec4 a_color;attribute float a_size;uniform vec4 u_view;uniform vec4 u_rotate;uniform float u_dpr;varying vec4 v_color;
void main(){float cy=cos(u_rotate.x),sy=sin(u_rotate.x),cx=cos(u_rotate.y),sx=sin(u_rotate.y);vec3 p=a_pos;float x=cy*p.x+sy*p.z;float z=-sy*p.x+cy*p.z;float y=cx*p.y-sx*z;z=sx*p.y+cx*z;float d=u_rotate.z>.5?3.5/(3.5+z):1.0;gl_Position=vec4(x*u_view.x*d/u_view.w+u_view.y,y*u_view.x*d+u_view.z,z/10.0,1.0);gl_PointSize=a_size*u_dpr*min(1.8,max(.6,u_view.x))*d;v_color=a_color;}`;
const fs=`precision mediump float;varying vec4 v_color;uniform float u_points;void main(){float a=v_color.a;if(u_points>.5){float d=distance(gl_PointCoord,vec2(.5));if(d>.5)discard;a*=1.0-smoothstep(.32,.5,d);}gl_FragColor=vec4(v_color.rgb,a);}`;
export class KnowledgeGraph{
  constructor(stage,data,options={}){
    this.stage=stage;this.data=data;this.options=options;this.canvas=stage.querySelector('canvas.graph-canvas');this.labels=stage.querySelector('canvas.labels');this.ctx=this.labels.getContext('2d');this.tooltip=stage.querySelector('.graph-tooltip');this.abort=new AbortController();this.selected=null;this.hovered=null;this.mode=options.mode||'2d';this.yaw=this.mode==='3d'?.35:0;this.pitch=this.mode==='3d'?.2:0;this.zoom=.86;this.panX=0;this.panY=0;this.raf=0;this.frames=0;this.destroyed=false;this.gl=null;stage.__knowledgeGraph=this;
    this.layout();this.initGL();this.events();this.resizeObserver=new ResizeObserver(()=>this.resize());this.resizeObserver.observe(stage);this.resize();
  }
  layout(){
    const categories=new Map(this.data.categories.map(c=>[c.id,c]));const domains=new Map(this.data.domains.map((d,i)=>[d.id,{...d,index:i}]));const groups=new Map();
    for(const f of this.data.nodes){const dom=categories.get(f.ontology_category_id)?.domain_id||'unclassified';if(!groups.has(dom))groups.set(dom,[]);groups.get(dom).push(f);}
    const degrees=new Map();for(const e of this.data.edges){degrees.set(e.source_fact_id,(degrees.get(e.source_fact_id)||0)+1);degrees.set(e.target_fact_id,(degrees.get(e.target_fact_id)||0)+1);}
    this.nodes=[];this.clusters=[];const total=Math.max(1,this.data.nodes.length);const groupCount=groups.size;let gi=0;
    for(const [key,items]of groups){
      const angle=gi*2*Math.PI/groupCount-Math.PI/2;const spread=Math.max(.19,Math.sqrt(items.length/total)*.65);const radius=groupCount===1?0:.72;
      const center=[Math.cos(angle)*radius,Math.sin(angle)*radius,Math.sin(gi*1.7)*.18];const hue=key==='unclassified'?'#7e929c':palette[(domains.get(key)?.index||0)%palette.length];
      this.clusters.push({name:domains.get(key)?.name||t('common.uncategorized'),center,color:hue,count:items.length});
      items.forEach((f,i)=>{const a=i*2.3999632297;const r=Math.sqrt((i+.5)/items.length)*spread;const pos=[center[0]+Math.cos(a)*r,center[1]+Math.sin(a)*r,center[2]+Math.sin(i*2.05)*spread*.65];this.nodes.push({...f,pos,hue,degree:degrees.get(f.id)||0,size:Math.min(12,5+Math.sqrt(degrees.get(f.id)||0))});});gi++;
    }
    this.byId=new Map(this.nodes.map(n=>[n.id,n]));this.neighbors=new Map();for(const e of this.data.edges){for(const [a,b]of [[e.source_fact_id,e.target_fact_id],[e.target_fact_id,e.source_fact_id]]){if(!this.neighbors.has(a))this.neighbors.set(a,new Set());this.neighbors.get(a).add(b);}}
  }
  initGL(){
    const gl=this.canvas.getContext('webgl',{antialias:true,alpha:false,preserveDrawingBuffer:true,powerPreference:'low-power'});
    if(!gl){this.renderer='Canvas 2D';this.fallback=this.canvas.getContext('2d');if(!this.fallback)throw new Error(t('error.graph.canvasUnavailable'));return;}this.renderer='WebGL';this.gl=gl;
    const compile=(type,source)=>{const shader=gl.createShader(type);gl.shaderSource(shader,source);gl.compileShader(shader);if(!gl.getShaderParameter(shader,gl.COMPILE_STATUS)){const msg=gl.getShaderInfoLog(shader);gl.deleteShader(shader);throw new Error(msg);}return shader;};
    const vert=compile(gl.VERTEX_SHADER,vs),frag=compile(gl.FRAGMENT_SHADER,fs);const program=gl.createProgram();gl.attachShader(program,vert);gl.attachShader(program,frag);gl.linkProgram(program);gl.deleteShader(vert);gl.deleteShader(frag);
    if(!gl.getProgramParameter(program,gl.LINK_STATUS))throw new Error(gl.getProgramInfoLog(program));this.program=program;gl.useProgram(program);
    this.attributes={pos:gl.getAttribLocation(program,'a_pos'),color:gl.getAttribLocation(program,'a_color'),size:gl.getAttribLocation(program,'a_size')};this.uniforms=Object.fromEntries(['u_view','u_rotate','u_dpr','u_points'].map(n=>[n,gl.getUniformLocation(program,n)]));
    this.pointBuffer=gl.createBuffer();this.edgeBuffer=gl.createBuffer();gl.enable(gl.BLEND);gl.blendFunc(gl.SRC_ALPHA,gl.ONE_MINUS_SRC_ALPHA);gl.disable(gl.DEPTH_TEST);this.upload();
  }
  upload(){if(!this.gl){this.schedule();return;}if(this.gl.isContextLost())return;const gl=this.gl;const points=[],lines=[];const selected=this.selected,near=this.neighbors.get(selected)||new Set();
    for(const n of this.nodes){const alpha=!selected||selected===n.id||near.has(n.id)?1:.19;points.push(...n.pos,...color(n.hue,alpha),n.size+(n.id===selected?7:0));}
    for(const e of this.data.edges){const a=this.byId.get(e.source_fact_id),b=this.byId.get(e.target_fact_id);if(!a||!b)continue;const isNear=selected&&(a.id===selected||b.id===selected);const alpha=selected?(isNear?.75:.035):.13;const c=color(edgeColors[e.relation_type]||'#7f99a7',alpha);lines.push(...a.pos,...c,1,...b.pos,...c,1);}
    this.pointCount=points.length/8;this.lineCount=lines.length/8;gl.bindBuffer(gl.ARRAY_BUFFER,this.pointBuffer);gl.bufferData(gl.ARRAY_BUFFER,new Float32Array(points),gl.STATIC_DRAW);gl.bindBuffer(gl.ARRAY_BUFFER,this.edgeBuffer);gl.bufferData(gl.ARRAY_BUFFER,new Float32Array(lines),gl.STATIC_DRAW);this.schedule();
  }
  bind(buffer){const gl=this.gl;gl.bindBuffer(gl.ARRAY_BUFFER,buffer);for(const [key,size,offset]of [['pos',3,0],['color',4,12],['size',1,28]]){const loc=this.attributes[key];gl.enableVertexAttribArray(loc);gl.vertexAttribPointer(loc,size,gl.FLOAT,false,32,offset);}}
  // Assigning canvas.width/height always reallocates the drawing buffer, even
  // when the value is unchanged, leaving it transparent black until the next
  // frame. ResizeObserver fires an initial callback for every observe(), so an
  // unguarded assignment blanked an already-drawn map. Only resize on a real
  // size change, and keep drawing while no frame has been produced yet.
  resize(){if(this.destroyed)return;const r=this.stage.getBoundingClientRect();this.width=Math.max(1,r.width);this.height=Math.max(1,r.height);this.dpr=Math.min(window.devicePixelRatio||1,2);const w=Math.round(this.width*this.dpr),h=Math.round(this.height*this.dpr);let resized=false;for(const c of [this.canvas,this.labels]){if(c.width===w&&c.height===h)continue;c.width=w;c.height=h;resized=true;}if(resized||!this.frames)this.schedule();}
  project(pos){const[x,y,z]=pos,cy=Math.cos(this.yaw),sy=Math.sin(this.yaw),cx=Math.cos(this.pitch),sx=Math.sin(this.pitch);const xx=cy*x+sy*z,zz=-sy*x+cy*z;const yy=cx*y-sx*zz,depth=sx*y+cx*zz;const p=this.mode==='3d'?3.5/(3.5+depth):1;return[(xx*this.zoom*p/(this.width/this.height)+this.panX+1)*this.width/2,(1-(yy*this.zoom*p+this.panY))*this.height/2,depth];}
  schedule(){if(this.destroyed||this.raf)return;this.raf=requestAnimationFrame(()=>{this.raf=0;this.draw();});}
  // Draw synchronously, consuming any frame already queued. A WebGL drawing
  // buffer that has never been cleared reads back as transparent black, which
  // is indistinguishable by colour from a painted map, so anything reading the
  // canvas must be able to force a real frame first instead of racing rAF.
  renderNow(){if(this.destroyed)return this.frames;if(this.raf){cancelAnimationFrame(this.raf);this.raf=0;}this.draw();return this.frames;}
  draw(){if(this.destroyed)return;if(this.fallback){this.drawFallback();this.drawLabels();this.frames++;return;}const gl=this.gl;if(!gl||gl.isContextLost())return;gl.viewport(0,0,this.canvas.width,this.canvas.height);gl.clearColor(.063,.114,.145,1);gl.clear(gl.COLOR_BUFFER_BIT);gl.useProgram(this.program);gl.uniform4f(this.uniforms.u_view,this.zoom,this.panX,this.panY,this.width/this.height);gl.uniform4f(this.uniforms.u_rotate,this.yaw,this.pitch,this.mode==='3d'?1:0,0);gl.uniform1f(this.uniforms.u_dpr,this.dpr);gl.uniform1f(this.uniforms.u_points,0);this.bind(this.edgeBuffer);gl.drawArrays(gl.LINES,0,this.lineCount);gl.uniform1f(this.uniforms.u_points,1);this.bind(this.pointBuffer);gl.drawArrays(gl.POINTS,0,this.pointCount);this.drawLabels();this.frames++;}
  drawFallback(){
    const c=this.fallback;c.setTransform(this.dpr,0,0,this.dpr,0,0);c.fillStyle='#101d25';c.fillRect(0,0,this.width,this.height);
    const selected=this.selected,near=this.neighbors.get(selected)||new Set(),positions=new Map(this.nodes.map(n=>[n.id,this.project(n.pos)]));
    for(const e of this.data.edges){const a=positions.get(e.source_fact_id),b=positions.get(e.target_fact_id);if(!a||!b)continue;const related=selected&&(e.source_fact_id===selected||e.target_fact_id===selected);c.globalAlpha=selected?(related?.7:.025):.17;c.strokeStyle=edgeColors[e.relation_type]||'#7893a0';c.lineWidth=related?1.3:.8;c.beginPath();c.moveTo(a[0],a[1]);c.lineTo(b[0],b[1]);c.stroke();}
    for(const n of this.nodes){const p=positions.get(n.id);const active=!selected||n.id===selected||near.has(n.id);c.globalAlpha=active?1:.2;c.fillStyle=n.hue;const size=(n.size+(n.id===selected?5:0))*Math.min(1.8,Math.max(.6,this.zoom))*.52;c.beginPath();c.arc(p[0],p[1],Math.max(1,size),0,Math.PI*2);c.fill();if(active&&n.degree>2){c.globalAlpha=.08;c.beginPath();c.arc(p[0],p[1],size*2.7,0,Math.PI*2);c.fill();}}
    c.globalAlpha=1;
  }
  drawLabels(){const c=this.ctx;c.setTransform(this.dpr,0,0,this.dpr,0,0);c.clearRect(0,0,this.width,this.height);c.textAlign='center';c.textBaseline='middle';
    for(const cl of this.clusters){const[x,y]=this.project(cl.center);c.fillStyle='#8eabb6';c.font='10px system-ui';c.fillText(cl.name.slice(0,30),x,y-36*this.zoom);c.fillStyle='#557783';c.font='9px system-ui';c.fillText(tn('unit.memories',cl.count,{count:cl.count}),x,y-22*this.zoom);}
    const selected=this.selected||this.hovered;if(!selected)return;
    for(const e of this.data.edges){if(e.source_fact_id!==selected&&e.target_fact_id!==selected)continue;const a=this.byId.get(e.source_fact_id),b=this.byId.get(e.target_fact_id);if(!a||!b)continue;const p=this.project(a.pos),q=this.project(b.pos),dx=q[0]-p[0],dy=q[1]-p[1],d=Math.hypot(dx,dy);if(d<15)continue;const ux=dx/d,uy=dy/d;const x=q[0]-ux*10,y=q[1]-uy*10;c.strokeStyle=edgeColors[e.relation_type];c.lineWidth=1;c.beginPath();c.moveTo(x-ux*5-uy*3,y-uy*5+ux*3);c.lineTo(x,y);c.lineTo(x-ux*5+uy*3,y-uy*5-ux*3);c.stroke();}
    const n=this.byId.get(selected);if(n){const[x,y]=this.project(n.pos);c.strokeStyle=n.hue;c.lineWidth=1;c.beginPath();c.arc(x,y,11,0,Math.PI*2);c.stroke();c.fillStyle='#d2e6e8';c.font='11px system-ui';c.fillText(factText(n).slice(0,45),x,Math.max(70,y-25));}
  }
  pick(x,y){let best=null,dist=13;for(const n of this.nodes){const p=this.project(n.pos);const d=Math.hypot(p[0]-x,p[1]-y);if(d<dist){best=n;dist=d;}}return best;}
  select(id){this.selected=id;this.upload();}
  reset(){this.panX=this.panY=0;this.zoom=.86;this.yaw=this.mode==='3d'?.35:0;this.pitch=this.mode==='3d'?.2:0;this.selected=null;this.upload();}
  setMode(mode){this.mode=mode;this.yaw=mode==='3d'?.35:0;this.pitch=mode==='3d'?.2:0;this.schedule();}
  events(){const signal=this.abort.signal;let down=null;
    this.canvas.addEventListener('pointerdown',e=>{down={x:e.clientX,y:e.clientY,lastX:e.clientX,lastY:e.clientY,moved:false};this.canvas.setPointerCapture(e.pointerId);},{signal});
    this.canvas.addEventListener('pointermove',e=>{const r=this.canvas.getBoundingClientRect();if(down){const dx=e.clientX-down.lastX,dy=e.clientY-down.lastY;if(Math.hypot(e.clientX-down.x,e.clientY-down.y)>4)down.moved=true;if(this.mode==='3d'&&!e.shiftKey){this.yaw+=dx*.007;this.pitch=Math.max(-1.4,Math.min(1.4,this.pitch+dy*.007));}else{this.panX+=dx*2/this.width;this.panY-=dy*2/this.height;}down.lastX=e.clientX;down.lastY=e.clientY;this.tooltip.hidden=true;this.schedule();return;}const n=this.pick(e.clientX-r.left,e.clientY-r.top);if(this.hovered!==n?.id){this.hovered=n?.id||null;this.schedule();}this.canvas.style.cursor=n?'pointer':this.mode==='3d'?'grab':'move';this.tooltip.hidden=!n;if(n){this.tooltip.textContent=factText(n);this.tooltip.style.left=Math.max(8,Math.min(this.width-290,e.clientX-r.left+16))+'px';this.tooltip.style.top=Math.max(60,Math.min(this.height-100,e.clientY-r.top+15))+'px';}},{signal});
    this.canvas.addEventListener('pointerup',e=>{if(!down)return;const moved=down.moved;down=null;if(!moved){const r=this.canvas.getBoundingClientRect();const n=this.pick(e.clientX-r.left,e.clientY-r.top);if(n){this.select(n.id);this.options.onSelect?.(n.id);}else{this.select(null);}}},{signal});
    this.canvas.addEventListener('pointercancel',()=>down=null,{signal});this.canvas.addEventListener('pointerleave',()=>{this.tooltip.hidden=true;this.hovered=null;this.schedule();},{signal});
    this.canvas.addEventListener('wheel',e=>{e.preventDefault();const previous=this.zoom;this.zoom=Math.min(8,Math.max(.15,this.zoom*Math.exp(-e.deltaY*.001)));if(this.mode==='2d'){const r=this.canvas.getBoundingClientRect();const x=(e.clientX-r.left)/this.width*2-1,y=1-(e.clientY-r.top)/this.height*2;const k=this.zoom/previous;this.panX=x-(x-this.panX)*k;this.panY=y-(y-this.panY)*k;}this.schedule();},{signal,passive:false});
    this.canvas.addEventListener('keydown',e=>{const steps={ArrowLeft:[.1,0],ArrowRight:[-.1,0],ArrowUp:[0,-.1],ArrowDown:[0,.1]};if(steps[e.key]){e.preventDefault();if(this.mode==='3d'){this.yaw+=steps[e.key][0];this.pitch=Math.max(-1.4,Math.min(1.4,this.pitch+steps[e.key][1]));}else{this.panX+=steps[e.key][0];this.panY+=steps[e.key][1];}}else if(['+','=','-'].includes(e.key)){e.preventDefault();this.zoom=Math.min(8,Math.max(.15,this.zoom*(e.key==='-'?.9:1.1)));}else if(e.key==='0'){this.reset();}else if(e.key==='Enter'&&this.selected)this.options.onSelect?.(this.selected);this.schedule();},{signal});
    this.canvas.addEventListener('webglcontextlost',e=>{e.preventDefault();this.options.onError?.(t('error.graph.contextLost'));},{signal});
    this.canvas.addEventListener('webglcontextrestored',()=>{this.initGL();this.schedule();},{signal});
  }
  exportPNG(){this.draw();const output=document.createElement('canvas');output.width=this.canvas.width;output.height=this.canvas.height;const c=output.getContext('2d');c.drawImage(this.canvas,0,0);c.drawImage(this.labels,0,0);const a=document.createElement('a');a.href=output.toDataURL('image/png');a.download='memex-knowledge-map.png';a.click();}
  destroy(){this.destroyed=true;this.abort.abort();this.resizeObserver.disconnect();cancelAnimationFrame(this.raf);if(this.gl){this.gl.deleteBuffer(this.pointBuffer);this.gl.deleteBuffer(this.edgeBuffer);this.gl.deleteProgram(this.program);}}
}
