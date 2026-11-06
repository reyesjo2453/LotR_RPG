"""Convert a Mixamo-rigged FBX into a game-ready GLB (headless Blender).

blender -b -P scripts/mixamo_to_game_glb.py -- <rigged.fbx> [--name vaelen] [--textures DIR] [--out FILE]

Defaults: textures DIR = <fbx dir>/textures, out = public/assets/models/<name>.glb
"""
import glob, os, sys
import bpy

argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
def opt(flag, default=None):
    if flag in argv:
        i = argv.index(flag); v = argv[i + 1]; del argv[i:i + 2]; return v
    return default
name = opt("--name"); tex_dir = opt("--textures"); out = opt("--out")
if not argv:
    sys.exit("usage: blender -b -P mixamo_to_game_glb.py -- <rigged.fbx> [--name N] [--textures DIR] [--out FILE]")
fbx = os.path.abspath(argv[0])
name = name or os.path.splitext(os.path.basename(fbx))[0].lower()
tex_dir = os.path.abspath(tex_dir or os.path.join(os.path.dirname(fbx), "textures"))
root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
out = os.path.abspath(out or os.path.join(root, "public", "assets", "models", name + ".glb"))
os.makedirs(os.path.dirname(out), exist_ok=True)

bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.fbx(filepath=fbx, automatic_bone_orientation=True, ignore_leaf_bones=True)

arms = [o for o in bpy.context.scene.objects if o.type == "ARMATURE"]
meshes = [o for o in bpy.context.scene.objects if o.type == "MESH"]
if not arms:
    print("[game] WARNING: no armature found - exporting static mesh")

# bake FBX unit scale / rotation into the data
bpy.ops.object.select_all(action="SELECT")
bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)

# reconnect textures to Principled BSDF
imgs = sorted(glob.glob(os.path.join(tex_dir, "*.png")) + glob.glob(os.path.join(tex_dir, "*.jpg")))
def pick(mat):
    for p in imgs:
        if os.path.splitext(os.path.basename(p))[0].lower() in mat.name.lower():
            return p
    return imgs[0] if imgs else None
for o in meshes:
    if not o.data.materials:
        o.data.materials.append(bpy.data.materials.new(name + "_mat"))
    for mat in o.data.materials:
        mat.use_nodes = True
        nt = mat.node_tree
        bsdf = next((n for n in nt.nodes if n.type == "BSDF_PRINCIPLED"), None) or nt.nodes.new("ShaderNodeBsdfPrincipled")
        if not any(n.type == "OUTPUT_MATERIAL" for n in nt.nodes):
            nt.links.new(bsdf.outputs["BSDF"], nt.nodes.new("ShaderNodeOutputMaterial").inputs["Surface"])
        path = pick(mat)
        if not path:
            continue
        tex = next((n for n in nt.nodes if n.type == "TEX_IMAGE"), None) or nt.nodes.new("ShaderNodeTexImage")
        tex.image = bpy.data.images.load(path, check_existing=True)
        tex.image.colorspace_settings.name = "sRGB"
        nt.links.new(tex.outputs["Color"], bsdf.inputs["Base Color"])
        print(f"[game] {mat.name} <- {os.path.basename(path)}")

# push each action onto its own NLA track
for a in arms:
    ad = a.animation_data
    if ad and ad.action:
        act = ad.action
        track = ad.nla_tracks.new(); track.name = act.name or name
        track.strips.new(act.name, int(act.frame_range[0]), act)
        ad.action = None

bpy.ops.export_scene.gltf(
    filepath=out, export_format="GLB", use_selection=False,
    export_skins=True, export_materials="EXPORT", export_image_format="AUTO",
    export_animations=True, export_animation_mode="NLA_TRACKS", export_force_sampling=True,
    export_yup=True,
)
print("[game] wrote", out)
