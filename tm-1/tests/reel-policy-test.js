const fs=require('fs');
const src=fs.readFileSync('/mnt/user-data/outputs/tl1-tape-lab.jsx','utf8');
const a=src.indexOf('function engineFactory()'),b=src.indexOf('const TapeEngine = engineFactory();');
const TE=eval('('+src.slice(a,b)+')')();
const sr=48000;
const WIN_SEC=300, MIN_MARGIN=2, GUARD=1024;
const base={rate:[1,1],level:[0.9,0.9],filter:[0,0],offset:[0,0],loopStart:[0,0],loopLen:[1,1],
 gSize:[0.3,0.3],gDens:[0,0],gSpray:[0.3,0.3],gRamp:[0.5,0.5],gLive:[0,0],
 lfoRate:[1,1],lfoDepth:[0,0],lfoShape:[0,0],lfoDest:[1,1],lfoSync:[1,1],
 gmSrc:0,gmRate:0.1,gmDepth:0,gmDest:0,loop:[1,1],
 age:0,delay:0,delayTime:0.375,delayFb:0,reverb:0,output:1,erase:[1,1],invert:[0,0],recGain:1};

// A simulated card: 6 hours of reel. Never materialised.
const HOURS=6, REEL=Math.floor(sr*3600*HOURS), WIN=sr*WIN_SEC;
// returns { data, bufStart, gLo, gHi } — a guarded window, as the host builds it
function readWin(start){
  const st=Math.max(0,Math.min(REEL-WIN,Math.round(start)));
  const bs=Math.max(0, st-GUARD), be=Math.min(REEL, st+WIN+GUARD);
  const w=new Int16Array(be-bs);
  for(let i=0;i<w.length;i++){ const g=((bs+i)%REEL+REEL)%REEL;
    w[i]=Math.sin(2*Math.PI*100*g/sr)*0.5*32767; }
  return { data:w, bufStart:bs, gLo:st-bs, gHi:be-(st+WIN) };
}
function put(e,d,start){ const r=readWin(start); e.setWindow(d,r.data,r.bufStart,REEL,r.gLo,r.gHi); }

function trial(o, startReelPos, blocks, tag){
  const e=new TE(sr);
  const s0=Math.max(0,Math.min(REEL-WIN, Math.round(startReelPos-WIN/2)));
  for(const d of [0,1]){ put(e,d,s0); e.pos[d]=startReelPos; }
  e.running=true; e.play=[true,true];
  e.setParams(Object.assign({},base,o));
  const L=new Float32Array(128),R=new Float32Array(128);
  const rmax=[1,1];
  let refills=0,bad=0,disc=0,prev=null,pk=0,starved=0;

  for(let blk=0; blk<blocks; blk++){
    e.render(L,R,128,null,null);
    for(let i=0;i<128;i++){ if(!isFinite(L[i]))bad++; const v=Math.abs(L[i]); if(v>pk)pk=v;
      if(prev!==null&&Math.abs(L[i]-prev)>0.4)disc++; prev=L[i]; }

    // ---- window policy, mirroring the host implementation
    for(const d of [0,1]){
      const wlen=e.buf[d].length;
      if (REEL <= wlen) continue;                                   // Rule 1
      const gLo=e.winGuard[d][0], gHi=e.winGuard[d][1];
      const g=e.pos[d], ws=e.winStart[d]+gLo, we=e.winStart[d]+wlen-gHi;
      const usable=we-ws;
      const ss=e.spliceS[d], sl=e.spliceL[d];
      if (g < ws || g >= we) starved++;                             // outside usable region
      if (sl <= usable){                                            // Rule 2
        if (ss < ws || ss+sl > we){ put(e,d, ss-(usable-sl)/2); refills++; }
        continue;
      }
      if (g < ws || g >= we){                                       // spool / wrap
        const fwd0=((o.rate||base.rate)[d])>=0;
        put(e,d, g-(fwd0?usable*0.25:usable*0.75)); refills++;
        continue;
      }
      const r=Math.abs((o.rate||base.rate)[d])||0.001;              // Rule 4
      rmax[d]=Math.max(r, rmax[d]*0.97);
      const margin=Math.max(MIN_MARGIN, rmax[d]*MIN_MARGIN)*sr;
      const fwd=((o.rate||base.rate)[d])>=0;                        // Rule 3
      const lead= fwd ? (we-g) : (g-ws);
      if (lead < margin){
        const behind = fwd ? usable*0.25 : usable*0.75;
        const st=Math.max(0,Math.min(REEL-WIN, Math.round(g-behind)));
        if(st!==e.winStart[d]+gLo){ put(e,d,st); refills++; }
      }
    }
  }
  // up to one block of starvation is the reel-wrap seam, see REEL.md
  const ok = bad===0 && disc===0 && starved<=4;
  console.log((ok?'  ok  ':'  FAIL')+' '+tag.padEnd(38),
    'refills',String(refills).padStart(4),'glitch',disc,'seam',starved,'bad',bad,
    'at',(e.pos[0]/REEL*100).toFixed(2)+'%');
  return ok;
}

console.log('6-hour reel, 5-minute window\n');
let all=true;
// Rule 2: a splice that fits should refill ONCE and then never again
all &= trial({loopStart:[0.5,0.5], loopLen:[20/(3600*HOURS),20/(3600*HOURS)]},
             REEL*0.5, 30000, 'Rule 2: 20s splice at 50%, 1x');
all &= trial({loopStart:[0.75,0.75], loopLen:[3/(3600*HOURS),3/(3600*HOURS)], rate:[0.25,0.25]},
             REEL*0.75, 30000, 'Rule 2: 3s splice at 75%, 0.25x');
all &= trial({loopStart:[0.9,0.9], loopLen:[45/(3600*HOURS),45/(3600*HOURS)], rate:[-2,-2]},
             REEL*0.9, 30000, 'Rule 2: 45s splice at 90%, -2x');
// Rule 3/4: whole-reel splice, streaming
all &= trial({rate:[1,1]}, REEL*0.1, 40000, 'Rule 3: whole reel, forward 1x');
all &= trial({rate:[-1,-1]}, REEL*0.5, 40000, 'Rule 3: whole reel, reverse 1x');
all &= trial({rate:[-0.5,-0.5]}, REEL*0.2, 40000, 'whole reel, reverse 0.5x');
all &= trial({rate:[4,4]}, REEL*0.3, 40000, 'Rule 4: scrub 4x forward');
all &= trial({rate:[-4,-4]}, REEL*0.6, 40000, 'Rule 4: scrub -4x reverse');
all &= trial({rate:[8,8]}, REEL*0.4, 40000, 'Rule 4: 8x forward');
// wrap at the ends
all &= trial({rate:[2,2]}, REEL-sr*30, 30000, 'wrap over reel end, loop');
all &= trial({rate:[-2,-2]}, sr*20, 30000, 'wrap under reel start, loop');
all &= trial({rate:[2,2],loop:[0,0]}, REEL-sr*20, 30000, 'one-shot stops at end');
// everything at once on a streamed reel
all &= trial({rate:[-0.5,-0.5],age:1,delay:0.6,reverb:0.6,gDens:[8,8],
              lfoDepth:[0.8,0.8],lfoDest:[1,1],gmSrc:1,gmDepth:0.8,gmDest:2},
             REEL*0.45, 40000, 'reverse 0.5x + everything on');
all &= trial({rate:[1,1], gDens:[10,10], gSize:[0.7,0.7], gSpray:[1,1]},
             REEL*0.2, 40000, 'grains across window swaps, whole reel');
all &= trial({rate:[-2,-2], gDens:[12,12], gSize:[0.9,0.9], gSpray:[1,1]},
             REEL*0.7, 40000, 'grains, reverse 2x, max size/spray');
all &= trial({loopStart:[0.33,0.33], loopLen:[30/(3600*HOURS),30/(3600*HOURS)],
              gDens:[12,12], gSpray:[1,1], rate:[0.25,0.25]},
             REEL*0.33, 40000, 'grains on a pinned 30s splice');
console.log('\n' + (all ? 'ALL PASS' : 'FAILURES ABOVE'));
