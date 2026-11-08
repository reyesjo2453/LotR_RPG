import bpy, bmesh, math
from mathutils import Vector

# clear previous sheet + hide others from render
for o in list(bpy.data.objects):
    if o.name.startswith('SH_'):
        bpy.data.objects.remove(o, do_unlink=True)
    else:
        o.hide_render = True; o.hide_viewport = True

def mat(name, col, rough=0.7, emit=None, kind='plain'):
    m = bpy.data.materials.get(name) or bpy.data.materials.new(name)
    m.use_nodes = True
    nt = m.node_tree; nt.nodes.clear()
    out = nt.nodes.new('ShaderNodeOutputMaterial')
    b = nt.nodes.new('ShaderNodeBsdfPrincipled')
    b.inputs['Roughness'].default_value = rough
    nt.links.new(b.outputs[0], out.inputs[0])
    if kind == 'marble':
        tc = nt.nodes.new('ShaderNodeTexCoord')
        n = nt.nodes.new('ShaderNodeTexNoise'); n.inputs['Scale'].default_value = 2.2; n.inputs['Detail'].default_value = 6
        v = nt.nodes.new('ShaderNodeTexVoronoi'); v.feature = 'DISTANCE_TO_EDGE'; v.inputs['Scale'].default_value = 0.5
        v.inputs['Randomness'].default_value = 1.0
        nt.links.new(tc.outputs['Object'], n.inputs['Vector']); nt.links.new(tc.outputs['Object'], v.inputs['Vector'])
        cr = nt.nodes.new('ShaderNodeValToRGB')   # thin crack lines
        cr.color_ramp.elements[0].position = 0.0; cr.color_ramp.elements[0].color = (0.45, 0.52, 0.62, 1)
        cr.color_ramp.elements[1].position = 0.010; cr.color_ramp.elements[1].color = (1, 1, 1, 1)
        nt.links.new(v.outputs['Distance'], cr.inputs[0])
        tint = nt.nodes.new('ShaderNodeValToRGB')  # soft cool/warm cloud
        tint.color_ramp.elements[0].color = (0.80, 0.84, 0.90, 1); tint.color_ramp.elements[1].color = (0.97, 0.96, 0.94, 1)
        nt.links.new(n.outputs['Fac'], tint.inputs[0])
        mul = nt.nodes.new('ShaderNodeMix'); mul.data_type = 'RGBA'; mul.blend_type = 'MULTIPLY'; mul.inputs[0].default_value = 1.0
        nt.links.new(tint.outputs[0], mul.inputs[6]); nt.links.new(cr.outputs[0], mul.inputs[7])
        nt.links.new(mul.outputs[2], b.inputs['Base Color'])
        crack_ramp = cr
    else:
        b.inputs['Base Color'].default_value = col
    if kind == 'gold':
        b.inputs['Metallic'].default_value = 0.6
    if emit:
        b.inputs['Emission Color'].default_value = emit; b.inputs['Emission Strength'].default_value = 1.6
    tc2 = nt.nodes.new('ShaderNodeTexCoord')
    bev = nt.nodes.new('ShaderNodeBevel'); bev.inputs['Radius'].default_value = 0.012; bev.samples = 4
    nz2 = nt.nodes.new('ShaderNodeTexNoise'); nz2.inputs['Scale'].default_value = 55; nz2.inputs['Detail'].default_value = 6
    nt.links.new(tc2.outputs['Object'], nz2.inputs['Vector'])
    bump1 = nt.nodes.new('ShaderNodeBump'); bump1.inputs['Strength'].default_value = 0.35; bump1.inputs['Distance'].default_value = 0.01
    nt.links.new(nz2.outputs['Fac'], bump1.inputs['Height'])
    if kind == 'marble':
        bump2 = nt.nodes.new('ShaderNodeBump'); bump2.inputs['Strength'].default_value = 0.8; bump2.inputs['Distance'].default_value = 0.02
        nt.links.new(crack_ramp.outputs[0], bump2.inputs['Height']); nt.links.new(bev.outputs['Normal'], bump2.inputs['Normal'])
        nt.links.new(bump2.outputs['Normal'], bump1.inputs['Normal'])
        rr = nt.nodes.new('ShaderNodeValToRGB'); rr.color_ramp.elements[0].color=(0.35,0.35,0.35,1); rr.color_ramp.elements[1].color=(0.62,0.62,0.62,1)
        nt.links.new(nz2.outputs['Fac'], rr.inputs[0]); nt.links.new(rr.outputs[0], b.inputs['Roughness'])
    else:
        nt.links.new(bev.outputs['Normal'], bump1.inputs['Normal'])
    nt.links.new(bump1.outputs['Normal'], b.inputs['Normal'])
    return m

MARBLE = mat('SH_marble', None, 0.55, kind='marble')
GOLD = mat('SH_gold', (0.72, 0.5, 0.14, 1), 0.35, kind='gold')
GREY = mat('SH_grey', (0.45, 0.5, 0.58, 1), 0.7)
TEAL = mat('SH_teal', (0.05, 0.6, 0.8, 1), 0.3, emit=(0.05, 0.75, 1, 1))
GLASS = mat('SH_glass', (0.1, 0.12, 0.15, 1), 0.4)
MOSS = mat('SH_moss', (0.2, 0.32, 0.1, 1), 0.9)
VINE = mat('SH_vine', (0.32, 0.3, 0.08, 1), 0.9)

objs = []
G = []
def fin(o, m, bevel=0.012, smooth=True):
    o.name = 'SH_' + o.name
    o.data.materials.clear(); o.data.materials.append(m)
    if bevel:
        bv = o.modifiers.new('b', 'BEVEL'); bv.width = bevel; bv.segments = 2; bv.limit_method = 'ANGLE'
    if smooth: bpy.ops.object.shade_smooth()
    objs.append(o); return o

def box(sz, loc, m, rot=(0,0,0), bevel=0.012):
    bpy.ops.mesh.primitive_cube_add(size=1, location=loc, rotation=rot)
    o = bpy.context.object; o.scale = sz
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    return fin(o, m, bevel)
def cyl(r, h, loc, m, v=24, r2=None, bevel=0.01):
    bpy.ops.mesh.primitive_cone_add(vertices=v, radius1=r, radius2=r if r2 is None else r2, depth=h, location=loc)
    return fin(bpy.context.object, m, bevel)
def sph(r, loc, m, sc=(1,1,1), seg=20):
    bpy.ops.mesh.primitive_uv_sphere_add(segments=seg, ring_count=12, radius=r, location=loc)
    o = bpy.context.object; o.scale = sc
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    return fin(o, m, 0)
def tor(R, r, loc, m, rot=(0,0,0)):
    bpy.ops.mesh.primitive_torus_add(major_radius=R, minor_radius=r, major_segments=32, minor_segments=8, location=loc, rotation=rot)
    return fin(bpy.context.object, m, 0)


def curve(pts, m, depth=0.03, cyc=False):
    cu = bpy.data.curves.new('c','CURVE'); cu.dimensions='3D'; cu.bevel_depth=depth; cu.bevel_resolution=1
    sp = cu.splines.new('POLY'); sp.points.add(len(pts)-1)
    for p,v in zip(sp.points,pts): p.co=(v[0],v[1],v[2],1)
    sp.use_cyclic_u = cyc
    o = bpy.data.objects.new('SH_curve',cu); bpy.context.collection.objects.link(o); o.data.materials.append(m); objs.append(o); return o

import mathutils
def petal(m, L, W, theta, a, base, cup=1.0, bend=0.3, sxy=(1,1), nu=3, nv=5, thick=0.01, tip=0.9):
    """Curved pointed petal. local: X across, Y outward, Z along petal (up). theta = lean from vertical."""
    R = mathutils.Matrix.Rotation(a-math.pi/2,3,'Z') @ mathutils.Matrix.Rotation(-theta,3,'X')
    bm = bmesh.new(); grid=[]
    for j in range(nv+1):
        v=j/nv; w = W*2.0*(max(v,1e-4)**0.5)*((1-v)**tip) if j<nv else 0.0
        row=[]
        for i in range(nu+1):
            u=-1+2*i/nu
            if j==nv and i>0: row.append(row[0]); continue
            x=u*w; y=-cup*(x*x)*(1.0/max(W,1e-3))*0.9 + bend*L*v*v; z=v*L
            p=R@mathutils.Vector((x,y,z)); p=mathutils.Vector((p.x*sxy[0],p.y*sxy[1],p.z))+mathutils.Vector(base)
            row.append(bm.verts.new(p))
        grid.append(row)
    for j in range(nv):
        for i in range(nu):
            vs=[grid[j][i],grid[j][i+1],grid[j+1][i+1],grid[j+1][i]]
            vs=list(dict.fromkeys(vs))
            if len(vs)>=3:
                try: bm.faces.new(vs)
                except ValueError: pass
    me=bpy.data.meshes.new('petal'); bm.to_mesh(me); bm.free()
    o=bpy.data.objects.new('petal',me); bpy.context.collection.objects.link(o)
    bpy.context.view_layer.objects.active=o; o.select_set(True)
    sm=o.modifiers.new('s','SOLIDIFY'); sm.thickness=thick; sm.offset=0
    return fin(o,m,0)
S = 3.6
def at(i, j): return (i*S, -j*S)

G.append(('marble_wall', len(objs)))
# 1 wall segment: slab, cap, base, swooping gold bands + V flourish
x, y = at(-1, 0)
box((2.5,0.45,0.14),(x,y,0.07),MARBLE); box((2.4,0.3,1.45),(x,y,0.86),MARBLE)
box((2.56,0.5,0.14),(x,y,1.77),MARBLE); box((2.56,0.51,0.03),(x,y,1.69),GOLD)
fy = y-0.16
def sag(z0, amp, n=30): return [(x-1.2+2.4*i/n, fy, z0 - amp*math.sin(math.pi*i/n)) for i in range(n+1)]
curve(sag(1.42,0.28),GOLD,0.04); curve(sag(0.62,0.22),GOLD,0.04)
curve([(x,fy,0.98),(x+0.14,fy,0.84),(x,fy,0.7),(x-0.14,fy,0.84),(x,fy,0.98)],GREY,0.014)
box((0.1,0.31,0.06),(x,fy+0.02,0.85),GREY,(0,0,0),0.005)

G.append(('marble_window', len(objs)))
# 2 gothic window
x, y = at(0, 0)
box((0.42,0.46,1.7),(x-1.05,y,0.85),MARBLE); box((0.42,0.46,1.7),(x+1.05,y,0.85),MARBLE)
for sx in (-1.05,1.05):
    box((0.52,0.52,0.1),(x+sx,y,1.75),MARBLE); box((0.5,0.5,0.1),(x+sx,y,0.05),MARBLE); box((0.46,0.5,0.04),(x+sx,y,0.12),GOLD)
box((2.5,0.45,0.1),(x,y,0.05),MARBLE)
R=1.2; zs=0.55; hw=0.7; cx=hw-R
th=math.acos(-(R-hw)/R)
L=[(x-hw,y-0.12,0.12),(x-hw,y-0.12,zs)]
for i in range(1,21):
    a=math.pi-(math.pi-th)*i/20; L.append((x+cx*-1*-1 + R*math.cos(a) + (R-hw)*0 + 0.0 if False else x+(-cx)*-1*-1*0 + (hw-R)*-1*-1*0 + R*math.cos(a)+ (R-hw), y-0.12, zs+R*math.sin(a)))
Lp=[(px-(R-hw)+ (R-hw) , py, pz) for px,py,pz in L]
# left arc centre = x+(R-hw) ; right arc mirror
left=[(x+(R-hw)+R*math.cos(math.pi-(math.pi-th)*i/20), y-0.12, zs+R*math.sin(math.pi-(math.pi-th)*i/20)) for i in range(0,21)]
right=[(2*x-px, py, pz) for (px,py,pz) in reversed(left)]
outline=[(x-hw,y-0.12,0.15)]+left+right[1:]+[(x+hw,y-0.12,0.15)]
curve(outline,GOLD,0.06)
# glass
bm=bmesh.new(); vs=[bm.verts.new((px,y-0.02,pz)) for px,py,pz in outline]; bm.faces.new(vs)
me=bpy.data.meshes.new('gl'); bm.to_mesh(me); bm.free(); o=bpy.data.objects.new('SH_glass',me); bpy.context.collection.objects.link(o); o.data.materials.append(GLASS); objs.append(o)
# tracery: mullions + two sub-arches + oculus
for dx in (-0.35,0,0.35):
    top=zs+math.sqrt(max(R*R-((abs(dx)+hw-R)*(1 if True else 1))**2,0.01))*0.0
    hgt=0.18+ (1.35 if dx==0 else 1.1 if abs(dx)<0.4 else 1.0)
    curve([(x+dx,y-0.1,0.15),(x+dx,y-0.1,min(hgt,1.45))],GOLD,0.025)
for sx in (-1,1):
    cc=x+sx*0.18; arc=[(cc+sx*0.17*math.cos(math.pi*i/20), y-0.1, 1.05+0.35*math.sin(math.pi*i/20)) for i in range(21)]
    curve(arc,GOLD,0.02)
curve([(x+0.1*math.cos(2*math.pi*i/16), y-0.1, 1.38+0.1*math.sin(2*math.pi*i/16)) for i in range(17)],GOLD,0.02)
box((1.5,0.14,0.07),(x,y-0.04,0.13),GOLD)

G.append(('marble_column_spiral', len(objs)))
# 3 spiral column with carved gold band
x, y = at(1, 0)
cyl(0.3,0.15,(x,y,0.075),MARBLE,v=8); cyl(0.22,1.5,(x,y,0.9),MARBLE,v=20)
cyl(0.3,0.1,(x,y,1.7),MARBLE,v=8); box((0.62,0.62,0.12),(x,y,1.82),MARBLE); box((0.64,0.64,0.03),(x,y,1.75),GOLD)
for k in range(2):
    a = k*math.pi
    pts=[(x+0.225*math.cos(a+t*5.2), y+0.225*math.sin(a+t*5.2), 0.28+t*1.3) for t in [i/36 for i in range(37)]]
    curve(pts,GOLD,0.05)
    pts=[(x+0.225*math.cos(a+math.pi/2+t*5.2), y+0.225*math.sin(a+math.pi/2+t*5.2), 0.28+t*1.3) for t in [i/36 for i in range(37)]]
    curve(pts,GREY,0.02)
cyl(0.27,0.07,(x,y,0.2),GOLD,v=20); cyl(0.27,0.07,(x,y,1.62),GOLD,v=20); cyl(0.3,0.04,(x,y,0.3),GOLD,v=20)

G.append(('marble_pedestal', len(objs)))
# 4 pedestal column (gold capital)
x, y = at(-1, 1)
cyl(0.35,0.1,(x,y,0.05),MARBLE); cyl(0.3,0.1,(x,y,0.15),MARBLE); cyl(0.14,1.1,(x,y,0.75),MARBLE)
cyl(0.2,0.07,(x,y,1.3),GOLD); cyl(0.16,0.07,(x,y,1.0),GOLD); cyl(0.2,0.06,(x,y,0.3),GOLD)
cyl(0.18,0.2,(x,y,1.43),GOLD,r2=0.4,v=4); bpy.context.object.rotation_euler[2]=math.pi/4
bpy.ops.object.transform_apply(location=False,rotation=True,scale=False)
box((0.8,0.8,0.07),(x,y,1.57),GOLD,bevel=0.02); cyl(0.2,0.12,(x,y,1.45),MARBLE,r2=0.14)
for dx,dy in ((1,0),(-1,0),(0,1),(0,-1)): sph(0.07,(x+dx*0.32,y+dy*0.32,1.5),GOLD,(1,1,1.6))

G.append(('marble_floor_tile', len(objs)))
# 5 floor tile: overlapping circle grooves + teal rune corners
x, y = at(0, 1)
bm = bmesh.new()
pts = [(-1.25,-1.25),(1.25,-1.25),(1.25,1.25),(-1.25,1.25)]
vs = [bm.verts.new((px,py,0)) for px,py in pts]; f = bm.faces.new(vs)
r = bmesh.ops.extrude_face_region(bm, geom=[f])
for v in [e for e in r['geom'] if isinstance(e, bmesh.types.BMVert)]: v.co.z = 0.1
me = bpy.data.meshes.new('tile'); bm.to_mesh(me); bm.free()
o = bpy.data.objects.new('tile', me); bpy.context.collection.objects.link(o); o.location=(x,y,0)
bpy.context.view_layer.objects.active=o; o.select_set(True)
bpy.ops.object.shade_flat(); fin(o, MARBLE, 0.02)
for ox,oy,rr in ((0.62,0,0.62),(-0.62,0,0.62),(0,0.62,0.62),(0,-0.62,0.62)):
    curve([(x+ox+rr*math.cos(2*math.pi*i/32), y+oy+rr*math.sin(2*math.pi*i/32), 0.1) for i in range(33)],GREY,0.022,True)
curve([(x+0.5*math.cos(math.pi/4+2*math.pi*i/8), y+0.5*math.sin(math.pi/4+2*math.pi*i/8), 0.11) for i in range(9)],TEAL,0.012)
for k in range(4):
    a=k*math.pi/2+math.pi/4
    for d in (-0.14,0,0.14):
        box((0.12,0.025,0.02),(x+1.0*math.cos(a)+d*-math.sin(a)*1.0, y+1.0*math.sin(a)+d*math.cos(a), 0.11),TEAL,(0,0,a+1.57),bevel=0)
tor(0.12,0.02,(x,y,0.11),TEAL)

G.append(('marble_stairs', len(objs)))
# 6 stairs with railings
x, y = at(1, 1)
for i in range(4):
    box((1.6,0.5,0.14*(i+1)+0.02),(x,y-0.5*(i-1.5)*-1,(0.14*(i+1)+0.02)/2),MARBLE,bevel=0.02)
for sx in (-0.85,0.85):
    box((0.12,2.0,0.1),(x+sx,y,0.1),MARBLE)
    box((0.07,2.15,0.07),(x+sx,y,0.85),GOLD,(math.atan(0.28),0,0))
    for k in range(6):
        yy = y - 0.85 + k*0.34
        top = 0.85+0.28*(yy-y); h = top-0.15
        box((0.04,0.04,h),(x+sx,yy,0.15+h/2),GOLD)
    box((0.14,0.14,1.2),(x+sx,y+1.0,0.6),MARBLE); box((0.14,0.14,0.8),(x+sx,y-1.0,0.4),MARBLE)

G.append(('marble_chest', len(objs)))
# 7 chest with petal lid
x, y = at(-1, 2)
box((1.0,0.65,0.45),(x,y,0.3),MARBLE); box((1.06,0.7,0.08),(x,y,0.07),GOLD); box((1.06,0.7,0.06),(x,y,0.52),GOLD)
for sx in (-0.5,0.5):
    for sy in (-0.32,0.32): box((0.07,0.07,0.5),(x+sx,y+sy,0.3),GOLD)
box((1.01,0.05,0.05),(x,y-0.34,0.38),TEAL,bevel=0)
for sx in (-0.3,0.3):
    box((0.2,0.04,0.3),(x+sx,y-0.34,0.3),GOLD,bevel=0.01); box((0.11,0.045,0.2),(x+sx,y-0.355,0.3),TEAL,bevel=0)
sph(0.5,(x,y,0.55),MARBLE,(0.93,0.60,0.30),seg=24)
for k in range(8):
    a_=k*2*math.pi/8
    petal(MARBLE,0.56,0.17,1.4,a_,(x,y,0.78),cup=0.9,bend=0.8,sxy=(0.88,0.58),thick=0.018,nu=3,nv=5,tip=0.55)
for k in range(6):
    a_=k*2*math.pi/6+math.pi/6
    petal(MARBLE,0.36,0.14,1.15,a_,(x,y,0.83),cup=1.0,bend=0.6,sxy=(0.8,0.55),thick=0.018,nu=3,nv=5,tip=0.55)
sph(0.08,(x,y,0.77),GOLD,(1,1,0.7))

G.append(('lotus_shrine', len(objs)))
# 8 lotus in vines
x, y = at(0, 2)
cyl(0.5,0.1,(x,y,0.05),MOSS,v=24,bevel=0); sph(0.45,(x,y,0.08),MOSS,(1,1,0.35))
for ph,rr in ((0,0.55),(2.1,0.5),(4.2,0.58)):
    curve([(x+(rr+0.06*math.sin(5*t))*math.cos(ph+t*5.0), y+(rr+0.06*math.sin(5*t))*math.sin(ph+t*5.0), 0.1+0.09*abs(math.sin(7*t))) for t in [i/24 for i in range(25)]],VINE,0.045)
for ph in (0.7,3.0,5.3):   # curling tendrils
    curve([(x+0.5*math.cos(ph)+0.12*math.sin(t*9)*math.sin(ph), y+0.5*math.sin(ph)-0.12*math.sin(t*9)*math.cos(ph), 0.12+0.28*t) for t in [i/20 for i in range(21)]],VINE,0.022)
for ph,pr in ((1.3,0.38),(3.9,0.4),(5.6,0.34)):   # lily pads
    cyl(0.14,0.015,(x+0.56*math.cos(ph)*(pr/0.4)*1.0,y+0.56*math.sin(ph)*(pr/0.4),0.13),MOSS,v=10,bevel=0)
for n,th,L,W,rb,zb,cup,bend in [(5,1.0,0.36,0.09,0.12,0.1,1.2,0.2),(8,0.72,0.42,0.09,0.08,0.12,1.4,0.35),(6,0.42,0.42,0.085,0.05,0.14,1.5,0.3),(4,0.16,0.34,0.075,0.025,0.17,1.6,0.2)]:
    for k in range(n):
        a_=k*2*math.pi/n+th*0.7
        petal(TEAL,L,W,th,a_,(x+rb*math.cos(a_),y+rb*math.sin(a_),zb),cup=cup,bend=bend,thick=0.008,nu=2,nv=5,tip=0.5)
sph(0.045,(x,y,0.26),TEAL)

G.append(('rune_monolith', len(objs)))
# 9 monolith
x, y = at(1, 2)
cyl(0.55,0.12,(x,y,0.06),MARBLE,v=8); cyl(0.42,0.1,(x,y,0.17),MARBLE,v=8); cyl(0.5,0.05,(x,y,0.12),GREY,v=8)
box((0.38,0.38,1.05),(x-0.12,y,0.8),MARBLE,(0,0.06,0.05)); box((0.34,0.38,0.95),(x+0.2,y,0.75),MARBLE,(0,-0.05,-0.04))
sph(0.17,(x,y-0.2,0.7),TEAL,(0.6,0.4,1.5)); box((0.08,0.3,0.6),(x+0.03,y-0.06,0.7),GLASS,bevel=0)
tor(0.46,0.022,(x,y,0.215),TEAL)
sph(0.05,(x,y-0.2,1.15),TEAL,(0.5,0.4,1.2))

G.append(('END', len(objs)))
# join nothing (keep editable); lights + camera + render
for o in objs:
    pass
W = bpy.data.worlds.new('SHW') if 'SHW' not in bpy.data.worlds else bpy.data.worlds['SHW']
W.use_nodes = True; W.node_tree.nodes['Background'].inputs[0].default_value = (0.09,0.1,0.13,1); W.node_tree.nodes['Background'].inputs[1].default_value = 0.25
bpy.context.scene.world = W
bpy.ops.mesh.primitive_plane_add(size=22, location=(0,-3.6,-0.001)); g = bpy.context.object; g.name='SH_ground'
g.data.materials.append(mat('SH_ground', (0.13,0.14,0.18,1), 0.9))
def light(n, kind, loc, e, col):
    d = bpy.data.lights.new('SH_'+n, kind); d.energy = e; d.color = col
    o = bpy.data.objects.new('SH_'+n, d); o.location = loc; bpy.context.collection.objects.link(o)
    o.rotation_euler = (Vector((0,-3.6,0.5)) - Vector(loc)).to_track_quat('-Z','Y').to_euler(); return o
light('key','SUN',(5,-12,9),2.2,(1,0.9,0.7)); bpy.data.lights['SH_key'].angle = 0.2
light('fill','SUN',(-8,-4,6),1.0,(0.55,0.75,1));
cam = bpy.data.cameras.new('SH_cam'); cam.type='ORTHO'; cam.ortho_scale = 13.5
co = bpy.data.objects.new('SH_cam', cam); bpy.context.collection.objects.link(co)
tgt = Vector((0,-2.6,0.5)); co.location = tgt + Vector((0.612,-0.612,0.5))*25
co.rotation_euler = (tgt-co.location).to_track_quat('-Z','Y').to_euler()
sc = bpy.context.scene; sc.camera = co
sc.render.resolution_x = 1600; sc.render.resolution_y = 1000
for eng in ('BLENDER_EEVEE_NEXT','BLENDER_EEVEE'):
    try: sc.render.engine = eng; break
    except TypeError: pass
sc.render.use_freestyle = True
vl = sc.view_layers[0]; vl.use_freestyle = True
ls = vl.freestyle_settings.linesets[0] if vl.freestyle_settings.linesets else vl.freestyle_settings.linesets.new('l')
if ls.linestyle is None: ls.linestyle = bpy.data.linestyles.new('SH_line')
ls.linestyle.color =(0.05,0.05,0.08); ls.linestyle.thickness = 1.6
sc.view_settings.view_transform = 'Standard'
sc.render.filepath = '/tmp/claude-1000/-var-home-jreyes/a94098e5-c8de-4644-b98e-d2231d75d65f/scratchpad/sheet.png'
if not globals().get('NORENDER'): bpy.ops.render.render(write_still=True)
print('done', sc.render.engine)
