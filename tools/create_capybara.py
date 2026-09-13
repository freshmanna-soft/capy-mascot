import bpy
import math
from mathutils import Vector

# Reset the default scene.
bpy.ops.object.select_all(action='SELECT')
bpy.ops.object.delete(use_global=False)


def material(name, color, roughness=0.82):
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    bsdf = mat.node_tree.nodes.get('Principled BSDF')
    bsdf.inputs['Base Color'].default_value = (*color, 1.0)
    bsdf.inputs['Roughness'].default_value = roughness
    return mat


# Capybara palette — warm brown rodent tones
fur       = material('Capy fur',       (0.38, 0.22, 0.11))   # dark warm brown
fur_belly = material('Capy belly',     (0.55, 0.38, 0.20))   # lighter underside
muzzle_m  = material('Muzzle',         (0.62, 0.46, 0.30))   # pinkish-tan muzzle
dark_m    = material('Dark',           (0.03, 0.018, 0.013), 0.35)  # eyes / nostrils
feet_m    = material('Feet',           (0.25, 0.12, 0.06))   # darker hooves


def uv(name, location, scale, mat, segments=20, rings=12):
    bpy.ops.mesh.primitive_uv_sphere_add(segments=segments, ring_count=rings, location=location)
    obj = bpy.context.object
    obj.name = name
    obj.scale = scale
    bpy.ops.object.transform_apply(scale=True)
    obj.data.materials.append(mat)
    bpy.ops.object.shade_smooth()
    return obj


def box(name, location, scale, mat, bevel=0.07):
    bpy.ops.mesh.primitive_cube_add(location=location)
    obj = bpy.context.object
    obj.name = name
    obj.scale = scale
    bpy.ops.object.transform_apply(scale=True)
    obj.data.materials.append(mat)
    mod = obj.modifiers.new('bevel', 'BEVEL')
    mod.width = bevel
    mod.segments = 3
    bpy.context.view_layer.objects.active = obj
    bpy.ops.object.modifier_apply(modifier=mod.name)
    bpy.ops.object.shade_smooth()
    return obj


# ── BODY ────────────────────────────────────────────────────────────────────
# Capybaras are barrel-shaped: very long, wide, and low to the ground.
# X = left/right width, Y = front/back depth, Z = height
body = uv('Body', (0.0, 0.0, 1.10), (1.10, 1.55, 0.72), fur, 24, 14)

# Belly patch — flattened sphere on the underside
uv('Belly', (0.0, 0.0, 0.55), (0.80, 1.10, 0.28), fur_belly, 20, 10)

# ── HEAD ─────────────────────────────────────────────────────────────────────
# Capybara head is the most distinctive feature:
# - Nearly as wide as the body
# - Very flat on top (no dome)
# - Enormous rectangular muzzle that makes up ~half the face height
# - Head sits directly on the body with almost no neck

# Braincase — flat-topped, wide
uv('Head', (0.0, -1.28, 1.72), (0.82, 0.58, 0.46), fur, 20, 12)

# The huge square muzzle — this is the key capybara feature.
# It's nearly as wide as the head and very deep (long in Y).
box('Muzzle', (0.0, -1.82, 1.42), (0.58, 0.44, 0.38), muzzle_m, 0.12)

# Upper lip ledge — capybaras have a prominent squared upper lip
box('Upper lip', (0.0, -2.22, 1.30), (0.52, 0.12, 0.14), muzzle_m, 0.06)

# ── NOSTRILS ──────────────────────────────────────────────────────────────────
# Wide-set, prominent nostrils on the flat face
for sx in (-0.20, 0.20):
    uv('Nostril', (sx, -2.20, 1.50), (0.075, 0.045, 0.055), dark_m, 12, 8)

# ── EYES ─────────────────────────────────────────────────────────────────────
# Capybara eyes are small, set high and far to the sides of the head,
# almost on top rather than on the front — a prey-animal eye position.
for sx in (-0.70, 0.70):
    uv('Eye', (sx, -1.18, 2.00), (0.075, 0.042, 0.068), dark_m, 16, 10)
    # White highlight dot
    uv('Eye shine', (sx - 0.02, -1.26, 2.06), (0.022, 0.010, 0.018),
       material(f'Shine{sx}', (0.9, 0.9, 0.9), 0.1), 8, 6)

# ── EARS ─────────────────────────────────────────────────────────────────────
# Capybara ears are small, round, and sit high on the very top of the head,
# widely spaced — not on the sides like a bear.
for sx in (-0.62, 0.62):
    uv('Ear', (sx, -1.15, 2.24), (0.15, 0.10, 0.17), fur, 14, 10)
    uv('Ear inner', (sx, -1.20, 2.24), (0.08, 0.025, 0.09), muzzle_m, 12, 8)

# ── LEGS ─────────────────────────────────────────────────────────────────────
# Short, stout legs — capybaras are semi-aquatic and low to the ground.
# Four legs: front pair and back pair, slight splay outward.
for sx in (-0.72, 0.72):
    # Front legs
    uv('Leg_FL' if sx < 0 else 'Leg_FR',
       (sx, -0.80, 0.52), (0.22, 0.20, 0.30), fur, 14, 10)
    box('Hoof_F' if sx < 0 else 'Hoof_FR',
        (sx, -0.80, 0.28), (0.20, 0.22, 0.10), feet_m, 0.05)
    # Rear legs
    uv('Leg_RL' if sx < 0 else 'Leg_RR',
       (sx, 0.72, 0.54), (0.24, 0.22, 0.32), fur, 14, 10)
    box('Hoof_R' if sx < 0 else 'Hoof_RR',
        (sx, 0.72, 0.28), (0.22, 0.24, 0.10), feet_m, 0.05)

# ── TAIL ─────────────────────────────────────────────────────────────────────
# Capybara tail is a tiny vestigial nub, almost invisible
uv('Tail', (0.0, 1.50, 1.18), (0.12, 0.15, 0.10), fur_belly, 10, 8)

# ── LIGHTING ─────────────────────────────────────────────────────────────────
for name, location, energy, size in [
    ('Key',  (-4.0, -5.0, 6.0), 700, 4.0),
    ('Fill', ( 4.0, -2.0, 3.5), 350, 3.0),
    ('Rim',  ( 0.0,  3.5, 4.5), 500, 2.5),
]:
    bpy.ops.object.light_add(type='AREA', location=location)
    light = bpy.context.object
    light.name = name
    light.data.energy = energy
    light.data.shape = 'DISK'
    light.data.size = size
    direction = Vector((0.0, 0.0, 1.45)) - light.location
    light.rotation_euler = direction.to_track_quat('-Z', 'Y').to_euler()

# ── CAMERA ───────────────────────────────────────────────────────────────────
bpy.ops.object.camera_add(location=(0.0, -8.2, 2.05))
camera = bpy.context.object
camera.data.lens = 58
camera.rotation_euler = (
    Vector((0.0, 0.0, 1.45)) - camera.location
).to_track_quat('-Z', 'Y').to_euler()
bpy.context.scene.camera = camera

# ── RENDER SETTINGS ──────────────────────────────────────────────────────────
scene = bpy.context.scene
scene.render.engine = 'BLENDER_EEVEE'
scene.render.resolution_x = 512
scene.render.resolution_y = 512
scene.render.resolution_percentage = 100
scene.render.film_transparent = True
scene.world.color = (0.04, 0.025, 0.02)

# ── EXPORT ───────────────────────────────────────────────────────────────────
output = '/Users/javierbritopacheco/codebase/capy-mascot/assets/capybara.glb'
bpy.ops.wm.save_as_mainfile(
    filepath='/Users/javierbritopacheco/codebase/capy-mascot/assets/capybara.blend'
)
bpy.ops.export_scene.gltf(
    filepath=output,
    export_format='GLB',
    export_apply=True,
)
print('CAPYBARA_EXPORTED', output)
