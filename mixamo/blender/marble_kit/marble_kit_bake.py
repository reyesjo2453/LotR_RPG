import bpy, math, os, numpy as np, mathutils
from mathutils import Vector
REPO="/var/home/jreyes/LotR_RPG"; SP="/tmp/claude-1000/-var-home-jreyes/a94098e5-c8de-4644-b98e-d2231d75d65f/scratchpad"
def bake_piece(ID):
    idx=[g[0] for g in G].index(ID); parts=objs[G[idx][1]:G[idx+1][1]]
    for o in bpy.data.objects: o.hide_render = True if o.name.startswith('SH_') else o.hide_render
    for o in parts: o.hide_render=False
    bpy.ops.object.select_all(action='DESELECT')
    for o in parts: o.hide_viewport=False; o.select_set(True)
    bpy.context.view_layer.objects.active=parts[0]
    bpy.ops.object.duplicate()
    dup=list(bpy.context.selected_objects)
    for o in parts: o.hide_render=True
    for o in dup: o.hide_render=False
    bpy.ops.object.convert(target='MESH')
    bpy.ops.object.join()
    ob=bpy.context.object; ob.name=ID; ob.data.name=ID
    for m in ob.modifiers: ob.modifiers.remove(m)
    ob.hide_render=False
    bb=[ob.matrix_world@Vector(c) for c in ob.bound_box]
    ob.data.transform(ob.matrix_world); ob.matrix_world=mathutils.Matrix.Identity(4)
    co=np.empty(len(ob.data.vertices)*3,dtype=np.float32); ob.data.vertices.foreach_get('co',co); co=co.reshape(-1,3)
    mn,mx=co.min(axis=0),co.max(axis=0)
    ob.data.transform(mathutils.Matrix.Translation((-(mn[0]+mx[0])/2,-(mn[1]+mx[1])/2,-mn[2])))
    ob.data.update()
    bpy.ops.object.mode_set(mode='EDIT'); bpy.ops.mesh.select_all(action='SELECT')
    bpy.ops.mesh.remove_doubles(threshold=0.0001)
    bpy.ops.uv.smart_project(angle_limit=math.radians(66),island_margin=0.01)
    bpy.ops.uv.pack_islands(margin=0.008)
    bpy.ops.object.mode_set(mode='OBJECT')
    sc=bpy.context.scene; sc.render.engine='CYCLES'; sc.cycles.device='CPU'; sc.cycles.samples=64
    imgs={}
    for k in ('col','emi','ao','nor','rou'):
        imgs[k]=bpy.data.images.new(f"{ID}_{k}",1024,1024)
        if k in ('nor','rou'): imgs[k].colorspace_settings.name='Non-Color'
    def run(kind, bt):
        for m in ob.data.materials:
            nt=m.node_tree
            for n in [n for n in nt.nodes if n.type=='TEX_IMAGE']: nt.nodes.remove(n)
            n=nt.nodes.new('ShaderNodeTexImage'); n.image=imgs[kind]; nt.nodes.active=n
        bk=sc.render.bake; bk.margin=12
        if bt=='DIFFUSE': bk.use_pass_direct=False; bk.use_pass_indirect=False; bk.use_pass_color=True
        bpy.ops.object.bake(type=bt)
    run('col','DIFFUSE'); run('emi','EMIT'); run('ao','AO')
    sc.cycles.samples=24; sc.render.bake.normal_space='TANGENT'
    run('nor','NORMAL'); run('rou','ROUGHNESS')
    for m in ob.data.materials:
        for n in [n for n in m.node_tree.nodes if n.type=='TEX_IMAGE']: m.node_tree.nodes.remove(n)
    def arr(i):
        a=np.empty(1024*1024*4,dtype=np.float32); i.pixels.foreach_get(a); return a.reshape(-1,4)
    c,e,a=arr(imgs['col']),arr(imgs['emi']),arr(imgs['ao'])
    ao=0.4+0.6*np.clip(a[:,0:1],0,1)               # stylised AA: mild baked AO
    out=c.copy(); out[:,:3]=c[:,:3]*ao
    em=np.clip(e[:,:3]*0.9,0,1); mask=(em.max(axis=1,keepdims=True)>0.05)
    out[:,:3]=np.where(mask,np.maximum(out[:,:3],em),out[:,:3]); out[:,3]=1
    fin_img=bpy.data.images.new(ID+"_base",1024,1024); fin_img.pixels.foreach_set(out.ravel()); 
    fin_img.filepath_raw=SP+"/"+ID+"_base.png"; fin_img.file_format='PNG'; fin_img.save(); fin_img.pack()
    ro=arr(imgs['rou'])[:,0]; mx=c[:,:3].max(axis=1); mn=c[:,:3].min(axis=1); sat=(mx-mn)/np.maximum(mx,1e-4)
    gold=(c[:,0]>c[:,1])&(c[:,1]>c[:,2])&(sat>0.5)&(mx>0.35)
    orm=np.ones((1024*1024,4),dtype=np.float32); orm[:,1]=np.clip(ro,0.05,1); orm[:,2]=np.where(gold,0.85,0.0)
    orm[:,1]=np.where(gold,np.minimum(orm[:,1],0.35),orm[:,1])
    orm_img=bpy.data.images.new(ID+"_orm",1024,1024); orm_img.colorspace_settings.name='Non-Color'; orm_img.pixels.foreach_set(orm.ravel()); orm_img.pack()
    nor_img=imgs['nor']; nor_img.name=ID+"_normal"; nor_img.pack()
    imgs.pop('nor')
    for k in imgs.values(): bpy.data.images.remove(k)
    fm=bpy.data.materials.new(ID); fm.use_nodes=True; nt=fm.node_tree
    b=next(n for n in nt.nodes if n.type=='BSDF_PRINCIPLED')
    t=nt.nodes.new('ShaderNodeTexImage'); t.image=fin_img; nt.links.new(t.outputs['Color'],b.inputs['Base Color'])
    o2=nt.nodes.new('ShaderNodeTexImage'); o2.image=orm_img; sp=nt.nodes.new('ShaderNodeSeparateColor')
    nt.links.new(o2.outputs['Color'],sp.inputs['Color']); nt.links.new(sp.outputs['Green'],b.inputs['Roughness']); nt.links.new(sp.outputs['Blue'],b.inputs['Metallic'])
    n2=nt.nodes.new('ShaderNodeTexImage'); n2.image=nor_img; nm=nt.nodes.new('ShaderNodeNormalMap')
    nt.links.new(n2.outputs['Color'],nm.inputs['Color']); nt.links.new(nm.outputs['Normal'],b.inputs['Normal'])
    ob.data.materials.clear(); ob.data.materials.append(fm)
    for p in ob.data.polygons: p.material_index=0
    bpy.ops.object.shade_smooth()
    tris=sum(len(p.vertices)-2 for p in ob.data.polygons)
    co=np.empty(len(ob.data.vertices)*3,dtype=np.float32); ob.data.vertices.foreach_get('co',co); co=co.reshape(-1,3); bb=[Vector(v) for v in (co.min(axis=0),co.max(axis=0))]; print('BB',co.min(axis=0).round(3),co.max(axis=0).round(3))
    outp=REPO+"/public/assets/env/"+ID+".glb"
    assert not os.path.exists(outp), outp
    bpy.ops.object.select_all(action='DESELECT'); ob.select_set(True); bpy.context.view_layer.objects.active=ob
    bpy.ops.export_scene.gltf(filepath=outp,export_format='GLB',use_selection=True,export_yup=True,export_apply=True,export_image_format='JPEG',export_jpeg_quality=88,export_materials='EXPORT')
    ob.location=(40+len(os.listdir(SP))%7,0,0)   # park the baked result away from the sheet
    print(ID,"TRIS",tris,"SIZE",[round(bb[1][i]-bb[0][i],3) for i in range(3)],"GLB",os.path.getsize(outp))
