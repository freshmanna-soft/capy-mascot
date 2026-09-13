import bpy
from mathutils import Vector

bpy.ops.object.select_all(action='SELECT')
bpy.ops.object.delete(use_global=False)


def mat(name, color, roughness=0.82):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    b = m.node_tree.nodes.get('Principled BSDF')
    b.inputs['Base Color'].default_value = (*color, 1.0)
    b.inputs['Roughness'].default_value = roughness
    return m


fur    = mat('Fur',    (0.42, 0.26, 0.13))
fur_lt = mat('FurLt',  (0.60, 0.42, 0.24))
muz_m  = mat('Muzzle', (0.52, 0.34, 0.18))  # closer to fur, not so pale
dark_m = mat('Dark',   (0.025, 0.015, 0.010), 0.25)
feet_m = mat('Feet',   (0.28, 0.14, 0.07))


def sphere(name, loc, scale, m, seg=22, rings=14):
    bpy.ops.mesh.primitive_uv_sphere_add(segments=seg, ring_count=rings, location=loc)
    o = bpy.context.object
    o.name = name
    o.scale = scale
    bpy.ops.object.transform_apply(scale=True)
    o.data.materials.append(m)
    bpy.ops.object.shade_smooth()
    return o


def box(name, loc, scale, m, bevel=0.10):
    bpy.ops.mesh.primitive_cube_add(location=loc)
    o = bpy.context.object
    o.name = name
    o.scale = scale
    bpy.ops.object.transform_apply(scale=True)
    o.data.materials.append(m)
    mod = o.modifiers.new('b', 'BEVEL')
    mod.width = bevel
    mod.segments = 5
    bpy.context.view_layer.objects.active = o
    bpy.ops.object.modifier_apply(modifier=mod.name)
    bpy.ops.object.shade_smooth()
    return o


# ── BODY ──────────────────────────────────────────────────────────────────────
# Very elongated barrel. Y is depth (front-back), Z is height.
sphere('Body', (0.0,  0.05, 1.05), (1.08, 1.60, 0.70), fur, 28, 16)
# Belly lighter patch
sphere('Belly', (0.0, 0.10, 0.56), (0.74, 1.15, 0.22), fur_lt, 22, 10)

# ── HEAD+MUZZLE as ONE form ───────────────────────────────────────────────────
# Key insight: don't separate head and muzzle — make them one merged blob.
# Head is a wide, low ellipsoid pushed forward over the body front.
# The "muzzle" is just a wider, lower extension of that same ellipsoid.

# Cranium — wide, flat-topped, merges with body, no neck gap
sphere('Cranium', (0.0, -1.38, 1.54), (0.86, 0.62, 0.48), fur, 24, 14)

# Muzzle — pulled back closer to cranium, smaller in X and Z so it doesn't
# dominate the front view, still protrudes forward in Y for side silhouette.
sphere('Muzzle', (0.0, -1.88, 1.38), (0.54, 0.46, 0.32), muz_m, 22, 12)

# Nose bridge — fills the seam between cranium and muzzle on top
sphere('NoseBridge', (0.0, -1.62, 1.58), (0.50, 0.32, 0.22), fur, 18, 10)

# ── NOSTRILS ──────────────────────────────────────────────────────────────────
# On the front face of the muzzle blob, not floating
for sx in (-0.16, 0.16):
    sphere('Nostril', (sx, -2.38, 1.46), (0.055, 0.032, 0.048), dark_m, 10, 8)

# ── EYES ──────────────────────────────────────────────────────────────────────
# Small eyes embedded in the cranium surface — slightly to the sides and up high.
for sx in (-0.50, 0.50):
    sphere('Eye', (sx, -1.40, 1.85), (0.065, 0.036, 0.058), dark_m, 14, 10)
    sphere('Shine', (sx * 0.88, -1.48, 1.91), (0.015, 0.007, 0.013),
           mat(f'Sh{sx}', (0.88, 0.88, 0.88), 0.05), 8, 6)

# ── EARS ──────────────────────────────────────────────────────────────────────
# Embedded in the cranium top — only the top third visible above skull.
# Close together, very flat (Y thin, Z ~= X).
for sx in (-0.44, 0.44):
    sphere('Ear',   (sx, -1.32, 1.96), (0.13, 0.06, 0.10), fur, 12, 8)
    sphere('EarIn', (sx, -1.36, 1.96), (0.065, 0.016, 0.055), muz_m, 10, 6)

# ── LEGS ──────────────────────────────────────────────────────────────────────
# Short but visible legs — upper bulge (thigh) + lower shin cylinder + hoof.
for sx in (-0.76, 0.76):
    # Front — thigh pushed up into body so no gap
    sphere('ThighF', (sx, -0.88, 0.76), (0.23, 0.21, 0.32), fur, 14, 10)
    sphere('ShinF',  (sx, -0.88, 0.42), (0.16, 0.16, 0.24), fur, 12, 8)
    box('HoofF',     (sx, -0.90, 0.18), (0.19, 0.22, 0.10), feet_m, 0.06)
    # Rear — haunches bigger, also pushed up
    sphere('ThighR', (sx,  0.72, 0.80), (0.26, 0.24, 0.34), fur, 14, 10)
    sphere('ShinR',  (sx,  0.72, 0.42), (0.17, 0.17, 0.24), fur, 12, 8)
    box('HoofR',     (sx,  0.74, 0.18), (0.21, 0.24, 0.10), feet_m, 0.06)

# ── TAIL ──────────────────────────────────────────────────────────────────────
sphere('Tail', (0.0, 1.52, 1.14), (0.10, 0.12, 0.09), fur_lt, 10, 6)

# ── LIGHTING ──────────────────────────────────────────────────────────────────
for name, loc, energy, size in [
    ('Key',  (-3.5, -5.0, 6.0), 650, 4.0),
    ('Fill', ( 4.0, -2.0, 3.5), 320, 3.0),
    ('Rim',  ( 0.0,  3.5, 4.5), 480, 2.5),
]:
    bpy.ops.object.light_add(type='AREA', location=loc)
    lt = bpy.context.object
    lt.name = name
    lt.data.energy = energy
    lt.data.shape = 'DISK'
    lt.data.size = size
    lt.rotation_euler = (Vector((0, 0, 1.45)) - lt.location).to_track_quat('-Z', 'Y').to_euler()

# ── CAMERA ────────────────────────────────────────────────────────────────────
bpy.ops.object.camera_add(location=(0.0, -8.2, 2.05))
cam = bpy.context.object
cam.data.lens = 58
cam.rotation_euler = (Vector((0, 0, 1.45)) - cam.location).to_track_quat('-Z', 'Y').to_euler()
bpy.context.scene.camera = cam

# ── RENDER / EXPORT ───────────────────────────────────────────────────────────
scene = bpy.context.scene
scene.render.engine = 'BLENDER_EEVEE'
scene.render.resolution_x = 512
scene.render.resolution_y = 512
scene.render.film_transparent = True
scene.world.color = (0.04, 0.025, 0.02)

bpy.ops.wm.save_as_mainfile(
    filepath='/Users/javierbritopacheco/codebase/capy-mascot/assets/capybara.blend'
)
bpy.ops.export_scene.gltf(filepath='/Users/javierbritopacheco/codebase/capy-mascot/assets/capybara.glb',
                           export_format='GLB', export_apply=True)
print('CAPYBARA_EXPORTED')
