import bpy, bmesh, math
from mathutils import Vector

# clear earlier sheet/kit objects; hide everything else from render
for o in list(bpy.data.objects):
    if o.name.startswith('SH_'): bpy.data.objects.remove(o, do_unlink=True)
    else: o.hide_render = True; o.hide_viewport = True

def mat(name, kind, col=None, emit=None):
    m = bpy.data.materials.get(name) or bpy.data.materials.new(name)
    m.use_nodes = True; nt = m.node_tree; nt.nodes.clear()
    out = nt.nodes.new('ShaderNodeOutputMaterial'); b = nt.nodes.new('ShaderNodeBsdfPrincipled'); b.inputs['Roughness'].default_value = 0.85
    nt.links.new(b.outputs[0], out.inputs[0])
    tc = nt.nodes.new('ShaderNodeTexCoord'); geo = nt.nodes.new('ShaderNodeNewGeometry')
    nz = nt.nodes.new('ShaderNodeTexNoise'); nz.inputs['Scale'].default_value = 3.0; nz.inputs['Detail'].default_value = 6
    nt.links.new(tc.outputs['Object'], nz.inputs['Vector'])
    sep = nt.nodes.new('ShaderNodeSeparateXYZ'); nt.links.new(tc.outputs['Object'], sep.inputs[0])
    if kind == 'brick':
        def brick(vec_a, vec_b):
            cm = nt.nodes.new('ShaderNodeCombineXYZ')
            nt.links.new(vec_a, cm.inputs[0]); nt.links.new(vec_b, cm.inputs[1])
            br = nt.nodes.new('ShaderNodeTexBrick'); br.inputs['Color1'].default_value = (0.165, 0.175, 0.145, 1); br.inputs['Color2'].default_value = (0.115, 0.125, 0.10, 1)
            br.inputs['Mortar'].default_value = (0.03, 0.033, 0.027, 1); br.inputs['Scale'].default_value = 1.9; br.inputs['Mortar Size'].default_value = 0.025
            br.inputs['Mortar Smooth'].default_value = 0.1; br.inputs['Bias'].default_value = 0.0; br.inputs['Brick Width'].default_value = 0.6; br.inputs['Row Height'].default_value = 0.3
            nt.links.new(cm.outputs[0], br.inputs['Vector']); return br
        bxz = brick(sep.outputs['X'], sep.outputs['Z']); byz = brick(sep.outputs['Y'], sep.outputs['Z'])
        ab = nt.nodes.new('ShaderNodeVectorMath'); ab.operation = 'ABSOLUTE'; nt.links.new(geo.outputs['Normal'], ab.inputs[0])
        sp2 = nt.nodes.new('ShaderNodeSeparateXYZ'); nt.links.new(ab.outputs[0], sp2.inputs[0])
        st = nt.nodes.new('ShaderNodeMath'); st.operation = 'GREATER_THAN'; st.inputs[1].default_value = 0.5; nt.links.new(sp2.outputs['Y'], st.inputs[0])
        mx = nt.nodes.new('ShaderNodeMix'); mx.data_type = 'RGBA'; nt.links.new(st.outputs[0], mx.inputs[0])
        nt.links.new(byz.outputs['Color'], mx.inputs[6]); nt.links.new(bxz.outputs['Color'], mx.inputs[7])
        # tint variation + moss low and in cracks
        tint = nt.nodes.new('ShaderNodeValToRGB'); tint.color_ramp.elements[0].color = (0.75, 0.8, 0.7, 1); tint.color_ramp.elements[1].color = (1.1, 1.08, 1.0, 1)
        nt.links.new(nz.outputs['Fac'], tint.inputs[0])
        mul = nt.nodes.new('ShaderNodeMix'); mul.data_type = 'RGBA'; mul.blend_type = 'MULTIPLY'; mul.inputs[0].default_value = 1.0
        nt.links.new(mx.outputs[2], mul.inputs[6]); nt.links.new(tint.outputs[0], mul.inputs[7])
        nz2 = nt.nodes.new('ShaderNodeTexNoise'); nz2.inputs['Scale'].default_value = 5.5; nz2.inputs['Detail'].default_value = 5; nt.links.new(tc.outputs['Object'], nz2.inputs['Vector'])
        low = nt.nodes.new('ShaderNodeMapRange'); low.inputs['From Min'].default_value = 0.0; low.inputs['From Max'].default_value = 1.2; low.inputs['To Min'].default_value = 0.2; low.inputs['To Max'].default_value = -0.15
        nt.links.new(sep.outputs['Z'], low.inputs['Value'])
        add = nt.nodes.new('ShaderNodeMath'); add.operation = 'ADD'; nt.links.new(nz2.outputs['Fac'], add.inputs[0]); nt.links.new(low.outputs[0], add.inputs[1])
        mr = nt.nodes.new('ShaderNodeValToRGB'); mr.color_ramp.elements[0].position = 0.68; mr.color_ramp.elements[1].position = 0.78
        mr.color_ramp.elements[0].color = (0, 0, 0, 1); mr.color_ramp.elements[1].color = (1, 1, 1, 1); nt.links.new(add.outputs[0], mr.inputs[0])
        moss = nt.nodes.new('ShaderNodeMix'); moss.data_type = 'RGBA'; moss.inputs[7].default_value = (0.06, 0.12, 0.03, 1)
        nt.links.new(mr.outputs[0], moss.inputs[0]); nt.links.new(mul.outputs[2], moss.inputs[6]); nt.links.new(moss.outputs[2], b.inputs['Base Color'])
        height_src = byz.outputs['Fac']
    elif kind == 'stone':
        ramp = nt.nodes.new('ShaderNodeValToRGB'); ramp.color_ramp.elements[0].color = (0.15, 0.15, 0.13, 1); ramp.color_ramp.elements[1].color = (0.24, 0.235, 0.2, 1)
        nt.links.new(nz.outputs['Fac'], ramp.inputs[0]); nt.links.new(ramp.outputs[0], b.inputs['Base Color']); height_src = None
    else:
        b.inputs['Base Color'].default_value = col; height_src = None
    if emit: b.inputs['Emission Color'].default_value = emit; b.inputs['Emission Strength'].default_value = 1.6
    bev = nt.nodes.new('ShaderNodeBevel'); bev.inputs['Radius'].default_value = 0.012; bev.samples = 4
    nz3 = nt.nodes.new('ShaderNodeTexNoise'); nz3.inputs['Scale'].default_value = 50; nz3.inputs['Detail'].default_value = 6; nt.links.new(tc.outputs['Object'], nz3.inputs['Vector'])
    bmp = nt.nodes.new('ShaderNodeBump'); bmp.inputs['Strength'].default_value = 0.4; bmp.inputs['Distance'].default_value = 0.01
    nt.links.new(nz3.outputs['Fac'], bmp.inputs['Height']); nt.links.new(bev.outputs['Normal'], bmp.inputs['Normal'])
    if height_src is not None:   # recess mortar joints in the normal map
        b2 = nt.nodes.new('ShaderNodeBump'); b2.inputs['Strength'].default_value = 0.9; b2.inputs['Distance'].default_value = 0.012
        nt.links.new(height_src, b2.inputs['Height']); nt.links.new(bev.outputs['Normal'], b2.inputs['Normal']); nt.links.new(b2.outputs['Normal'], bmp.inputs['Normal'])
    nt.links.new(bmp.outputs['Normal'], b.inputs['Normal'])
    return m

BRICK = mat('SH_brick', 'brick'); STONE = mat('SH_stone', 'stone'); DARK = mat('SH_dark', 'plain', (0.03, 0.035, 0.03, 1))
TEAL = mat('SH_tealw', 'plain', (0.05, 0.6, 0.8, 1), emit=(0.05, 0.75, 1, 1))

objs = []; G = []
def fin(o, m, bevel=0.012):
    o.name = 'SH_' + o.name; o.data.materials.clear(); o.data.materials.append(m)
    if bevel:
        bv = o.modifiers.new('b', 'BEVEL'); bv.width = bevel; bv.segments = 1; bv.limit_method = 'ANGLE'
    bpy.ops.object.shade_smooth(); objs.append(o); return o
def box(sz, loc, m, bevel=0.012):
    bpy.ops.mesh.primitive_cube_add(size=1, location=loc); o = bpy.context.object; o.scale = sz
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True); return fin(o, m, bevel)
def cyl(r, h, loc, m, v=16, r2=None, bevel=0.008):
    bpy.ops.mesh.primitive_cone_add(vertices=v, radius1=r, radius2=r if r2 is None else r2, depth=h, location=loc); return fin(bpy.context.object, m, bevel)

# ---- 1. wall_pilaster_rune: 2.5 x 0.45 x 1.84, a brick panel with a carved pilaster and teal rune strip (front = -Y)
ox = -4.0
G.append(('wall_pilaster_rune', len(objs)))
box((2.5, 0.45, 0.16), (ox, 0, 0.08), STONE, 0.02)                    # plinth
box((2.44, 0.30, 1.54), (ox, 0.075, 0.93), BRICK, 0.012)               # brick panel (front face at y=-0.075)
box((2.5, 0.45, 0.14), (ox, 0, 1.77), STONE, 0.02)                    # cornice
box((2.46, 0.47, 0.03), (ox, 0, 1.69), STONE, 0.008)                  # cornice lip
for sx in (-1.18, 1.18): box((0.14, 0.38, 1.54), (ox + sx, 0.04, 0.93), STONE, 0.012)   # edge quoins
box((0.56, 0.15, 1.40), (ox, -0.15, 0.92), STONE, 0.012)               # pilaster shaft
box((0.70, 0.15, 0.12), (ox, -0.15, 0.22), STONE, 0.012)               # pilaster base
box((0.70, 0.15, 0.14), (ox, -0.15, 1.63), STONE, 0.012)               # capital
box((0.78, 0.15, 0.04), (ox, -0.15, 1.71), STONE, 0.008)
box((0.20, 0.03, 1.10), (ox, -0.232, 0.92), DARK, 0.004)               # carved groove
box((0.018, 0.03, 1.06), (ox, -0.2365, 0.92), TEAL, 0)                 # rune spine
for i in range(7):
    z = 0.48 + i * 0.145; w = 0.07 if i % 2 else 0.1
    box((w, 0.03, 0.035), (ox + (0.03 if i % 3 else -0.03), -0.2375, z), TEAL, 0)   # glyph ticks
for sx in (-0.78, 0.78):                                               # small teal studs flanking the pilaster
    for z in (0.5, 1.35): cyl(0.03, 0.04, (ox + sx, -0.08, z), TEAL, v=8, bevel=0).rotation_euler = (math.pi / 2, 0, 0)

# ---- 2. wall_corner_column: 0.45 x 0.45 x 1.84, an octagonal shaft with trim rings and rune glyphs
ox = 0.0
G.append(('wall_corner_column', len(objs)))
box((0.45, 0.45, 0.14), (ox, 0, 0.07), STONE, 0.02)
cyl(0.2, 0.05, (ox, 0, 0.165), STONE, v=8, bevel=0.006)
cyl(0.17, 1.42, (ox, 0, 0.9), BRICK, v=8, bevel=0.006)
cyl(0.195, 0.06, (ox, 0, 1.64), STONE, v=8, bevel=0.006)
box((0.45, 0.45, 0.14), (ox, 0, 1.77), STONE, 0.02)
for z in (0.62, 1.22): cyl(0.178, 0.035, (ox, 0, z), TEAL, v=8, bevel=0)  # teal rune rings
for ang in (0, math.pi / 2, math.pi, 3 * math.pi / 2):
    box((0.035, 0.012, 0.22), (ox + 0.172 * math.cos(ang) * 1.0, 0.172 * math.sin(ang), 0.92), TEAL, 0).rotation_euler = (0, 0, ang + math.pi / 2)

# ---- 3. wall_ledge_cap: 2.6 x 0.16 x 2.6 coping for the cut-down ledge walls
ox = 4.5
G.append(('wall_ledge_cap', len(objs)))
box((2.6, 2.6, 0.12), (ox, 0, 0.06), STONE, 0.03)
box((2.44, 2.44, 0.05), (ox, 0, 0.13), STONE, 0.02)                   # raised slab
box((2.30, 2.30, 0.02), (ox, 0, 0.16), DARK, 0.004)                   # inlay panel
box((2.12, 2.12, 0.02), (ox, 0, 0.175), STONE, 0.006)
for sx in (-1, 1):
    for sy in (-1, 1): cyl(0.05, 0.04, (ox + sx * 1.08, sy * 1.08, 0.2), TEAL, v=8, bevel=0)
for k in range(4):
    a = k * math.pi / 2
    box((0.5, 0.05, 0.022), (ox + 0.78 * math.cos(a), 0.78 * math.sin(a), 0.195), TEAL, 0).rotation_euler = (0, 0, a + math.pi / 2)
G.append(('END', len(objs)))

# ---- preview of the three pieces (kit sheet), game camera
W = bpy.data.worlds.get('SHW') or bpy.data.worlds.new('SHW'); W.use_nodes = True
W.node_tree.nodes['Background'].inputs[0].default_value = (0.09, 0.1, 0.13, 1); W.node_tree.nodes['Background'].inputs[1].default_value = 0.35; bpy.context.scene.world = W
bpy.ops.mesh.primitive_plane_add(size=30, location=(0, 0, -0.002)); g = bpy.context.object; g.name = 'SH_ground'
gm = bpy.data.materials.new('SH_gr'); gm.use_nodes = True; next(n for n in gm.node_tree.nodes if n.type == 'BSDF_PRINCIPLED').inputs['Base Color'].default_value = (0.1, 0.1, 0.12, 1); g.data.materials.append(gm)
def light(n, loc, e, col):
    d = bpy.data.lights.new('SH_' + n, 'SUN'); d.energy = e; d.color = col; d.angle = 0.2
    o = bpy.data.objects.new('SH_' + n, d); o.location = loc; bpy.context.collection.objects.link(o)
    o.rotation_euler = (Vector((0, 0, 0.5)) - Vector(loc)).to_track_quat('-Z', 'Y').to_euler()
light('key', (5, -12, 9), 2.4, (1, 0.88, 0.7)); light('fill', (-8, -4, 6), 0.9, (0.55, 0.75, 1))
cam = bpy.data.cameras.new('SH_cam'); cam.type = 'ORTHO'; cam.ortho_scale = 9.5
co = bpy.data.objects.new('SH_cam', cam); bpy.context.collection.objects.link(co)
tgt = Vector((0.2, 0, 0.8)); co.location = tgt + Vector((0.612, -0.612, 0.5)) * 25; co.rotation_euler = (tgt - co.location).to_track_quat('-Z', 'Y').to_euler()
sc = bpy.context.scene; sc.camera = co; sc.render.resolution_x = 1600; sc.render.resolution_y = 800
for eng in ('BLENDER_EEVEE_NEXT', 'BLENDER_EEVEE'):
    try: sc.render.engine = eng; break
    except TypeError: pass
sc.render.use_freestyle = False; sc.view_settings.view_transform = 'Standard'
sc.render.filepath = '/tmp/claude-1000/-var-home-jreyes/a94098e5-c8de-4644-b98e-d2231d75d65f/scratchpad/wallkit.png'
if not globals().get('NORENDER'): bpy.ops.render.render(write_still=True)
print('tris check below')
dg = bpy.context.evaluated_depsgraph_get()
for i in range(len(G) - 1):
    n, a = G[i]; b = G[i + 1][1]; t = 0
    for o in objs[a:b]:
        e = o.evaluated_get(dg); me = e.to_mesh(); me.calc_loop_triangles(); t += len(me.loop_triangles); e.to_mesh_clear()
    print(n, t)
