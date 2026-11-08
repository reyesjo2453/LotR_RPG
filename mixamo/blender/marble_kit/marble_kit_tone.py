import json, struct, io, sys, shutil, os
import numpy as np
from PIL import Image
ENV='/var/home/jreyes/LotR_RPG/public/assets/env'; BK='/tmp/claude-1000/-var-home-jreyes/a94098e5-c8de-4644-b98e-d2231d75d65f/scratchpad/glb_pretone'
os.makedirs(BK, exist_ok=True)
TINT=np.array([0.76,0.69,0.58]); GOLD_DIM=0.9
def grade(img, strength):
    a=np.asarray(img.convert('RGB'),dtype=np.float32)/255.0
    mx=a.max(2); mn=a.min(2); sat=(mx-mn)/np.maximum(mx,1e-4)
    m=np.clip((0.38-sat)/0.2,0,1)*np.clip((mx-0.30)/0.2,0,1)*strength     # neutral light stone
    tinted=a*TINT[None,None,:]
    # keep some dark/crack contrast: slight gamma on the tinted result
    tinted=np.power(np.clip(tinted,0,1),1.08)
    out=a*(1-m[...,None])+tinted*m[...,None]
    gold=((a[...,0]>a[...,1])&(a[...,1]>a[...,2])&(sat>0.45)&(mx>0.3))
    out=np.where(gold[...,None],out*GOLD_DIM,out)
    return Image.fromarray((np.clip(out,0,1)*255+0.5).astype(np.uint8))
def process(name, strength):
    p=f'{ENV}/{name}.glb'; d=open(p,'rb').read()
    shutil.copy(p, f'{BK}/{name}.glb') if not os.path.exists(f'{BK}/{name}.glb') else None
    d=open(f'{BK}/{name}.glb','rb').read()          # always grade from the untouched original
    jl=struct.unpack('<I',d[12:16])[0]; j=json.loads(d[20:20+jl]); off=20+jl+8
    bl=struct.unpack('<I',d[20+jl:24+jl])[0]; bn=d[off:off+bl]
    mat=j['materials'][0]['pbrMetallicRoughness']['baseColorTexture']['index']; src=j['textures'][mat]['source']; bvi=j['images'][src]['bufferView']
    bv=j['bufferViews'][bvi]; jpg=bn[bv.get('byteOffset',0):bv.get('byteOffset',0)+bv['byteLength']]
    im=Image.open(io.BytesIO(jpg)); g=grade(im,strength); buf=io.BytesIO(); g.save(buf,'JPEG',quality=90); newj=buf.getvalue()
    parts=[]; pos=0
    for i,v in enumerate(j['bufferViews']):
        b=newj if i==bvi else bn[v.get('byteOffset',0):v.get('byteOffset',0)+v['byteLength']]
        pad=(-len(b))%4; v['byteOffset']=pos; v['byteLength']=len(b); parts.append(b+b'\0'*pad); pos+=len(b)+pad
    j['buffers'][0]['byteLength']=pos; nb=b''.join(parts)
    js=json.dumps(j,separators=(',',':')).encode(); js+=b' '*((-len(js))%4)
    out=b'glTF'+struct.pack('<II',2,12+8+len(js)+8+len(nb))+struct.pack('<I',len(js))+b'JSON'+js+struct.pack('<I',len(nb))+b'BIN\0'+nb
    open(p,'wb').write(out); print(name,len(d)//1024,'->',len(out)//1024,'KB')
for n in ['marble_wall','marble_window','marble_column_spiral','marble_pedestal','marble_floor_tile','marble_stairs','marble_chest','lotus_shrine','rune_monolith']: process(n,1.0)
process('stone_dais',0.6)
