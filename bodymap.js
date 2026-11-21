/* MBL HSE Dashboard — Interactive 3D Body Map
 * ------------------------------------------------------------------
 * Used by:  OUR CLINIC page      -> mblBodyMapMountClinic()
 *           INCIDENT TRACKER page -> mblBodyMapMountIncidents(subKey)
 *
 * Every report that names a body part / complaint gets a pointer pin on a
 * rotatable 3D human body. Click a report in the list and the body turns to
 * that spot and the pin pulses; click a pin (or any body area) and the
 * matching reports are selected / filtered.
 *
 * Three.js is loaded lazily from /vendor (same-origin, cached by sw.js).
 * Nothing is stored or published by this module - it only reads the rows
 * already held in APP_DATA.
 */
(function(){
'use strict';

/* ------------------------------------------------------------------ */
/* Lazy loader                                                         */
/* ------------------------------------------------------------------ */
var threePromise = null;
function loadScript(src){
  return new Promise(function(res, rej){
    var s = document.createElement('script');
    s.src = src; s.async = false;
    s.onload = res; s.onerror = function(){ rej(new Error('Failed to load '+src)); };
    document.head.appendChild(s);
  });
}
function loadThree(){
  if(window.THREE && window.THREE.OrbitControls) return Promise.resolve(window.THREE);
  if(threePromise) return threePromise;
  threePromise = loadScript('vendor/three.min.js')
    .then(function(){ return loadScript('vendor/OrbitControls.js'); })
    .then(function(){ return window.THREE; })
    .catch(function(e){ threePromise = null; throw e; });
  return threePromise;
}

/* ------------------------------------------------------------------ */
/* Body model assets (realistic mesh)                                  */
/* models/human-config.json lists candidates in priority order:        */
/*   1. models/human-realistic.glb  (drop-in scanned / MakeHuman body)  */
/*   2. models/human-body.json      (baked mesh shipped with the app)   */
/* If none can be read the built-in simple body is drawn instead.       */
/* Only raw typed arrays are cached here; every widget builds its own   */
/* THREE geometry so disposing one widget never breaks the other.       */
/* ------------------------------------------------------------------ */
var CONFIG_URL = 'models/human-config.json';
var DEFAULT_MATERIAL = {color:'#7d98ad', roughness:0.55, metalness:0.08, emissive:'#0b1c28', emissiveIntensity:0.45};
var assetPromise = null;

function b64ToBuf(b64){
  var bin = atob(b64), n = bin.length, u = new Uint8Array(n);
  for(var i = 0; i < n; i++) u[i] = bin.charCodeAt(i);
  return u.buffer;
}
function fetchJSON(url){
  return fetch(url, {cache:'no-cache'}).then(function(r){
    if(!r.ok) throw new Error(url + ' → HTTP ' + r.status);
    return r.json();
  });
}
function fetchBuf(url){
  return fetch(url).then(function(r){
    if(!r.ok) throw new Error(url + ' → HTTP ' + r.status);
    return r.arrayBuffer();
  });
}

/* models/human-body.json  ->  [{positions:Float32Array, indices:Uint16Array}] */
function decodeMblJSON(j){
  if(!j || j.format !== 'mbl-body-mesh' || !j.positions || !j.indices) throw new Error('not an mbl-body-mesh file');
  var q = new Int16Array(b64ToBuf(j.positions.data)), o = j.positions.origin, sc = j.positions.scale;
  var pos = new Float32Array(q.length);
  for(var i = 0; i < q.length; i += 3){
    pos[i]     = o[0] + (q[i]     + 32767) * sc[0];
    pos[i + 1] = o[1] + (q[i + 1] + 32767) * sc[1];
    pos[i + 2] = o[2] + (q[i + 2] + 32767) * sc[2];
  }
  var idx = new Uint16Array(b64ToBuf(j.indices.data));
  return {meshes:[{positions:pos, normals:null, indices:idx, name:'body'}], prescaled:true};
}

/* Minimal static GLB reader: triangle meshes, node transforms, bind pose.
   (Skinning / animation / textures are ignored - the body map only needs
   the shape; colour comes from the dashboard skin material.)          */
function parseGLB(buf){
  var dv = new DataView(buf);
  if(dv.getUint32(0, true) !== 0x46546C67) throw new Error('not a GLB file');
  var off = 12, json = null, bin = null;
  while(off + 8 <= buf.byteLength){
    var len = dv.getUint32(off, true), type = dv.getUint32(off + 4, true);
    var start = off + 8;
    if(type === 0x4E4F534A) json = JSON.parse(new TextDecoder('utf-8').decode(new Uint8Array(buf, start, len)));
    else if(type === 0x004E4942 && !bin) bin = buf.slice(start, start + len);
    off = start + ((len + 3) & ~3);
  }
  if(!json || !bin) throw new Error('GLB has no JSON/BIN chunk');
  (json.extensionsRequired || []).forEach(function(x){
    if(x === 'KHR_draco_mesh_compression' || x === 'EXT_meshopt_compression' || x === 'KHR_mesh_quantization')
      throw new Error('GLB uses ' + x + ' (not supported) - export it uncompressed');
  });
  var COMP = {5120:[Int8Array,1], 5121:[Uint8Array,1], 5122:[Int16Array,2], 5123:[Uint16Array,2], 5125:[Uint32Array,4], 5126:[Float32Array,4]};
  var NCOMP = {SCALAR:1, VEC2:2, VEC3:3, VEC4:4};
  function readAccessor(ai){
    var a = json.accessors[ai], bv = json.bufferViews[a.bufferView], C = COMP[a.componentType], n = NCOMP[a.type];
    if(a.sparse) throw new Error('sparse accessors not supported');
    var base = (bv.byteOffset || 0) + (a.byteOffset || 0), stride = bv.byteStride || (C[1] * n);
    var out = new C[0](a.count * n);
    if(stride === C[1] * n && base % C[1] === 0){
      out.set(new C[0](bin, base, a.count * n));
    } else {
      var src = new DataView(bin);
      for(var i = 0; i < a.count; i++) for(var k = 0; k < n; k++){
        var p = base + i * stride + k * C[1];
        out[i * n + k] = C[0] === Float32Array ? src.getFloat32(p, true) : C[0] === Uint16Array ? src.getUint16(p, true) :
                         C[0] === Uint32Array ? src.getUint32(p, true) : C[0] === Int16Array ? src.getInt16(p, true) :
                         C[0] === Int8Array ? src.getInt8(p) : src.getUint8(p);
      }
    }
    return out;
  }
  function mulM(a, b){   // column-major 4x4
    var o = new Float64Array(16);
    for(var c = 0; c < 4; c++) for(var r = 0; r < 4; r++){
      var v = 0; for(var k = 0; k < 4; k++) v += a[k * 4 + r] * b[c * 4 + k]; o[c * 4 + r] = v;
    }
    return o;
  }
  function nodeM(n){
    if(n.matrix) return Float64Array.from(n.matrix);
    var t = n.translation || [0, 0, 0], q = n.rotation || [0, 0, 0, 1], s = n.scale || [1, 1, 1];
    var x = q[0], y = q[1], z = q[2], w = q[3];
    return Float64Array.from([
      (1 - 2 * (y * y + z * z)) * s[0], (2 * (x * y + z * w)) * s[0], (2 * (x * z - y * w)) * s[0], 0,
      (2 * (x * y - z * w)) * s[1], (1 - 2 * (x * x + z * z)) * s[1], (2 * (y * z + x * w)) * s[1], 0,
      (2 * (x * z + y * w)) * s[2], (2 * (y * z - x * w)) * s[2], (1 - 2 * (x * x + y * y)) * s[2], 0,
      t[0], t[1], t[2], 1]);
  }
  var meshes = [], I = new Float64Array([1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1]);
  function walk(ni, parent){
    var n = json.nodes[ni];
    var M = (n.skin !== undefined) ? parent : mulM(parent, nodeM(n));   // skinned meshes ignore their node transform
    if(n.mesh !== undefined){
      json.meshes[n.mesh].primitives.forEach(function(pr){
        if(pr.mode !== undefined && pr.mode !== 4) return;
        if(pr.attributes.POSITION === undefined) return;
        var P = readAccessor(pr.attributes.POSITION), N = pr.attributes.NORMAL !== undefined ? readAccessor(pr.attributes.NORMAL) : null;
        var cnt = P.length / 3, ind;
        if(pr.indices !== undefined) ind = readAccessor(pr.indices);
        else { ind = new Uint32Array(cnt); for(var i = 0; i < cnt; i++) ind[i] = i; }
        var pos = new Float32Array(P.length), nrm = N ? new Float32Array(N.length) : null;
        for(var i = 0; i < cnt; i++){
          var x = P[i*3], y = P[i*3+1], z = P[i*3+2];
          pos[i*3]   = M[0]*x + M[4]*y + M[8]*z  + M[12];
          pos[i*3+1] = M[1]*x + M[5]*y + M[9]*z  + M[13];
          pos[i*3+2] = M[2]*x + M[6]*y + M[10]*z + M[14];
          if(nrm){
            var nx = N[i*3], ny = N[i*3+1], nz = N[i*3+2];
            var ax = M[0]*nx + M[4]*ny + M[8]*nz, ay = M[1]*nx + M[5]*ny + M[9]*nz, az = M[2]*nx + M[6]*ny + M[10]*nz;
            var l = Math.sqrt(ax*ax + ay*ay + az*az) || 1;
            nrm[i*3] = ax / l; nrm[i*3+1] = ay / l; nrm[i*3+2] = az / l;
          }
        }
        meshes.push({positions:pos, normals:nrm, indices:ind, name:(n.name || '') + '|' + (json.meshes[n.mesh].name || '')});
      });
    }
    (n.children || []).forEach(function(c){ walk(c, M); });
  }
  var sc = json.scenes[json.scene || 0];
  sc.nodes.forEach(function(ni){ walk(ni, I); });
  if(!meshes.length) throw new Error('GLB contains no triangle meshes');
  return {meshes:meshes, prescaled:false};
}

/* scale to targetHeight, stand on y = 0, centre on x/z, optional Y rotation */
function normalizeAsset(asset, targetH, rotateYdeg){
  var r = (rotateYdeg || 0) * Math.PI / 180, c = Math.cos(r), s = Math.sin(r);
  var mn = [1e9, 1e9, 1e9], mx = [-1e9, -1e9, -1e9];
  asset.meshes.forEach(function(m){
    var p = m.positions, nn = m.normals;
    if(r){
      for(var i = 0; i < p.length; i += 3){
        var x = p[i], z = p[i + 2]; p[i] = c * x + s * z; p[i + 2] = -s * x + c * z;
        if(nn){ var a = nn[i], b = nn[i + 2]; nn[i] = c * a + s * b; nn[i + 2] = -s * a + c * b; }
      }
    }
    for(var j = 0; j < p.length; j += 3) for(var k = 0; k < 3; k++){
      if(p[j + k] < mn[k]) mn[k] = p[j + k];
      if(p[j + k] > mx[k]) mx[k] = p[j + k];
    }
  });
  if(asset.prescaled) return {height: mx[1] - mn[1]};
  var h = mx[1] - mn[1]; if(!(h > 0)) throw new Error('model has no height');
  // centre on the pelvis / thighs (45-80 % of height) so protruding feet or hands cannot shift the body
  var sx = 0, sz = 0, cnt = 0, y1 = mn[1] + h * 0.45, y2 = mn[1] + h * 0.80;
  asset.meshes.forEach(function(m){
    var p = m.positions;
    for(var i = 0; i < p.length; i += 3) if(p[i + 1] >= y1 && p[i + 1] <= y2){ sx += p[i]; sz += p[i + 2]; cnt++; }
  });
  var k = targetH / h, cx = cnt ? sx / cnt : (mn[0] + mx[0]) / 2, cz = cnt ? sz / cnt : (mn[2] + mx[2]) / 2;
  asset.meshes.forEach(function(m){
    var p = m.positions;
    for(var i = 0; i < p.length; i += 3){ p[i] = (p[i] - cx) * k; p[i + 1] = (p[i + 1] - mn[1]) * k; p[i + 2] = (p[i + 2] - cz) * k; }
  });
  return {height: targetH};
}

function loadBodyAsset(){
  if(assetPromise) return assetPromise;
  assetPromise = fetchJSON(CONFIG_URL).then(function(cfg){
    var targetH = cfg.targetHeight || 1.82;
    var list = (cfg.candidates || []).slice();
    function next(i){
      if(i >= list.length) return null;
      var cand = list[i];
      var p = cand.type === 'glb' ? fetchBuf(cand.url).then(parseGLB)
            : cand.type === 'mbl-json' ? fetchJSON(cand.url).then(decodeMblJSON)
            : Promise.reject(new Error('unknown model type ' + cand.type));
      return p.then(function(asset){
        if(cand.excludeMeshNames && cand.excludeMeshNames.length){
          var re = new RegExp(cand.excludeMeshNames.join('|'), 'i');
          asset.meshes = asset.meshes.filter(function(m){ return !re.test(m.name); });
        }
        normalizeAsset(asset, targetH, cand.rotateY);
        // region anchors: shared config first, then the candidate's own overrides
        var regs = {};
        [cfg.regions || {}, cand.regions || {}].forEach(function(src){
          Object.keys(src).forEach(function(k){ regs[k] = Object.assign(regs[k] || {}, src[k]); });
        });
        asset.regions = regs;
        asset.material = Object.assign({}, DEFAULT_MATERIAL, cfg.material || {});
        asset.source = cand.url;
        return asset;
      }).catch(function(err){
        if(window.console && cand.type !== 'glb') console.warn('[bodymap] model "' + cand.url + '" failed:', err && err.message || err);
        return next(i + 1);
      });
    }
    return next(0);
  }).catch(function(err){
    if(window.console) console.warn('[bodymap] no model config, using built-in body:', err && err.message || err);
    return null;
  }).then(function(asset){
    if(asset) applyRegionOverrides(asset.regions);
    return asset;
  });
  return assetPromise;
}
function applyRegionOverrides(regs){
  Object.keys(regs || {}).forEach(function(k){
    var R = REGIONS[k], o = regs[k]; if(!R || !o) return;
    ['pos', 'dir'].forEach(function(f){ if(Array.isArray(o[f]) && o[f].length === 3) R[f] = o[f].slice(); });
    if(typeof o.zoom === 'number') R.zoom = o.zoom;
    if(typeof o.off === 'number') R.off = o.off;
  });
}

/* ------------------------------------------------------------------ */
/* Body regions (model: 1.82 m tall, faces +Z, anatomical LEFT = +X)   */
/* kind: sym = always left/right, opt = centre unless a side is given, */
/*       ctr = centre only                                             */
/* ------------------------------------------------------------------ */
var REGIONS = {
  head:       {label:'Head',            kind:'ctr', pos:[0,1.765,0.0],     dir:[0,0.18,1],      zoom:1.3},
  eye:        {label:'Eye',             kind:'sym', pos:[0.034,1.718,0.05], dir:[0,0,1],         zoom:1.2},
  ear:        {label:'Ear',             kind:'sym', pos:[0.087,1.695,0],    dir:[1,0,0],         zoom:1.2},
  nose:       {label:'Nose',            kind:'ctr', pos:[0,1.678,0.05],     dir:[0,0,1],         zoom:1.2},
  mouth:      {label:'Mouth / Teeth / Jaw', kind:'ctr', pos:[0,1.635,0.05], dir:[0,-0.1,1],      zoom:1.2},
  face:       {label:'Face',            kind:'sym', pos:[0.055,1.66,0.05],  dir:[0.3,0,1],       zoom:1.2},
  neck:       {label:'Neck',            kind:'ctr', pos:[0,1.545,0],        dir:[0,0,1],         zoom:1.3},
  throat:     {label:'Throat',          kind:'ctr', pos:[0,1.555,0],        dir:[0,0,1],         zoom:1.3},
  shoulder:   {label:'Shoulder',        kind:'sym', pos:[0.205,1.46,0],     dir:[0.35,1,0.1],    zoom:1.3},
  upper_arm:  {label:'Upper Arm',       kind:'sym', pos:[0.25,1.30,0],      dir:[0.35,0,0.94],   zoom:1.3},
  elbow:      {label:'Elbow',           kind:'sym', pos:[0.30,1.15,0],      dir:[0.6,0,0.8],     zoom:1.3},
  forearm:    {label:'Forearm',         kind:'sym', pos:[0.335,1.015,0],    dir:[0.35,0,0.94],   zoom:1.2},
  wrist:      {label:'Wrist',           kind:'sym', pos:[0.37,0.88,0],      dir:[0.2,0,1],       zoom:1.3},
  hand:       {label:'Hand',            kind:'sym', pos:[0.39,0.80,0],      dir:[0.1,0,1],       zoom:1.3},
  finger:     {label:'Finger / Thumb',  kind:'sym', pos:[0.405,0.71,0],     dir:[0.1,0,1],       zoom:1.2},
  chest:      {label:'Chest',           kind:'opt', pos:[0,1.33,0],         dir:[0,0,1],         zoom:1.7, off:0.075},
  upper_back: {label:'Upper Back',      kind:'opt', pos:[0,1.33,0],         dir:[0,0,-1],        zoom:1.7, off:0.075},
  lower_back: {label:'Lower Back',      kind:'opt', pos:[0,1.06,0],         dir:[0,0,-1],        zoom:1.7, off:0.07},
  abdomen:    {label:'Abdomen / Stomach', kind:'opt', pos:[0,1.08,0],       dir:[0,0,1],         zoom:1.7, off:0.07},
  pelvis:     {label:'Groin / Pelvis',  kind:'ctr', pos:[0,0.93,0],         dir:[0,-0.25,1],     zoom:1.7},
  buttock:    {label:'Buttock',         kind:'opt', pos:[0,0.93,0],         dir:[0,0,-1],        zoom:1.7, off:0.08},
  hip:        {label:'Hip',             kind:'sym', pos:[0.17,0.96,0],      dir:[1,0,0.3],       zoom:1.6},
  thigh:      {label:'Thigh',           kind:'sym', pos:[0.095,0.735,0],    dir:[0.2,0,1],       zoom:1.6},
  knee:       {label:'Knee',            kind:'sym', pos:[0.10,0.52,0],      dir:[0,0,1],         zoom:1.2},
  shin:       {label:'Lower Leg / Shin',kind:'sym', pos:[0.098,0.32,0],     dir:[0,0,1],         zoom:1.4},
  calf:       {label:'Calf',            kind:'sym', pos:[0.098,0.36,0],     dir:[0,0,-1],        zoom:1.4},
  ankle:      {label:'Ankle',           kind:'sym', pos:[0.095,0.09,0],     dir:[0.5,0,0.8],     zoom:1.3},
  foot:       {label:'Foot / Heel',     kind:'sym', pos:[0.095,0.05,0.07],  dir:[0,1,0.5],       zoom:1.3},
  toe:        {label:'Toe',             kind:'sym', pos:[0.095,0.035,0.17], dir:[0,1,0.4],       zoom:1.2},
  general:    {label:'General / Whole body', kind:'ctr', pos:[0,1.2,0],     dir:[0,0,1],         zoom:3.2}
};

/* Keyword rules. Order matters: a matched phrase is blanked out so later,
   broader rules (e.g. "back", "arm") cannot match it again.             */
var RULES = [
  ['eye',       /\b(eyes?|ocular|cornea\w*|conjunctiv\w*|vision|retina\w*|eyelids?|arc\s*eye|welding\s*flash)\b/],
  ['ear',       /\b(ears?|hearing|tinnitus|earache|eardrum)\b/],
  ['nose',      /\b(nose|nasal|nosebleed|epistaxis|sinus\w*|rhinitis)\b/],
  ['mouth',     /\b(mouth|teeth|tooth\w*|dental|jaw|lips?|tongue|gums?)\b/],
  ['face',      /\b(face|facial|cheeks?|chin)\b/],
  ['head',      /\b(head|headache|head\s*ache|forehead|scalp|skull|migraine|dizz\w*|vertigo|concussion|faint\w*|syncope)\b/],
  ['throat',    /\b(throat|tonsil\w*|laryn\w*|pharyn\w*|hoarse\w*|swallow\w*)\b/],
  ['neck',      /\b(neck|cervical|nape|whiplash)\b/],
  ['upper_back',/\b(upper\s*back|thoracic|scapula\w*|shoulder\s*blades?)\b/],
  ['shoulder',  /\b(shoulders?|clavicle|collar\s*bone|rotator)\b/],
  ['forearm',   /\b(fore\s*arms?|radius|ulna)\b/],
  ['upper_arm', /\b(upper\s*arms?|arms?|biceps?|triceps?|humerus)\b/],
  ['elbow',     /\belbows?\b/],
  ['wrist',     /\bwrists?\b/],
  ['finger',    /\b(fingers?|thumbs?|fingertips?|index|nails?)\b/],
  ['hand',      /\b(hands?|palms?|knuckles?)\b/],
  ['chest',     /\b(chest|ribs?|rib\s*cage|breath\w*|cough\w*|asthma\w*|lungs?|respirat\w*|heart|cardiac|palpitation\w*|hypertension|blood\s*pressure|bp|sternum|pectoral)\b/],
  ['lower_back',/\b(lower\s*back|lumbar|lumbago|back|spine|spinal|sciatica|kidneys?|renal|flank|coccyx|tailbone)\b/],
  ['abdomen',   /\b(abdom\w*|stomach|belly|gastr\w*|vomit\w*|nausea|diarr\w*|colic|epigastr\w*|dyspepsia|constipat\w*|acidity|indigestion|gas|bloating|appendic\w*|liver)\b/],
  ['pelvis',    /\b(groin|pelvi\w*|genital\w*|hernia|urin\w*|bladder|uti|testic\w*|inguinal)\b/],
  ['buttock',   /\b(buttocks?|gluteal|glutes?)\b/],
  ['hip',       /\bhips?\b/],
  ['thigh',     /\b(thighs?|hamstrings?|quadricep\w*|femur)\b/],
  ['knee',      /\b(knees?|patella|kneecap|meniscus|acl)\b/],
  ['calf',      /\b(calf|calves)\b/],
  ['toe',       /\btoes?\b/],
  ['foot',      /\b(foot|feet|heel|soles?|plantar)\b/],
  ['ankle',     /\bankles?\b/],
  ['shin',      /\b(shins?|legs?|tibia|lower\s*leg)\b/],
  ['general',   /\b(fever|flu|influenza|cold|fatigue|weak\w*|heat\s*(stress|stroke|exhaustion|rash)?|heatstroke|dehydrat\w*|sun\s*stroke|allerg\w*|rash\w*|skin|itch\w*|body\s*(ache|aches|pain|pains)|malaise|diabet\w*|glucose|sugar|burns?|whole\s*body|multiple|general|unwell|sick|bruis\w*)\b/]
];
var SMALLPIN = {eye:0.55, ear:0.6, nose:0.55, mouth:0.6, finger:0.6, toe:0.6, wrist:0.75, ankle:0.8, hand:0.8, elbow:0.85, face:0.8};
var SUPPRESS = { finger:'hand', toe:'foot' };   // more specific region wins
var NONE_RE = /^\s*(none|n\/?a|nil|no|not\s*applicable|not\s*reported|-+|#value!?)\s*$/i;

function sideOf(txt){
  var l = /\b(left|lt\.?)\b/.test(txt), r = /\b(right|rt\.?)\b/.test(txt);
  if(/\b(both|bilateral|b\/l)\b/.test(txt) || (l && r)) return 'B';
  if(l) return 'L';
  if(r) return 'R';
  return null;
}
/* text -> [{key, side}] (side: 'L' | 'R' | 'B' | null) */
function regionsFromText(text){
  text = String(text == null ? '' : text).toLowerCase().replace(/b\/l/g, 'bilateral');
  if(!text.trim() || NONE_RE.test(text)) return [];
  var wholeSide = sideOf(text);
  var wholeSingle = (wholeSide === 'L' || wholeSide === 'R') ? wholeSide : null;
  var clauses = text.split(/[,;|\/&\n]|\band\b|\bwith\b|\.\s/);
  var out = [], seen = {};
  clauses.forEach(function(c){
    if(!c.trim()) return;
    var cs = sideOf(c) || wholeSingle || (wholeSide === 'B' ? 'B' : null);
    var work = c, hits = [];
    RULES.forEach(function(rule){
      var re = new RegExp(rule[1].source, 'g'), m, any = false;
      while((m = re.exec(work))){
        any = true;
        work = work.slice(0, m.index) + new Array(m[0].length + 1).join(' ') + work.slice(m.index + m[0].length);
      }
      if(any) hits.push(rule[0]);
    });
    var specific = hits.filter(function(k){ return k !== 'general'; });
    if(specific.length) hits = specific;
    hits.forEach(function(k){
      if(SUPPRESS[k] && hits.indexOf(SUPPRESS[k]) >= 0) hits = hits.filter(function(x){ return x !== SUPPRESS[k]; });
    });
    hits.forEach(function(k){
      var id = k + '|' + (cs || '');
      if(seen[id]) return; seen[id] = 1;
      out.push({key:k, side:cs});
    });
  });
  var hasSpecific = out.some(function(o){ return o.key !== 'general'; });
  if(hasSpecific) out = out.filter(function(o){ return o.key !== 'general'; });
  return out.slice(0, 4);
}
function sideName(s){ return s === 'L' ? 'Left ' : s === 'R' ? 'Right ' : s === 'B' ? 'Both ' : ''; }
function regionLabel(key, side){
  var r = REGIONS[key]; if(!r) return key;
  return (r.kind === 'ctr' ? '' : sideName(side)) + r.label;
}

/* ------------------------------------------------------------------ */
/* Report builders                                                     */
/* ------------------------------------------------------------------ */
function esc(s){ return String(s == null ? '' : s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
function tr(v){ return String(v == null ? '' : v).trim(); }
function dateOnly(v){ return tr(v).substring(0, 10); }
function short(s, n){ s = tr(s); return s.length > n ? s.substring(0, n - 1) + '…' : s; }

function clinicReports(rows){
  var out = (rows || []).map(function(r, i){
    var occ = tr(r['Occupational Illness Classification']);
    var non = tr(r['Non-Occupational Illness Classification']);
    var complaint = tr(r['Chief Complaint']);
    var fa = /^(y|yes)$/i.test(tr(r['First Aid Provided?']));
    var src = [complaint, non, occ].filter(Boolean).join(', ');
    var color = fa ? '#ef5350' : (occ ? '#ff7043' : '#ab47bc');
    var cls = fa ? 'First aid case' : (occ ? 'Occupational illness' : 'Non-occupational / medication');
    var vitals = [];
    if(tr(r['Temperature (°C)'])) vitals.push('Temp ' + tr(r['Temperature (°C)']));
    if(tr(r['Blood Pressure'])) vitals.push('BP ' + tr(r['Blood Pressure']));
    if(tr(r['Pulse Rate (BPM)'])) vitals.push('Pulse ' + tr(r['Pulse Rate (BPM)']));
    if(tr(r['SpO₂ (%)'])) vitals.push('SpO₂ ' + tr(r['SpO₂ (%)']) + '%');
    if(tr(r['Blood Glucose (mg/dL)'])) vitals.push('Glucose ' + tr(r['Blood Glucose (mg/dL)']));
    var d = dateOnly(r['Date']) || dateOnly(r['Timestamp']);
    return {
      id: 'c' + i, i: i, color: color, cls: cls,
      title: tr(r['Patient / Employee Name']) || ('Visit #' + (i + 1)),
      sub: [d, short(complaint || non || occ, 46)].filter(Boolean).join(' · '),
      sortKey: tr(r['Timestamp']) || d,
      regions: regionsFromText(src),
      areaSource: src,
      fields: [
        ['Date / Time', [d, tr(r['Time'])].filter(Boolean).join('  ')],
        ['Patient', tr(r['Patient / Employee Name'])], ['Employee ID', tr(r['Employee ID'])],
        ['Company', tr(r['Company'])], ['Location', tr(r['Location / Area'])],
        ['Visit type', tr(r['Visit Type'])], ['Chief complaint', complaint],
        ['Vitals', vitals.join('  ·  ')],
        ['First aid', tr(r['First Aid Provided?'])],
        ['Treatment / medication', tr(r['Treatment / Medication Given'])],
        ['Occupational illness', occ], ['Non-occupational illness', non],
        ['Reporting nurse', tr(r['Reporting Nurse'])], ['Shift', tr(r['Shift'])]
      ],
      searchText: [r['Patient / Employee Name'], r['Employee ID'], r['Company'], complaint, non, occ, r['Location / Area']].join(' ').toLowerCase()
    };
  });
  out.sort(function(a, b){ return a.sortKey < b.sortKey ? 1 : a.sortKey > b.sortKey ? -1 : 0; });
  return out;
}
function sevColor(sev){
  sev = tr(sev).toLowerCase();
  if(/crit|fatal|catastroph|major|high|severe|serious/.test(sev)) return '#ef5350';
  if(/med|moder/.test(sev)) return '#ffa726';
  if(/low|minor|negligible/.test(sev)) return '#66bb6a';
  return '#26c6da';
}
function incidentReports(rows){
  var out = (rows || []).map(function(r, i){
    var bp = tr(r['Body Part']), inj = tr(r['Injury Type']);
    var injured = inj && !NONE_RE.test(inj);
    var regs = regionsFromText(bp), src = bp;
    if(!regs.length && injured){
      src = inj + ', ' + tr(r['Description / What Happened']);
      regs = regionsFromText(inj);
      if(!regs.length) regs = regionsFromText(tr(r['Description / What Happened']));
    }
    var d = dateOnly(r['Event Date']);
    return {
      id: 'i' + i, i: i, color: sevColor(r['Severity']), cls: 'Severity: ' + (tr(r['Severity']) || 'n/a'),
      title: [tr(r['Event Type']), tr(r['Incident Category'])].filter(Boolean).join(' · ') || ('Incident #' + (i + 1)),
      sub: [d, tr(r['Building / Area'])].filter(Boolean).join(' · '),
      sortKey: d + ' ' + tr(r['Event Time']),
      regions: regs, areaSource: src,
      noBodyNote: (!regs.length) ? (injured ? 'Injury recorded, but no body part could be matched' : 'No injury / body part recorded') : '',
      fields: [
        ['Record ID', tr(r['Record ID'])],
        ['Date / Time', [d, tr(r['Event Time'])].filter(Boolean).join('  ')],
        ['Event type', tr(r['Event Type'])], ['Category', tr(r['Incident Category'])],
        ['Building / Area', tr(r['Building / Area'])], ['Exact location', tr(r['Exact Location'])],
        ['Company', tr(r['Company'])], ['Severity', tr(r['Severity'])], ['Status', tr(r['Status'])],
        ['Injury type', inj], ['Body part', bp], ['No. injured', tr(r['No. Injured'])],
        ['Days lost', tr(r['Days Lost'])], ['LTI?', tr(r['LTI?'])],
        ['What happened', tr(r['Description / What Happened'])],
        ['Immediate action', tr(r['Immediate Action Taken'])],
        ['Root cause', tr(r['Root Cause'])],
        ['Corrective action', tr(r['Corrective / Preventive Action'])]
      ],
      searchText: [r['Record ID'], r['Event Type'], r['Incident Category'], r['Building / Area'], r['Company'], bp, inj, r['Description / What Happened']].join(' ').toLowerCase()
    };
  });
  out.sort(function(a, b){ return a.sortKey < b.sortKey ? 1 : a.sortKey > b.sortKey ? -1 : 0; });
  return out;
}

/* ------------------------------------------------------------------ */
/* Styles (injected once)                                              */
/* ------------------------------------------------------------------ */
function ensureStyles(){
  if(document.getElementById('bmStyles')) return;
  var st = document.createElement('style'); st.id = 'bmStyles';
  st.textContent =
  '.bm-card{margin:16px 0;padding:0;overflow:hidden}' +
  '.bm-head{display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:10px;padding:14px 16px 6px}' +
  '.bm-title{font-weight:700;font-size:15px;color:var(--text-primary);display:flex;align-items:center;gap:8px}' +
  '.bm-tools{display:flex;gap:6px;flex-wrap:wrap}' +
  '.bm-btn{font:600 11px/1 inherit;font-family:inherit;padding:8px 11px;border-radius:9px;cursor:pointer;color:var(--text-secondary);background:rgba(255,255,255,.06);border:1px solid var(--glass-border)}' +
  '.bm-btn:hover{color:var(--text-primary);border-color:rgba(var(--accent-rgb),.6)}' +
  '.bm-btn.on{color:#fff;background:rgba(var(--accent-rgb),.28);border-color:rgba(var(--accent-rgb),.7)}' +
  '.bm-hint{margin:0;padding:0 16px 12px;font-size:12px;line-height:1.5;color:var(--text-secondary)}' +
  '.bm-body{display:grid;grid-template-columns:minmax(0,1.15fr) minmax(0,.85fr);gap:14px;padding:0 16px 16px}' +
  '@media(max-width:900px){.bm-body{grid-template-columns:1fr}}' +
  '.bm-stage{position:relative;height:580px;border-radius:14px;overflow:hidden;border:1px solid var(--glass-border);' +
    'background:radial-gradient(ellipse at 50% 38%,rgba(var(--accent-rgb),.20),rgba(0,0,0,.30) 70%);touch-action:none}' +
  '@media(max-width:900px){.bm-stage{height:440px}}' +
  '.bm-stage canvas{display:block;width:100%;height:100%;outline:none;cursor:grab}' +
  '.bm-stage canvas:active{cursor:grabbing}' +
  '.bm-over{position:absolute;pointer-events:none;font-size:11px;color:var(--text-muted)}' +
  '.bm-over.bl{left:12px;bottom:10px}' +
  '.bm-legend{position:absolute;right:10px;top:10px;display:flex;flex-direction:column;gap:4px;padding:8px 10px;border-radius:10px;background:rgba(0,0,0,.38);font-size:11px;color:var(--text-secondary);pointer-events:none}' +
  '.bm-legend i{display:inline-block;width:9px;height:9px;border-radius:50%;margin-right:6px;vertical-align:-1px}' +
  '.bm-label{position:absolute;left:0;top:0;z-index:3;pointer-events:none;max-width:210px;padding:7px 10px;border-radius:10px;font-size:12px;line-height:1.35;' +
    'color:#fff;background:rgba(6,24,26,.92);border:1px solid rgba(255,255,255,.28);box-shadow:0 6px 22px rgba(0,0,0,.45);transition:opacity .2s;display:none}' +
  '.bm-label b{display:block;font-size:12px}' +
  '.bm-label span{opacity:.8}' +
  '.bm-label:after{content:"";position:absolute;left:50%;bottom:-6px;width:10px;height:10px;margin-left:-5px;transform:rotate(45deg);background:rgba(6,24,26,.92);border-right:1px solid rgba(255,255,255,.28);border-bottom:1px solid rgba(255,255,255,.28)}' +
  '.bm-tip{position:absolute;z-index:4;pointer-events:none;padding:4px 8px;border-radius:7px;font-size:11px;color:#fff;background:rgba(0,0,0,.8);display:none;white-space:nowrap}' +
  '.bm-msg{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;text-align:center;padding:24px;color:var(--text-secondary);font-size:13px;z-index:2}' +
  '.bm-side{display:flex;flex-direction:column;gap:10px;min-width:0}' +
  '.bm-search{width:100%;padding:10px 12px;border-radius:10px;border:1px solid var(--glass-border);background:rgba(255,255,255,.06);color:var(--text-primary);font-family:inherit;font-size:13px}' +
  '.bm-count{font-size:11px;color:var(--text-muted);display:flex;justify-content:space-between;gap:8px;flex-wrap:wrap;align-items:center}' +
  '.bm-chip{display:inline-flex;align-items:center;gap:6px;padding:3px 9px;border-radius:99px;font-size:11px;font-weight:600;background:rgba(var(--accent-rgb),.22);color:var(--text-primary);border:1px solid rgba(var(--accent-rgb),.5);cursor:pointer}' +
  '.bm-list{display:flex;flex-direction:column;gap:6px;max-height:250px;overflow:auto;padding-right:3px}' +
  '.bm-item{display:flex;gap:10px;align-items:flex-start;text-align:left;width:100%;padding:9px 11px;border-radius:11px;cursor:pointer;font-family:inherit;color:var(--text-primary);background:rgba(var(--surface-rgb),.55);border:1px solid var(--glass-border)}' +
  '.bm-item:hover{border-color:rgba(var(--accent-rgb),.6)}' +
  '.bm-item.sel{border-color:var(--accent-cyan);background:rgba(var(--accent-rgb),.20);box-shadow:0 0 0 1px var(--accent-cyan) inset}' +
  '.bm-item.nobody{opacity:.62}' +
  '.bm-dot{flex:0 0 11px;height:11px;border-radius:50%;margin-top:4px}' +
  '.bm-it{min-width:0;flex:1}' +
  '.bm-it b{display:block;font-size:13px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}' +
  '.bm-it small{display:block;font-size:11px;color:var(--text-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}' +
  '.bm-it em{display:block;font-style:normal;font-size:11px;margin-top:2px;color:var(--accent-cyan)}' +
  '.bm-it em.none{color:var(--text-muted)}' +
  '.bm-detail{border:1px solid var(--glass-border);border-radius:12px;padding:12px 14px;background:rgba(var(--surface-rgb),.45);font-size:12px;max-height:260px;overflow:auto}' +
  '.bm-detail h4{margin:0 0 8px;font-size:13px;color:var(--text-primary);display:flex;align-items:center;gap:8px}' +
  '.bm-detail dl{margin:0;display:grid;grid-template-columns:130px 1fr;gap:5px 10px}' +
  '.bm-detail dt{color:var(--text-muted)} .bm-detail dd{margin:0;color:var(--text-primary);word-break:break-word}' +
  '@media(max-width:520px){.bm-detail dl{grid-template-columns:1fr}.bm-detail dt{margin-top:4px}}' +
  '.bm-empty{padding:14px;color:var(--text-muted);font-size:12px;text-align:center}';
  document.head.appendChild(st);
}

/* ------------------------------------------------------------------ */
/* Widget                                                              */
/* ------------------------------------------------------------------ */
var instances = {};
function disposeInstance(id){
  var inst = instances[id];
  if(inst){ try{ inst.dispose(); }catch(e){} delete instances[id]; }
}

function mount(containerId, cfg){
  var host = document.getElementById(containerId);
  if(!host) return;
  disposeInstance(containerId);
  ensureStyles();

  var reports = cfg.reports;
  var withBody = reports.filter(function(r){ return r.regions.length; }).length;
  host.innerHTML =
    '<div class="glass-card bm-card animate-in">' +
      '<div class="bm-head"><div class="bm-title"><i class="fas fa-person" style="color:var(--accent-cyan)"></i> ' + esc(cfg.title) + '</div>' +
        '<div class="bm-tools">' +
          '<button class="bm-btn" data-v="front">Front</button><button class="bm-btn" data-v="back">Back</button>' +
          '<button class="bm-btn" data-v="left">Left</button><button class="bm-btn" data-v="right">Right</button>' +
          '<button class="bm-btn on" data-t="pins" title="Show a pin for every report">All pins</button>' +
          '<button class="bm-btn" data-t="spin" title="Slowly rotate the body">Auto-rotate</button>' +
          '<button class="bm-btn" data-v="reset"><i class="fas fa-undo"></i> Reset</button>' +
        '</div></div>' +
      '<p class="bm-hint">' + esc(cfg.hint) + '</p>' +
      '<div class="bm-body">' +
        '<div class="bm-stage"><div class="bm-msg">Loading 3D body…</div>' +
          '<div class="bm-legend">' + cfg.legend.map(function(l){ return '<div><i style="background:' + l[0] + '"></i>' + esc(l[1]) + '</div>'; }).join('') + '</div>' +
          '<div class="bm-over bl">Drag to rotate · scroll / pinch to zoom · click a pin or body area</div>' +
          '<div class="bm-label"></div><div class="bm-tip"></div></div>' +
        '<div class="bm-side">' +
          '<input class="bm-search" type="search" placeholder="Search reports…" aria-label="Search reports">' +
          '<div class="bm-count"><span class="bm-n"></span><span class="bm-filter"></span></div>' +
          '<div class="bm-list" role="listbox" aria-label="Reports"></div>' +
          '<div class="bm-detail"><div class="bm-empty">Select a report to see its details and the exact spot on the body.</div></div>' +
        '</div>' +
      '</div></div>';

  var stage = host.querySelector('.bm-stage');
  var msgEl = host.querySelector('.bm-msg');
  var labelEl = host.querySelector('.bm-label');
  var tipEl = host.querySelector('.bm-tip');
  var listEl = host.querySelector('.bm-list');
  var detailEl = host.querySelector('.bm-detail');
  var searchEl = host.querySelector('.bm-search');
  var nEl = host.querySelector('.bm-n');
  var filterEl = host.querySelector('.bm-filter');

  var state = { sel: null, q: '', region: null, pins: true, spin: false };
  var byId = {}; reports.forEach(function(r){ byId[r.id] = r; });

  /* ---------- list / detail (work even without WebGL) ---------- */
  function regionText(r){
    return r.regions.map(function(g){ return regionLabel(g.key, g.side); }).join(' + ');
  }
  function visible(){
    return reports.filter(function(r){
      if(state.q && r.searchText.indexOf(state.q) < 0) return false;
      if(state.region){
        var f = state.region;
        return r.regions.some(function(g){
          if(g.key !== f.key) return false;
          if(REGIONS[g.key].kind === 'sym'){
            var s = g.side || 'R';
            return s === 'B' || s === f.side;
          }
          return true;
        });
      }
      return true;
    });
  }
  function renderList(){
    var list = visible();
    nEl.textContent = list.length + ' of ' + reports.length + ' reports · ' + withBody + ' with a body area';
    filterEl.innerHTML = state.region
      ? '<span class="bm-chip" data-clear="1" title="Clear area filter">' + esc(regionLabel(state.region.key, state.region.side)) + ' <i class="fas fa-times"></i></span>' : '';
    if(!list.length){
      listEl.innerHTML = '<div class="bm-empty">' + (state.region
        ? 'No reports for ' + esc(regionLabel(state.region.key, state.region.side)) + '.'
        : (reports.length ? 'No reports match your search.' : esc(cfg.empty))) + '</div>';
      return;
    }
    listEl.innerHTML = list.map(function(r){
      return '<button type="button" class="bm-item' + (r.id === state.sel ? ' sel' : '') + (r.regions.length ? '' : ' nobody') + '" data-id="' + r.id + '" role="option" aria-selected="' + (r.id === state.sel) + '">' +
        '<span class="bm-dot" style="background:' + r.color + '"></span><span class="bm-it"><b>' + esc(r.title) + '</b><small>' + esc(r.sub) + '</small>' +
        (r.regions.length ? '<em><i class="fas fa-crosshairs"></i> ' + esc(regionText(r)) + '</em>' : '<em class="none">' + esc(r.noBodyNote || 'No body area matched') + '</em>') +
        '</span></button>';
    }).join('');
  }
  function renderDetail(){
    var r = byId[state.sel];
    if(!r){ detailEl.innerHTML = '<div class="bm-empty">Select a report to see its details and the exact spot on the body.</div>'; return; }
    var h = '<h4><span class="bm-dot" style="background:' + r.color + ';margin:0"></span>' + esc(r.title) + '</h4><dl>';
    h += '<dt>Body area</dt><dd>' + (r.regions.length ? esc(regionText(r)) + (r.areaSource ? ' <span style="color:var(--text-muted)">(from “' + esc(short(r.areaSource, 60)) + '”)</span>' : '') : esc(r.noBodyNote || 'Not recorded')) + '</dd>';
    r.regions.forEach(function(g){
      if(REGIONS[g.key].kind === 'sym' && !g.side) h += '<dt></dt><dd style="color:var(--text-muted)">Side not stated – shown on the right.</dd>';
    });
    r.fields.forEach(function(f){ if(f[1]) h += '<dt>' + esc(f[0]) + '</dt><dd>' + esc(f[1]) + '</dd>'; });
    detailEl.innerHTML = h + '</dl>';
  }
  renderList();

  /* ---------- 3D ---------- */
  var disposed = false, raf = 0, ro = null, cleanup = [];
  var api = {};

  function init3D(THREE, asset){
    if(disposed) return;
    var W = stage.clientWidth || 600, H = stage.clientHeight || 500;
    var renderer;
    try{
      renderer = new THREE.WebGLRenderer({antialias:true, alpha:true, powerPreference:'default'});
    }catch(e){ throw new Error('WebGL unavailable'); }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setSize(W, H);
    renderer.outputEncoding = THREE.sRGBEncoding;
    renderer.domElement.setAttribute('aria-label', '3D human body. Drag to rotate, scroll to zoom.');
    renderer.domElement.tabIndex = 0;
    stage.insertBefore(renderer.domElement, stage.firstChild);

    var scene = new THREE.Scene();
    var camera = new THREE.PerspectiveCamera(32, W / H, 0.05, 40);
    var controls = new THREE.OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true; controls.dampingFactor = 0.08;
    controls.minDistance = 0.7; controls.maxDistance = 6;
    controls.minPolarAngle = 0.15; controls.maxPolarAngle = Math.PI - 0.15;
    controls.autoRotateSpeed = 1.6;
    var HOME = {az:0, pol:Math.PI / 2 - 0.04, dist:4.3, t:new THREE.Vector3(0, 0.93, 0)};
    controls.target.copy(HOME.t);
    camera.position.set(0, 0.93 + HOME.dist * Math.cos(HOME.pol), HOME.dist * Math.sin(HOME.pol));
    controls.update();

    scene.add(new THREE.HemisphereLight(0xdff4ff, 0x0a2230, 0.8));
    var key = new THREE.DirectionalLight(0xffffff, 0.85); key.position.set(1.5, 2.6, 3); scene.add(key);
    var rim = new THREE.DirectionalLight(0x4dd0e1, 0.8); rim.position.set(-2, 1.6, -2.6); scene.add(rim);
    var fill = new THREE.DirectionalLight(0x80cbc4, 0.35); fill.position.set(-2, 0.5, 2); scene.add(fill);

    /* ----- body ----- */
    var body = new THREE.Group(); scene.add(body);
    var SM = (asset && asset.material) || DEFAULT_MATERIAL;
    var skin = new THREE.MeshStandardMaterial({color:new THREE.Color(SM.color), roughness:SM.roughness, metalness:SM.metalness, emissive:new THREE.Color(SM.emissive), emissiveIntensity:SM.emissiveIntensity});
    var V = function(a){ return new THREE.Vector3(a[0], a[1], a[2] || 0); };
    function mesh(geo, x, y, z){ var m = new THREE.Mesh(geo, skin); m.position.set(x, y, z); body.add(m); return m; }
    function ell(rx, ry, rz, x, y, z){ return mesh(new THREE.SphereGeometry(1, 36, 24).scale(rx, ry, rz), x, y, z); }
    function limb(a, b, r1, r2){
      var A = V(a), B = V(b), len = A.distanceTo(B);
      var m = mesh(new THREE.CylinderGeometry(r2, r1, len, 28, 1), (A.x + B.x) / 2, (A.y + B.y) / 2, (A.z + B.z) / 2);
      m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), B.clone().sub(A).normalize());
    }
    function buildProcedural(){
    // torso (lathe, flattened front-to-back)
    var prof = [[0.001,0.86],[0.12,0.865],[0.17,0.90],[0.186,0.97],[0.166,1.04],[0.146,1.11],[0.15,1.2],[0.175,1.30],[0.196,1.38],[0.186,1.43],[0.13,1.47],[0.07,1.50],[0.05,1.53],[0.001,1.536]]
      .map(function(p){ return new THREE.Vector2(p[0], p[1]); });
    var tg = new THREE.LatheGeometry(new THREE.SplineCurve(prof).getPoints(90), 44); tg.scale(1, 1, 0.58);
    mesh(tg, 0, 0, 0);
    limb([0,1.50,0], [0,1.62,0], 0.052, 0.046);                       // neck
    ell(0.085, 0.115, 0.1, 0, 1.70, 0.005);                           // head
    var nose = new THREE.ConeGeometry(0.014, 0.036, 14); nose.rotateX(Math.PI / 2); mesh(nose, 0, 1.672, 0.108);
    [1, -1].forEach(function(s){
      ell(0.014, 0.034, 0.024, s * 0.088, 1.695, 0);                  // ears
      ell(0.064, 0.06, 0.06, s * 0.205, 1.44, 0);                     // shoulders
      limb([s*0.205,1.44,0], [s*0.30,1.15,0], 0.05, 0.042);          // upper arm
      ell(0.043, 0.043, 0.043, s * 0.30, 1.15, 0);                    // elbow
      limb([s*0.30,1.15,0], [s*0.37,0.88,0], 0.041, 0.03);           // forearm
      ell(0.031, 0.031, 0.031, s * 0.37, 0.88, 0);                    // wrist
      var h = ell(0.036, 0.088, 0.019, s * 0.386, 0.80, 0);           // hand
      h.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), new THREE.Vector3(s * 0.196, -0.98, 0).normalize());
      ell(0.092, 0.092, 0.092, s * 0.095, 0.95, 0);                   // hip joint
      limb([s*0.095,0.95,0], [s*0.10,0.52,0], 0.09, 0.06);           // thigh
      ell(0.061, 0.061, 0.061, s * 0.10, 0.52, 0);                    // knee
      limb([s*0.10,0.52,0], [s*0.095,0.09,0], 0.059, 0.038);         // lower leg
      ell(0.04, 0.04, 0.04, s * 0.095, 0.09, 0);                      // ankle
      ell(0.046, 0.036, 0.115, s * 0.095, 0.04, 0.065);               // foot
    });
    }
    function buildFromAsset(){
      asset.meshes.forEach(function(m){
        var g = new THREE.BufferGeometry();
        g.setAttribute('position', new THREE.BufferAttribute(m.positions, 3));
        g.setIndex(new THREE.BufferAttribute(m.indices, 1));
        if(m.normals) g.setAttribute('normal', new THREE.BufferAttribute(m.normals, 3)); else g.computeVertexNormals();
        g.computeBoundingSphere(); g.computeBoundingBox();
        var mm = new THREE.Mesh(g, skin); mm.userData.isBody = true; body.add(mm);
      });
    }
    var usedAsset = false;
    if(asset){ try{ buildFromAsset(); usedAsset = body.children.length > 0; }catch(e){ if(window.console) console.warn('[bodymap] model build failed, using built-in body', e); while(body.children.length) body.remove(body.children[0]); } }
    if(!usedAsset) buildProcedural();
    // ground
    var ringM = new THREE.MeshBasicMaterial({color:0x26c6da, transparent:true, opacity:0.55, side:THREE.DoubleSide});
    var ring = new THREE.Mesh(new THREE.RingGeometry(0.46, 0.475, 72), ringM); ring.rotation.x = -Math.PI / 2; ring.position.y = 0.002; scene.add(ring);
    var disc = new THREE.Mesh(new THREE.CircleGeometry(0.46, 72), new THREE.MeshBasicMaterial({color:0x26c6da, transparent:true, opacity:0.10})); disc.rotation.x = -Math.PI / 2; scene.add(disc);
    body.updateMatrixWorld(true);

    /* ----- surface helper ----- */
    function nearestSkin(pos, maxD){
      var best = 1e9, bi = -1, bg = null, px = pos.x, py = pos.y, pz = pos.z;
      body.children.forEach(function(m){
        var P = m.geometry.attributes.position.array;
        for(var i = 0; i < P.length; i += 3){
          var dx = P[i] - px, dy = P[i + 1] - py, dz = P[i + 2] - pz, d2 = dx * dx + dy * dy + dz * dz;
          if(d2 < best){ best = d2; bi = i; bg = m.geometry; }
        }
      });
      if(!bg || best > maxD * maxD) return null;
      var N = bg.attributes.normal.array, P2 = bg.attributes.position.array;
      return {p: new THREE.Vector3(P2[bi], P2[bi + 1], P2[bi + 2]), n: new THREE.Vector3(N[bi], N[bi + 1], N[bi + 2]).normalize()};
    }
    var ray = new THREE.Raycaster();
    function surface(pos, dir){
      var d = dir.clone().normalize();
      ray.set(pos.clone().add(d.clone().multiplyScalar(0.9)), d.clone().negate());
      var hit = ray.intersectObject(body, true)[0];
      if(!hit && usedAsset){
        // the ray slipped through a gap (e.g. between fingers): snap to the closest point on the skin
        var nv = nearestSkin(pos, 0.09);
        if(nv) return nv;
      }
      if(!hit) return {p: pos.clone().add(d.clone().multiplyScalar(0.05)), n: d};
      var n = hit.face.normal.clone().transformDirection(hit.object.matrixWorld).normalize();
      return {p: hit.point.clone(), n: n};
    }
    function anchor(key, side, extra){
      var R = REGIONS[key];
      var s = side === 'L' ? 1 : -1;
      var pos = V(R.pos), dir = V(R.dir);
      if(R.kind === 'sym'){ pos.x *= s; dir.x *= s; }
      else if(R.kind === 'opt' && (side === 'L' || side === 'R')){ pos.x = s * R.off; }
      if(extra){ pos.add(extra); }
      return surface(pos, dir);
    }
    function tangentOffset(n, k, total){
      if(total <= 1) return null;
      var up = Math.abs(n.y) > 0.85 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0);
      var u = new THREE.Vector3().crossVectors(up, n).normalize(), v = new THREE.Vector3().crossVectors(n, u).normalize();
      var ang = k * 2.39996, rad = 0.026 * Math.sqrt(k + 0.5);
      return u.multiplyScalar(Math.cos(ang) * rad).add(v.multiplyScalar(Math.sin(ang) * rad));
    }

    /* click-lookup table of anchors (one per region/side) */
    var table = [];
    Object.keys(REGIONS).forEach(function(k){
      var R = REGIONS[k];
      if(R.kind === 'sym'){ ['L', 'R'].forEach(function(s){ var a = anchor(k, s); table.push({key:k, side:s, p:a.p, n:a.n}); }); }
      else { var a = anchor(k, null); table.push({key:k, side:null, p:a.p, n:a.n}); }
    });

    /* ----- pins ----- */
    var pinRoot = new THREE.Group(); scene.add(pinRoot);
    var pinsOf = {};            // report id -> [pin]
    var allPins = [];
    var geoCone = new THREE.ConeGeometry(0.0125, 0.07, 16); geoCone.rotateX(Math.PI); geoCone.translate(0, 0.035, 0);
    var geoHead = new THREE.SphereGeometry(0.02, 20, 14);
    var geoRing = new THREE.RingGeometry(0.03, 0.04, 40); geoRing.rotateX(-Math.PI / 2);

    function makePin(rep, g, side, k, total){
      var R = REGIONS[g.key];
      var a0 = anchor(g.key, side);
      var off = tangentOffset(a0.n, k, total);
      var a = off ? anchor(g.key, side, off) : a0;
      var col = new THREE.Color(rep.color);
      var grp = new THREE.Group();
      grp.position.copy(a.p);
      grp.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), a.n);
      var mCone = new THREE.MeshStandardMaterial({color:col, emissive:col, emissiveIntensity:0.55, roughness:0.4, transparent:true});
      var mHead = new THREE.MeshStandardMaterial({color:col, emissive:col, emissiveIntensity:0.8, roughness:0.3, transparent:true});
      var cone = new THREE.Mesh(geoCone, mCone);
      var head = new THREE.Mesh(geoHead, mHead); head.position.y = 0.088;
      var mRing = new THREE.MeshBasicMaterial({color:col, transparent:true, opacity:0.9, side:THREE.DoubleSide, depthWrite:false});
      var rg = new THREE.Mesh(geoRing, mRing); rg.position.y = 0.004;
      // the pointer leans upward so it reads as a pin from the front; the ring lies flat on the skin
      var axisW = a.n.clone(); if(Math.abs(a.n.y) < 0.8){ axisW.y += 0.8; axisW.normalize(); }
      var axisL = axisW.applyQuaternion(grp.quaternion.clone().invert());
      var pinG = new THREE.Group(); pinG.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), axisL);
      pinG.add(cone, head); grp.add(pinG, rg);
      [cone, head, rg].forEach(function(m){ m.userData.pin = true; m.userData.rid = rep.id; });
      pinRoot.add(grp);
      var pin = {rid:rep.id, grp:grp, cone:mCone, head:mHead, ring:rg, ringM:mRing, p:a.p, n:a.n, key:g.key, side:side, zoom:R.zoom, scale:1, tscale:1, base:(SMALLPIN[g.key] || 1), phase:Math.random() * 6};
      (pinsOf[rep.id] = pinsOf[rep.id] || []).push(pin);
      allPins.push(pin);
    }
    // group by region so overlapping pins fan out
    var groups = {};
    reports.forEach(function(rep){
      rep.regions.forEach(function(g){
        var R = REGIONS[g.key], sides = [null];
        if(R.kind === 'sym') sides = g.side === 'B' ? ['L', 'R'] : [g.side || 'R'];
        else if(R.kind === 'opt' && g.side === 'B') sides = ['L', 'R'];
        else if(R.kind === 'opt' && (g.side === 'L' || g.side === 'R')) sides = [g.side];
        sides.forEach(function(s){ (groups[g.key + '|' + (s || '')] = groups[g.key + '|' + (s || '')] || []).push({rep:rep, g:g, side:s}); });
      });
    });
    Object.keys(groups).forEach(function(id){
      var arr = groups[id];
      arr.forEach(function(it, k){ makePin(it.rep, it.g, it.side, k, arr.length); });
    });

    /* marker for a clicked body area */
    var areaMark = new THREE.Mesh(new THREE.RingGeometry(0.035, 0.05, 40).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({color:0xffffff, transparent:true, opacity:0.95, side:THREE.DoubleSide, depthWrite:false}));
    areaMark.visible = false; scene.add(areaMark);

    /* ----- camera tween ----- */
    var tween = null;
    controls.addEventListener('start', function(){ tween = null; });
    function flyTo(spec, dur){
      var off = camera.position.clone().sub(controls.target);
      var sp = new THREE.Spherical().setFromVector3(off);
      tween = {t0:performance.now(), dur:dur || 900, az0:sp.theta, pol0:sp.phi, d0:sp.radius, t0v:controls.target.clone(), to:spec};
    }
    function ease(t){ return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2; }
    function stepTween(now){
      if(!tween) return;
      var k = Math.min(1, (now - tween.t0) / tween.dur), e = ease(k), to = tween.to;
      var dAz = to.az - tween.az0; dAz = Math.atan2(Math.sin(dAz), Math.cos(dAz));
      var th = tween.az0 + dAz * e, ph = tween.pol0 + (to.pol - tween.pol0) * e, rd = tween.d0 + (to.dist - tween.d0) * e;
      controls.target.lerpVectors(tween.t0v, to.t, e);
      camera.position.set(
        controls.target.x + rd * Math.sin(ph) * Math.sin(th),
        controls.target.y + rd * Math.cos(ph),
        controls.target.z + rd * Math.sin(ph) * Math.cos(th));
      if(k >= 1) tween = null;
    }
    function viewSpec(name){
      if(name === 'front') return {az:0, pol:HOME.pol, dist:HOME.dist, t:HOME.t};
      if(name === 'back')  return {az:Math.PI, pol:HOME.pol, dist:HOME.dist, t:HOME.t};
      if(name === 'left')  return {az:Math.PI / 2, pol:HOME.pol, dist:HOME.dist, t:HOME.t};
      if(name === 'right') return {az:-Math.PI / 2, pol:HOME.pol, dist:HOME.dist, t:HOME.t};
      return {az:0, pol:HOME.pol, dist:HOME.dist, t:HOME.t};
    }
    function focusPins(pins){
      var c = new THREE.Vector3(), n = new THREE.Vector3(), z = 0;
      pins.forEach(function(p){ c.add(p.p); n.add(p.n); z = Math.max(z, p.zoom); });
      c.multiplyScalar(1 / pins.length); n.normalize();
      var spread = 0;
      pins.forEach(function(p){ spread = Math.max(spread, p.p.distanceTo(c)); });
      var el = Math.asin(Math.max(-0.6, Math.min(0.6, n.y)));
      flyTo({az:Math.atan2(n.x, n.z), pol:Math.PI / 2 - el * 0.55, dist:Math.max(z, Math.min(3.6, z + spread * 3)),
             t:new THREE.Vector3(c.x * 0.7, c.y, c.z * 0.5)});
    }

    /* ----- selection ----- */
    function applyPinStates(){
      var selPins = state.sel ? (pinsOf[state.sel] || []) : [];
      allPins.forEach(function(p){
        var isSel = p.rid === state.sel;
        var shown = state.pins || isSel;
        if(state.region && !isSel){
          shown = shown && regionMatch(p);
        }
        p.grp.visible = shown;
        p.tscale = p.base * (isSel ? 1.45 : (state.sel ? 0.8 : 1));
        var dim = (state.sel && !isSel) ? 0.5 : 1;
        p.cone.opacity = dim; p.head.opacity = dim; p.ringM.opacity = isSel ? 0.95 : 0.55 * dim;
        p.isSel = isSel;
      });
      return selPins;
    }
    function regionMatch(p){
      if(!state.region) return true;
      if(p.key !== state.region.key) return false;
      return REGIONS[p.key].kind !== 'sym' || p.side === state.region.side;
    }
    function select(id, fly){
      state.sel = id;
      var pins = applyPinStates();
      renderList(); renderDetail();
      var it = listEl.querySelector('.bm-item.sel');
      if(it && it.scrollIntoView) it.scrollIntoView({block:'nearest', behavior:'smooth'});
      if(pins.length){
        labelFor = pins[0];
        if(fly !== false) focusPins(pins);
      } else {
        labelFor = null;
        if(fly !== false) flyTo(viewSpec('front'));
      }
    }
    var labelFor = null;
    function setRegion(r){
      state.region = r;
      if(r){
        var t = table.filter(function(x){ return x.key === r.key && (x.side === r.side || !x.side); })[0];
        if(t){ areaMark.position.copy(t.p).addScaledVector(t.n, 0.004); areaMark.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), t.n); areaMark.visible = true; }
      } else areaMark.visible = false;
      applyPinStates(); renderList();
    }

    /* ----- UI wiring ----- */
    host.querySelectorAll('[data-v]').forEach(function(b){
      b.addEventListener('click', function(){
        var v = b.getAttribute('data-v');
        if(v === 'reset'){ state.sel = null; state.region = null; labelFor = null; areaMark.visible = false; applyPinStates(); renderList(); renderDetail(); }
        flyTo(viewSpec(v));
      });
    });
    host.querySelector('[data-t="pins"]').addEventListener('click', function(e){
      state.pins = !state.pins; e.currentTarget.classList.toggle('on', state.pins); applyPinStates();
    });
    host.querySelector('[data-t="spin"]').addEventListener('click', function(e){
      state.spin = !state.spin; e.currentTarget.classList.toggle('on', state.spin); controls.autoRotate = state.spin; tween = null;
    });
    listEl.addEventListener('click', function(e){
      var b = e.target.closest('.bm-item'); if(!b) return;
      var id = b.getAttribute('data-id');
      select(id, true);
    });
    filterEl.addEventListener('click', function(e){ if(e.target.closest('[data-clear]')) setRegion(null); });
    searchEl.addEventListener('input', function(){ state.q = searchEl.value.trim().toLowerCase(); renderList(); });

    /* ----- pointer picking ----- */
    var down = null, mouse = new THREE.Vector2();
    var dom = renderer.domElement;
    function setMouse(e){
      var rc = dom.getBoundingClientRect();
      mouse.set(((e.clientX - rc.left) / rc.width) * 2 - 1, -((e.clientY - rc.top) / rc.height) * 2 + 1);
      ray.setFromCamera(mouse, camera);
    }
    function pickPin(){
      var hits = ray.intersectObjects(pinRoot.children.filter(function(g){ return g.visible; }), true);
      for(var i = 0; i < hits.length; i++) if(hits[i].object.userData.pin) return hits[i];
      return null;
    }
    function pickBody(){
      var hit = ray.intersectObject(body, true)[0];
      if(!hit) return null;
      var n = hit.face.normal.clone().transformDirection(hit.object.matrixWorld);
      var best = null, bd = 1e9;
      table.forEach(function(t){
        var d = t.p.distanceTo(hit.point) + (t.n.dot(n) < 0 ? 0.35 : 0);
        if(d < bd){ bd = d; best = t; }
      });
      return best;
    }
    dom.addEventListener('pointerdown', function(e){ down = {x:e.clientX, y:e.clientY}; });
    dom.addEventListener('pointerup', function(e){
      if(!down) return;
      var moved = Math.hypot(e.clientX - down.x, e.clientY - down.y); down = null;
      if(moved > 5) return;
      setMouse(e);
      var p = pickPin();
      if(p){ var rid = p.object.userData.rid; setRegion(null); select(rid, true); return; }
      var t = pickBody();
      if(t){
        if(state.region && state.region.key === t.key && state.region.side === t.side){ setRegion(null); return; }
        setRegion({key:t.key, side:t.side});
        var first = visible()[0];
        if(first && first.regions.length) select(first.id, false); else { state.sel = null; labelFor = null; applyPinStates(); renderList(); renderDetail(); }
        flyTo({az:Math.atan2(t.n.x, t.n.z), pol:Math.PI / 2 - Math.asin(Math.max(-0.6, Math.min(0.6, t.n.y))) * 0.55, dist:Math.max(1.4, REGIONS[t.key].zoom + 0.3), t:new THREE.Vector3(t.p.x * 0.7, t.p.y, t.p.z * 0.5)});
      } else if(state.region){ setRegion(null); }
    });
    dom.addEventListener('pointermove', function(e){
      if(e.pointerType === 'touch' || e.buttons) { tipEl.style.display = 'none'; return; }
      setMouse(e);
      var p = pickPin(), rc = stage.getBoundingClientRect();
      if(p){
        var rep = byId[p.object.userData.rid];
        tipEl.textContent = rep.title + ' — ' + regionText(rep);
        tipEl.style.display = 'block';
        tipEl.style.left = Math.min(e.clientX - rc.left + 12, rc.width - 220) + 'px';
        tipEl.style.top = (e.clientY - rc.top + 14) + 'px';
        dom.style.cursor = 'pointer';
      } else { tipEl.style.display = 'none'; dom.style.cursor = ''; }
    });
    dom.addEventListener('pointerleave', function(){ tipEl.style.display = 'none'; });

    /* ----- resize ----- */
    function resize(){
      var w = stage.clientWidth, h = stage.clientHeight;
      if(!w || !h) return;
      renderer.setSize(w, h); camera.aspect = w / h; camera.updateProjectionMatrix();
    }
    if(window.ResizeObserver){ ro = new ResizeObserver(resize); ro.observe(stage); }
    else { window.addEventListener('resize', resize); cleanup.push(function(){ window.removeEventListener('resize', resize); }); }

    /* ----- frame loop ----- */
    var tmp = new THREE.Vector3(), camDir = new THREE.Vector3();
    function frame(now){
      if(disposed) return;
      if(!host.isConnected || !stage.isConnected){ delete instances[containerId]; api.dispose(); return; }
      raf = requestAnimationFrame(frame);
      stepTween(now);
      controls.update();
      var t = now / 1000;
      allPins.forEach(function(p){
        if(!p.grp.visible) return;
        p.scale += (p.tscale - p.scale) * 0.18;
        p.grp.scale.setScalar(p.scale);
        var pulse = (t * (p.isSel ? 1.4 : 0.6) + p.phase) % 1;
        p.ring.scale.setScalar(1 + pulse * (p.isSel ? 1.9 : 0.9));
        p.ringM.opacity = (p.isSel ? 0.95 : 0.55 * (state.sel ? 0.5 : 1)) * (1 - pulse);
      });
      if(areaMark.visible){ var s = 1 + 0.12 * Math.sin(t * 5); areaMark.scale.setScalar(s); }
      // label follows selected pin
      if(labelFor && labelFor.grp.visible && state.sel){
        camDir.copy(camera.position).sub(labelFor.p).normalize();
        var facing = labelFor.n.dot(camDir);
        tmp.copy(labelFor.p).project(camera);
        var w = stage.clientWidth, h = stage.clientHeight;
        var x = (tmp.x * 0.5 + 0.5) * w, y = (-tmp.y * 0.5 + 0.5) * h - 62 * Math.min(1.2, labelFor.scale);
        var lw = labelEl.offsetWidth || 150, lh = labelEl.offsetHeight || 40;
        var cx = Math.max(lw / 2 + 6, Math.min(w - lw / 2 - 6, x)), cy = Math.max(lh + 14, Math.min(h - 8, y));
        labelEl.style.display = 'block';
        labelEl.style.transform = 'translate(' + (cx - lw / 2) + 'px,' + (cy - lh - 8) + 'px)';
        labelEl.style.opacity = facing > -0.1 ? 1 : 0.28;
        if(labelEl.getAttribute('data-for') !== state.sel){
          var rep = byId[state.sel];
          labelEl.innerHTML = '<b>' + esc(rep.title) + '</b><span>' + esc(regionText(rep)) + '</span>' + (facing <= -0.1 ? '' : '');
          labelEl.setAttribute('data-for', state.sel);
        }
      } else { labelEl.style.display = 'none'; labelEl.removeAttribute('data-for'); }
      renderer.render(scene, camera);
    }
    raf = requestAnimationFrame(frame);
    msgEl.style.display = 'none';

    api.select = function(id, fly){ select(id, fly); };
    api.setRegion = setRegion;
    api.view = function(n){ flyTo(viewSpec(n)); };
    api.pins = allPins;
    api.camera = camera; api.controls = controls; api.THREE = THREE; api.renderer = renderer;
    api.dispose = function(){
      if(disposed) return; disposed = true;
      cancelAnimationFrame(raf);
      try{ ro && ro.disconnect(); }catch(e){}
      cleanup.forEach(function(f){ try{ f(); }catch(e){} });
      try{ controls.dispose(); }catch(e){}
      scene.traverse(function(o){
        if(o.geometry) o.geometry.dispose();
        if(o.material){ (Array.isArray(o.material) ? o.material : [o.material]).forEach(function(m){ m.dispose(); }); }
      });
      try{ renderer.dispose(); renderer.forceContextLoss(); }catch(e){}
      if(renderer.domElement.parentNode) renderer.domElement.parentNode.removeChild(renderer.domElement);
    };
  }

  /* list works before / without 3D: clicking just shows details */
  function fallbackSelect(e){
    var b = e.target.closest('.bm-item'); if(!b) return;
    state.sel = b.getAttribute('data-id'); renderList(); renderDetail();
  }
  listEl.addEventListener('click', fallbackSelect);   // replaced by 3D wiring once ready (both run; harmless)

  var inst = {
    dispose: function(){ if(api.dispose) api.dispose(); else disposed = true; },
    api: api
  };
  instances[containerId] = inst;

  loadThree().then(function(THREE){
    return loadBodyAsset().then(function(asset){ return {THREE:THREE, asset:asset}; });
  }).then(function(pkg){
    var THREE = pkg.THREE;
    if(disposed || instances[containerId] !== inst) return;
    try{ init3D(THREE, pkg.asset); }
    catch(err){
      msgEl.innerHTML = '<div><i class="fas fa-cube" style="font-size:28px;opacity:.5"></i><br><br>The 3D view needs WebGL, which isn’t available here.<br>The report list and details still work.</div>';
      if(window.console) console.warn('[bodymap]', err);
    }
  }).catch(function(err){
    msgEl.innerHTML = '<div><i class="fas fa-wifi" style="font-size:28px;opacity:.5"></i><br><br>Couldn’t load the 3D engine (vendor/three.min.js).<br>The report list and details still work.</div>';
    if(window.console) console.warn('[bodymap]', err);
  });
  return inst;
}

/* ------------------------------------------------------------------ */
/* Public entry points                                                 */
/* ------------------------------------------------------------------ */
window.mblBodyMapMountClinic = function(){
  var rows = (window.APP_DATA && APP_DATA.clinic && APP_DATA.clinic.rows) || (typeof APP_DATA !== 'undefined' && APP_DATA.clinic && APP_DATA.clinic.rows) || [];
  return mount('clinicBodyMapSection', {
    title: '3D Body Map — Clinic Reports',
    hint: 'Click a clinic report to see exactly where on the body the injury or condition is. The body turns to the pin; click any pin or body area to jump to its reports.',
    empty: 'No clinic reports yet.',
    legend: [['#ef5350', 'First aid case'], ['#ff7043', 'Occupational illness'], ['#ab47bc', 'Non-occupational / medication']],
    reports: clinicReports(rows)
  });
};
window.mblBodyMapMountIncidents = function(sk){
  var host = document.getElementById('incBodyMapSection');
  if(!host) return;
  if(sk !== 'incidents'){ disposeInstance('incBodyMapSection'); host.innerHTML = ''; return; }
  var rows = (typeof APP_DATA !== 'undefined' && APP_DATA.incidents && APP_DATA.incidents.rows) || [];
  return mount('incBodyMapSection', {
    title: '3D Body Map — Incident Tracker',
    hint: 'Incidents with an injury are pinned to the body part recorded in the tracker. Click an incident to locate it; incidents with no injury stay in the list without a pin.',
    empty: 'No incidents on record yet.',
    legend: [['#ef5350', 'High / critical severity'], ['#ffa726', 'Medium severity'], ['#66bb6a', 'Low severity']],
    reports: incidentReports(rows)
  });
};
window.mblBodyMap = { regionsFromText: regionsFromText, instances: instances, dispose: disposeInstance,
  _internals: { REGIONS: REGIONS, parseGLB: parseGLB, decodeMblJSON: decodeMblJSON, normalizeAsset: normalizeAsset, applyRegionOverrides: applyRegionOverrides } };
})();
