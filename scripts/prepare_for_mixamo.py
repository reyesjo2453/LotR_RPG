"""Prepare a Trellis GLB/glTF for Mixamo auto-rigging (headless Blender).

blender -b -P scripts/prepare_for_mixamo.py -- <input.glb|gltf> <output_dir> [--name vaelen]

Output: <output_dir>/<name>.fbx, <output_dir>/textures/*.png, <output_dir>/<name>_for_mixamo.zip
"""
import os, sys, zipfile
import bpy
from mathutils import Vector

argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
name = None
if "--name" in argv:
    i = argv.index("--name"); name = argv[i + 1]; del argv[i:i + 2]
if len(argv) < 2:
    sys.exit("usage: blender -b -P prepare_for_mixamo.py -- <input> <output_dir> [--name NAME]")
src, out_dir = os.path.abspath(argv[0]), os.path.abspath(argv[1])
name = name or os.path.splitext(os.path.basename(src))[0]
tex_dir = os.path.join(out_dir, "textures")
os.makedirs(tex_dir, exist_ok=True)

# 1. clean scene + import
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=src)  # glTF importer already maps +Z-forward -> Blender -Y

meshes = [o for o in bpy.context.scene.objects if o.type == "MESH"]
if not meshes:
    sys.exit("no mesh found in input")

# 2. flatten hierarchy, drop empties, apply transforms
bpy.ops.object.select_all(action="DESELECT")
for o in meshes:
    o.select_set(True)
bpy.context.view_layer.objects.active = meshes[0]
bpy.ops.object.parent_clear(type="CLEAR_KEEP_TRANSFORM")
for o in [o for o in bpy.context.scene.objects if o.type != "MESH"]:
    bpy.data.objects.remove(o, do_unlink=True)
bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)

# 3. feet to origin: bbox center on X/Y, lowest point at Z=0
pts = [o.matrix_world @ Vector(c) for o in meshes for c in o.bound_box]
mn = Vector((min(p.x for p in pts), min(p.y for p in pts), min(p.z for p in pts)))
mx = Vector((max(p.x for p in pts), max(p.y for p in pts), max(p.z for p in pts)))
shift = Vector((-(mn.x + mx.x) / 2, -(mn.y + mx.y) / 2, -mn.z))
for o in meshes:
    o.location += shift
bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
print(f"[prepare] height={mx.z - mn.z:.3f} shift={tuple(round(v, 3) for v in shift)}")

# 4. extract textures
tex_files = []
for img in bpy.data.images:
    if img.type != "IMAGE" or img.name in ("Render Result", "Viewer Node"):
        continue
    if not (img.has_data or img.packed_file or img.filepath):
        continue
    base = "".join(c if c.isalnum() or c in "-_." else "_" for c in os.path.splitext(img.name)[0]) or "texture"
    path = os.path.join(tex_dir, base + ".png")
    img.filepath_raw = path
    img.file_format = "PNG"
    img.save()
    tex_files.append(path)
print("[prepare] textures:", tex_files)

# 5. FBX export (mesh only, textures copied + embedded)
fbx = os.path.join(out_dir, name + ".fbx")
bpy.ops.object.select_all(action="SELECT")
bpy.ops.export_scene.fbx(
    filepath=fbx, use_selection=True, object_types={"MESH"},
    path_mode="COPY", embed_textures=True,
    axis_forward="-Z", axis_up="Y", apply_unit_scale=True, apply_scale_options="FBX_SCALE_ALL",
    bake_space_transform=True, add_leaf_bones=False,
)

# 6. zip for Mixamo
zpath = os.path.join(out_dir, f"{name}_for_mixamo.zip")
with zipfile.ZipFile(zpath, "w", zipfile.ZIP_DEFLATED) as z:
    z.write(fbx, os.path.basename(fbx))
    for t in tex_files:
        z.write(t, "textures/" + os.path.basename(t))
print("[prepare] wrote", zpath)
