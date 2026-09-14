"""
Capybara mascot — sitting relaxed pose.
Built with subdivision-surface meshes (not primitive spheres) so shapes
are organic. Toon shading: flat base colour + dark outline via Solidify.
Animated: breathing (chest scale), idle head bob, ear twitch.
"""
import bpy, math
from mathutils import Vector, Matrix

# ── RESET ─────────────────────────────────────────────────────────────────────
bpy.ops.object.select_all(action='SELECT')
bpy.ops.object.delete(use_global=False)


# ── MATERIALS ─────────────────────────────────────────────────────────────────
def toon_mat(name, hex_color, roughness=1.0):
    """Flat diffuse — no specularity, pure base colour for toon look."""
    r = int(hex_color[1:3], 16) / 255
    g = int(hex_color[3:5], 16) / 255
    b = int(hex_color[5:7], 16) / 255
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    tree = m.node_tree
    tree.nodes.clear()
    out   = tree.nodes.new('ShaderNodeOutputMaterial')
    diff  = tree.nodes.new('ShaderNodeBsdfDiffuse')
    diff.inputs['Color'].default_value   = (r, g, b, 1.0)
    diff.inputs['Roughness'].default_value = roughness
    tree.links.new(diff.outputs['BSDF'], out.inputs['Surface'])
    return m

FUR       = toon_mat('Fur',      '#f9bfcc')   # Slowpoke bubblegum pink
FUR_DARK  = toon_mat('FurDark',  '#e8829a')   # medium rose shadow
BELLY     = toon_mat('Belly',    '#fff0f4')   # almost-white blush belly
DARK      = toon_mat('Dark',     '#4a1020')   # dark maroon eyes / nostrils
OUTLINE   = toon_mat('Outline',  '#2e0a15')   # dark maroon ink outline
CLAW      = toon_mat('Claw',     '#f5f0e8')   # cream-white claws / fangs


def outline_mod(obj, thickness=0.04):
    """Solidify modifier flipped = dark shell outside = cartoon ink outline."""
    mod = obj.modifiers.new('Outline', 'SOLIDIFY')
    mod.thickness          = thickness
    mod.offset             = 1.0
    mod.use_flip_normals   = True
    mod.use_even_offset    = True
    mod.material_offset    = len(obj.data.materials)   # extra slot
    obj.data.materials.append(OUTLINE)


def subdiv(obj, levels=2):
    mod = obj.modifiers.new('Sub', 'SUBSURF')
    mod.levels            = levels
    mod.render_levels     = levels
    mod.subdivision_type  = 'CATMULL_CLARK'
    bpy.ops.object.shade_smooth()


def make(name, verts, faces, mat, sub=2, outline_thick=0.035):
    mesh = bpy.data.meshes.new(name)
    mesh.from_pydata(verts, [], faces)
    mesh.update()
    obj = bpy.data.objects.new(name, mesh)
    bpy.context.collection.objects.link(obj)
    bpy.context.view_layer.objects.active = obj
    obj.select_set(True)
    obj.data.materials.append(mat)
    subdiv(obj, sub)
    outline_mod(obj, outline_thick)
    return obj


# ═══════════════════════════════════════════════════════════════════════════════
#  BODY  — upright rounded rectangle (sitting), taller than wide
#  Coordinate system: Z up, Y forward (towards camera = -Y)
# ═══════════════════════════════════════════════════════════════════════════════
# A cube stretched into a sitting-capybara torso shape, then subdiv smooths it.
# 8 verts of a box; subdiv rounds every edge naturally.
W, H, D = 0.90, 1.10, 0.70   # half-extents: width, height, depth
body_v = [
    # bottom ring (slightly narrower)
    (-W*0.75, -D*0.6,  0.00), ( W*0.75, -D*0.6,  0.00),
    ( W*0.75,  D*0.6,  0.00), (-W*0.75,  D*0.6,  0.00),
    # mid ring (widest — big belly)
    (-W,      -D*0.7,  H*0.45), ( W,      -D*0.7,  H*0.45),
    ( W,       D*0.5,  H*0.45), (-W,       D*0.5,  H*0.45),
    # upper ring (shoulder width, rounded top)
    (-W*0.80, -D*0.5,  H*0.90), ( W*0.80, -D*0.5,  H*0.90),
    ( W*0.80,  D*0.3,  H*0.90), (-W*0.80,  D*0.3,  H*0.90),
    # top cap
    (-W*0.45, -D*0.2,  H*1.10), ( W*0.45, -D*0.2,  H*1.10),
    ( W*0.45,  D*0.15, H*1.10), (-W*0.45,  D*0.15, H*1.10),
]
body_f = [
    (0,1,5,4),(1,2,6,5),(2,3,7,6),(3,0,4,7),    # mid sides
    (4,5,9,8),(5,6,10,9),(6,7,11,10),(7,4,8,11), # upper sides
    (8,9,13,12),(9,10,14,13),(10,11,15,14),(11,8,12,15), # top sides
    (0,3,2,1),   # bottom
    (12,13,14,15), # top cap
]
body = make('Body', body_v, body_f, FUR, sub=3, outline_thick=0.05)

# Belly patch — flattened sphere parented to body
bpy.ops.mesh.primitive_uv_sphere_add(segments=16, ring_count=10,
    location=(0, -D*0.85, H*0.40))
belly = bpy.context.object
belly.name = 'Belly'
belly.scale = (0.62, 0.18, 0.52)
bpy.ops.object.transform_apply(scale=True)
belly.data.materials.append(BELLY)
subdiv(belly, 2)

# ═══════════════════════════════════════════════════════════════════════════════
#  HEAD
# ═══════════════════════════════════════════════════════════════════════════════
# Wide flat box → subdiv = characteristic capybara rectangular head
HW, HH, HD = 0.68, 0.46, 0.58
head_v = [
    (-HW*0.7, -HD,     0.0),  ( HW*0.7, -HD,     0.0),
    ( HW*0.7,  HD*0.4, 0.0),  (-HW*0.7,  HD*0.4, 0.0),
    (-HW,     -HD*0.6, HH*0.5),( HW,    -HD*0.6, HH*0.5),
    ( HW,      HD*0.3, HH*0.5),(-HW,     HD*0.3, HH*0.5),
    (-HW*0.6, -HD*0.3, HH),   ( HW*0.6, -HD*0.3, HH),
    ( HW*0.6,  HD*0.2, HH),   (-HW*0.6,  HD*0.2, HH),
]
head_f = [
    (0,1,5,4),(1,2,6,5),(2,3,7,6),(3,0,4,7),
    (4,5,9,8),(5,6,10,9),(6,7,11,10),(7,4,8,11),
    (0,3,2,1),(8,9,10,11),
]
head_z = H*1.05
head = make('Head', head_v, head_f, FUR, sub=3, outline_thick=0.04)
head.location = (0, -D*0.3, head_z)

# ── MUZZLE ────────────────────────────────────────────────────────────────────
# The key capybara feature: a large DARK rectangular muzzle, not a pale disc.
# Wide, low, protrudes forward (–Y). Dark tan, not lighter than the body.
MW, MH, MD = 0.50, 0.28, 0.34
muz_v = [
    (-MW, -MD*1.0, 0.0), ( MW, -MD*1.0, 0.0),
    ( MW,  MD*0.3, 0.0), (-MW,  MD*0.3, 0.0),
    (-MW, -MD*0.8, MH),  ( MW, -MD*0.8, MH),
    ( MW,  MD*0.2, MH),  (-MW,  MD*0.2, MH),
]
muz_f = [
    (0,1,5,4),(1,2,6,5),(2,3,7,6),(3,0,4,7),(0,3,2,1),(4,5,6,7)
]
muzzle = make('Muzzle', muz_v, muz_f, BELLY, sub=3, outline_thick=0.035)
muzzle.location = (0, -D*0.3 - HD*0.85, head_z + 0.02)

# Nostrils
for sx in (-0.18, 0.18):
    bpy.ops.mesh.primitive_uv_sphere_add(segments=8, ring_count=6,
        location=(sx, -D*0.3 - HD*0.85 - MD*1.05, head_z + MH*0.55))
    n = bpy.context.object
    n.name = 'Nostril'
    n.scale = (0.055, 0.035, 0.048)
    bpy.ops.object.transform_apply(scale=True)
    n.data.materials.append(DARK)
    bpy.ops.object.shade_smooth()

# ── FANGS ─────────────────────────────────────────────────────────────────────
# Two big downward-pointing fangs peeking out from the lower jaw.
# Placed at the bottom edge of the muzzle, slightly inside, curving forward.
fang_base_y = -D*0.3 - HD*0.85 - MD*0.2
fang_base_z = head_z + 0.01   # just below muzzle bottom
for sx in (-0.18, 0.18):
    bpy.ops.mesh.primitive_cone_add(vertices=8, radius1=0.055, radius2=0.004,
        depth=0.20,
        location=(sx, fang_base_y, fang_base_z))
    fang = bpy.context.object
    fang.name = 'Fang'
    fang.rotation_euler = (math.radians(-10), 0, 0)   # slight forward tilt
    fang.data.materials.append(CLAW)
    bpy.ops.object.shade_smooth()

# ── EYES ──────────────────────────────────────────────────────────────────────
# Half-closed content eyes — the reference has soft squinted eyes.
# Simple dark ellipses, slightly to the sides of the head top.
for sx in (-0.36, 0.36):
    bpy.ops.mesh.primitive_uv_sphere_add(segments=10, ring_count=8,
        location=(sx, -D*0.3 - HD*0.5, head_z + HH*0.72))
    e = bpy.context.object
    e.name = 'Eye'
    e.scale = (0.08, 0.04, 0.06)
    bpy.ops.object.transform_apply(scale=True)
    e.data.materials.append(DARK)
    bpy.ops.object.shade_smooth()
    # highlight
    bpy.ops.mesh.primitive_uv_sphere_add(segments=6, ring_count=4,
        location=(sx - 0.02, -D*0.3 - HD*0.58, head_z + HH*0.78))
    sh = bpy.context.object
    sh.name = 'Shine'
    sh.scale = (0.018, 0.010, 0.016)
    bpy.ops.object.transform_apply(scale=True)
    sh_m = toon_mat(f'Shine{sx}', '#e8e8e8')
    sh.data.materials.append(sh_m)
    bpy.ops.object.shade_smooth()

# ── EARS ──────────────────────────────────────────────────────────────────────
# Small rounded ears — UV sphere squashed into a flat disc shape,
# sitting inside the head top silhouette. No custom mesh = no spike issues.
for sx in (-0.40, 0.40):
    bpy.ops.mesh.primitive_uv_sphere_add(segments=10, ring_count=8,
        location=(sx, -D*0.3 - HD*0.08, head_z + HH*0.94))
    ear = bpy.context.object
    ear.name = 'Ear'
    ear.scale = (0.13, 0.07, 0.14)   # flat disc, taller than wide in Z
    bpy.ops.object.transform_apply(scale=True)
    ear.data.materials.append(FUR_DARK)
    subdiv(ear, 2)
    outline_mod(ear, 0.025)
    # inner ear
    bpy.ops.mesh.primitive_uv_sphere_add(segments=8, ring_count=6,
        location=(sx, -D*0.3 - HD*0.10, head_z + HH*0.95))
    ei = bpy.context.object
    ei.name = 'EarInner'
    ei.scale = (0.065, 0.018, 0.07)
    bpy.ops.object.transform_apply(scale=True)
    ei.data.materials.append(BELLY)
    bpy.ops.object.shade_smooth()

# ── HAUNCHES ──────────────────────────────────────────────────────────────────
# Sitting capybara: two big round haunches splayed to the sides on the ground.
for sx in (-0.78, 0.78):
    bpy.ops.mesh.primitive_uv_sphere_add(segments=14, ring_count=10,
        location=(sx, D*0.2, 0.28))
    h = bpy.context.object
    h.name = 'Haunch'
    h.scale = (0.38, 0.42, 0.36)
    bpy.ops.object.transform_apply(scale=True)
    h.data.materials.append(FUR)
    subdiv(h, 2)
    outline_mod(h, 0.04)
    # foot / paw at the end
    bpy.ops.mesh.primitive_uv_sphere_add(segments=10, ring_count=8,
        location=(sx * 1.1, D*0.55, 0.10))
    p = bpy.context.object
    p.name = 'HindPaw'
    p.scale = (0.20, 0.30, 0.10)
    bpy.ops.object.transform_apply(scale=True)
    p.data.materials.append(FUR_DARK)
    subdiv(p, 2)
    outline_mod(p, 0.03)
    # hind claws — three small cones fanning forward from the paw
    for ci, cx_off in enumerate((-0.07, 0.0, 0.07)):
        bpy.ops.mesh.primitive_cone_add(vertices=6, radius1=0.035, radius2=0.004,
            depth=0.12,
            location=(sx * 1.1 + cx_off, D*0.55 + 0.14, 0.03))
        cl = bpy.context.object
        cl.name = f'HindClaw{ci}'
        cl.rotation_euler = (math.radians(80), 0, 0)
        cl.data.materials.append(CLAW)
        bpy.ops.object.shade_smooth()

# ── FRONT ARMS / PAWS ─────────────────────────────────────────────────────────
# Short stubby arms folded across the belly — the relaxed crossed-arm pose.
for sx in (-1, 1):
    bpy.ops.mesh.primitive_uv_sphere_add(segments=10, ring_count=8,
        location=(sx * 0.38, -D*0.82, H*0.30))
    a = bpy.context.object
    a.name = 'Arm'
    a.scale = (0.20, 0.14, 0.16)
    bpy.ops.object.transform_apply(scale=True)
    a.data.materials.append(FUR)
    subdiv(a, 2)
    outline_mod(a, 0.03)
    # paw
    bpy.ops.mesh.primitive_uv_sphere_add(segments=10, ring_count=8,
        location=(sx * 0.18, -D*0.95, H*0.22))
    paw = bpy.context.object
    paw.name = 'FrontPaw'
    paw.scale = (0.18, 0.13, 0.10)
    bpy.ops.object.transform_apply(scale=True)
    paw.data.materials.append(FUR_DARK)
    subdiv(paw, 2)
    outline_mod(paw, 0.025)
    # front claws — three small cones curling downward off the paw edge
    for ci, cx_off in enumerate((-0.06, 0.0, 0.06)):
        bpy.ops.mesh.primitive_cone_add(vertices=6, radius1=0.032, radius2=0.003,
            depth=0.10,
            location=(sx * 0.18 + cx_off, -D*0.95 - 0.11, H*0.22 - 0.04))
        cl = bpy.context.object
        cl.name = f'FrontClaw{ci}'
        cl.rotation_euler = (math.radians(100), 0, 0)
        cl.data.materials.append(CLAW)
        bpy.ops.object.shade_smooth()

# ── GROUND SHADOW ─────────────────────────────────────────────────────────────
bpy.ops.mesh.primitive_circle_add(vertices=32, radius=0.9, location=(0, 0.05, 0.001))
shadow = bpy.context.object
shadow.name = 'Shadow'
shadow.scale = (1.0, 0.7, 1.0)
bpy.ops.object.transform_apply(scale=True)
bpy.ops.object.convert(target='MESH')
shadow_m = toon_mat('Shadow', '#2e0a15')
shadow_m.blend_method = 'BLEND'
# Make it semi-transparent
shadow_m.node_tree.nodes.clear()
out  = shadow_m.node_tree.nodes.new('ShaderNodeOutputMaterial')
mix  = shadow_m.node_tree.nodes.new('ShaderNodeMixShader')
tr   = shadow_m.node_tree.nodes.new('ShaderNodeBsdfTransparent')
diff = shadow_m.node_tree.nodes.new('ShaderNodeBsdfDiffuse')
diff.inputs['Color'].default_value = (0.05, 0.02, 0.01, 1)
mix.inputs['Fac'].default_value = 0.55
shadow_m.node_tree.links.new(tr.outputs['BSDF'],   mix.inputs[1])
shadow_m.node_tree.links.new(diff.outputs['BSDF'], mix.inputs[2])
shadow_m.node_tree.links.new(mix.outputs['Shader'], out.inputs['Surface'])
shadow.data.materials.append(shadow_m)

# ═══════════════════════════════════════════════════════════════════════════════
#  ANIMATION  — 60 fps, 120 frame idle loop
# ═══════════════════════════════════════════════════════════════════════════════
scene = bpy.context.scene
scene.frame_start = 1
scene.frame_end   = 120
scene.render.fps  = 24

def keyf(obj, frame, data_path, value):
    setattr(obj, data_path, value) if '.' not in data_path else None
    obj.keyframe_insert(data_path=data_path, frame=frame)

# Breathing: body Z scale pulses slowly (1 cycle = 120 frames ≈ 5 s)
for frame, sz in [(1, 1.0), (30, 1.025), (60, 1.0), (90, 0.980), (120, 1.0)]:
    body.scale = (1.0, 1.0, sz)
    body.keyframe_insert(data_path='scale', frame=frame)
# Head bob: subtle nod up and down
for frame, hz in [(1, head_z), (20, head_z+0.02), (60, head_z-0.015), (90, head_z+0.01), (120, head_z)]:
    head.location = (0, head.location.y, hz)
    head.keyframe_insert(data_path='location', frame=frame)

# ═══════════════════════════════════════════════════════════════════════════════
#  LIGHTING
# ═══════════════════════════════════════════════════════════════════════════════
for name, loc, energy, size in [
    ('Key',  (-2.5, -4.0, 5.0), 900, 3.0),
    ('Fill', ( 3.0, -1.5, 3.0), 500, 2.5),
    ('Rim',  ( 0.0,  3.0, 4.0), 600, 2.0),
]:
    bpy.ops.object.light_add(type='AREA', location=loc)
    lt = bpy.context.object
    lt.name = name
    lt.data.energy = energy
    lt.data.shape  = 'DISK'
    lt.data.size   = size
    lt.rotation_euler = (Vector((0, 0, H*0.55)) - lt.location).to_track_quat('-Z','Y').to_euler()

# ═══════════════════════════════════════════════════════════════════════════════
#  CAMERA
# ═══════════════════════════════════════════════════════════════════════════════
bpy.ops.object.camera_add(location=(-0.3, -4.8, 1.55))
cam = bpy.context.object
cam.name = 'Camera'
cam.data.lens = 62
cam.rotation_euler = (Vector((0, 0, H*0.55)) - cam.location).to_track_quat('-Z','Y').to_euler()
scene.camera = cam

# ═══════════════════════════════════════════════════════════════════════════════
#  RENDER / EXPORT
# ═══════════════════════════════════════════════════════════════════════════════
scene.render.engine               = 'BLENDER_EEVEE'
scene.render.resolution_x         = 512
scene.render.resolution_y         = 512
scene.render.film_transparent      = True
scene.world.color                  = (0.18, 0.16, 0.18)   # neutral grey tinted slightly pink

BASE = '/Users/javierbritopacheco/codebase/capy-mascot/assets/capybara'
bpy.ops.wm.save_as_mainfile(filepath=BASE + '.blend')
bpy.ops.export_scene.gltf(
    filepath=BASE + '.glb',
    export_format='GLB',
    export_apply=True,
    export_animations=True,
)
print('CAPYBARA_EXPORTED')
