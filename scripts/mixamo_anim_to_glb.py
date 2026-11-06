"""Convert a Mixamo animation FBX into an animation-only GLB (headless Blender).

blender -b -P scripts/mixamo_anim_to_glb.py -- <anim.fbx> <clipName> [--out FILE]
Default out: public/assets/models/vaelen.<clipName>.glb  (clip is named <clipName>)
"""
import os, sys
import bpy

argv = sys.argv[sys.argv.index("--") + 1:]
out = None
if "--out" in argv:
    i = argv.index("--out"); out = argv[i + 1]; del argv[i:i + 2]
fbx, clip = os.path.abspath(argv[0]), argv[1]
root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
out = os.path.abspath(out or os.path.join(root, "public", "assets", "models", f"vaelen.{clip}.glb"))

bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.fbx(filepath=fbx, automatic_bone_orientation=True, ignore_leaf_bones=True)
for o in list(bpy.context.scene.objects):
    if o.type != "ARMATURE":
        bpy.data.objects.remove(o, do_unlink=True)
arm = next(o for o in bpy.context.scene.objects if o.type == "ARMATURE")
bpy.ops.object.select_all(action="SELECT")
bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
act = arm.animation_data.action
act.name = clip
f0, f1 = act.frame_range
bpy.context.scene.frame_start, bpy.context.scene.frame_end = int(f0), int(f1)
bpy.ops.export_scene.gltf(filepath=out, export_format="GLB", export_animations=True,
    export_animation_mode="ACTIVE_ACTIONS", export_force_sampling=True, export_skins=True, export_apply=False)
print(f"[anim] {clip}: {(f1-f0)/bpy.context.scene.render.fps:.2f}s -> {out}")
