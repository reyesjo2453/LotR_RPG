"""Attach two copies of a sword GLB to the hand bones of a rigged character GLB (headless Blender).

blender -b -P scripts/attach_swords.py -- <rigged.glb> <sword.glb> <out.glb> [--length 0.28] [--grip 0.18]
        [--rot "rx,ry,rz"] [--preview out.png]

--length  blade+hilt length in model units (character is ~0.6 tall)
--grip    fraction along the sword (from the pommel end) held in the fist
--rot     extra euler degrees applied in bone space (tune so the blade points forward)
"""
import math, os, sys
import bpy
from mathutils import Euler, Vector

argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
def opt(flag, default):
    if flag in argv:
        i = argv.index(flag); v = argv[i + 1]; del argv[i:i + 2]; return v
    return default
length = float(opt("--length", 0.28)); grip = float(opt("--grip", 0.18))
rot = [math.radians(float(x)) for x in opt("--rot", "-90,0,0").split(",")]
preview = opt("--preview", None)
if len(argv) < 3:
    sys.exit(__doc__)
char, sword = [os.path.abspath(a) for a in argv[:2]]
out = argv[2] if argv[2] == "none" else os.path.abspath(argv[2])

bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=char)
arm = next(o for o in bpy.data.objects if o.type == "ARMATURE")
before = set(bpy.data.objects)
bpy.ops.import_scene.gltf(filepath=sword)
new = [o for o in bpy.data.objects if o not in before]
smesh = next(o for o in new if o.type == "MESH")
# detach from import hierarchy, bake transforms
bpy.ops.object.select_all(action="DESELECT")
smesh.select_set(True); bpy.context.view_layer.objects.active = smesh
bpy.ops.object.parent_clear(type="CLEAR_KEEP_TRANSFORM")
for o in new:
    if o is not smesh:
        bpy.data.objects.remove(o, do_unlink=True)
bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)

# normalise: long axis -> +Z, pommel at the bottom, scaled to `length`, origin at the grip point
dims = smesh.dimensions
axis = max(range(3), key=lambda i: dims[i])
if axis != 2:
    smesh.rotation_euler = Euler((math.radians(90), 0, 0) if axis == 1 else (0, math.radians(-90), 0))
    bpy.ops.object.transform_apply(rotation=True)
s = length / smesh.dimensions.z
smesh.scale = (s, s, s); bpy.ops.object.transform_apply(scale=True)
zs = [v.co.z for v in smesh.data.vertices]; zmin, zmax = min(zs), max(zs)
xs = [v.co.x for v in smesh.data.vertices]; ys = [v.co.y for v in smesh.data.vertices]
off = Vector(((min(xs) + max(xs)) / 2, (min(ys) + max(ys)) / 2, zmin + grip * (zmax - zmin)))
for v in smesh.data.vertices:
    v.co -= off
smesh.name = "sword"

def attach(bone_name, mirror):
    o = smesh.copy(); o.data = smesh.data.copy(); o.name = "sword_" + bone_name.split(":")[-1]
    bpy.context.collection.objects.link(o)
    o.parent = arm; o.parent_type = "BONE"; o.parent_bone = bone_name
    o.matrix_parent_inverse.identity()
    # bone-parented objects sit at the bone TAIL; shift back to the head
    b = arm.data.bones[bone_name]
    o.location = (0, -(b.tail_local - b.head_local).length, 0)
    r = Euler((rot[0], rot[1], -rot[2] if mirror else rot[2]))
    o.rotation_mode = "XYZ"; o.rotation_euler = r
    return o
attach("mixamorig:RightHand", False)
attach("mixamorig:LeftHand", True)
bpy.data.objects.remove(smesh, do_unlink=True)
for o in [o for o in bpy.data.objects if o.name.startswith("Icosphere")]:
    bpy.data.objects.remove(o, do_unlink=True)  # importer's bone-shape helper, not part of the model

if os.environ.get('SWORD_DEBUG'):
    bpy.context.scene.frame_set(1)
    bpy.context.view_layer.update()
    for o in bpy.data.objects:
        if o.name.startswith('sword'):
            print('DBG rot',tuple(o.rotation_euler),o.rotation_mode,o.parent_type,o.parent_bone)
            c=[o.matrix_world@Vector(v) for v in o.bound_box]
            print('DBG',o.name,[tuple(round(x,3) for x in c[i]) for i in (0,6)],'scale',tuple(round(x,3) for x in o.matrix_world.to_scale()))
    print('DBG arm scale',tuple(arm.matrix_world.to_scale()), 'hand',tuple(round(x,3) for x in (arm.matrix_world@arm.pose.bones['mixamorig:RightHand'].head)))

if preview:
    sc = bpy.context.scene
    sc.frame_set(1)
    cam = bpy.data.objects.new("cam", bpy.data.cameras.new("cam")); bpy.context.collection.objects.link(cam)
    cam.data.type = "ORTHO"; cam.data.ortho_scale = 0.9
    sc.camera = cam
    l = bpy.data.objects.new("l", bpy.data.lights.new("l", "SUN")); bpy.context.collection.objects.link(l)
    sc.render.engine = "BLENDER_WORKBENCH"
    sc.display.shading.light = "STUDIO"; sc.display.shading.color_type = "TEXTURE"
    sc.render.resolution_x = 700; sc.render.resolution_y = 700
    base, ext = os.path.splitext(os.path.abspath(preview))
    for tag, loc, rot_ in (("front", (0, -2, 0.3), (90, 0, 0)), ("side", (2, 0, 0.3), (90, 0, 90))):
        cam.location = loc; cam.rotation_euler = [math.radians(x) for x in rot_]
        sc.render.filepath = f"{base}_{tag}{ext}"
        bpy.ops.render.render(write_still=True)

if out != "none":
    bpy.ops.export_scene.gltf(filepath=out, export_format="GLB", export_skins=True, export_animations=True,
                              export_animation_mode="ACTIONS", export_yup=True)
    print("[swords] wrote", out)
